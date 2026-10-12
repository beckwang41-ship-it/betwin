import { GOAL_LABELS, predictGoals } from "./predictor.mjs";
import { applyZeroCellFloor } from "./smoothing.mjs";
import { selectThreeWaySimilarity } from "./three-way-matching.mjs";
import { historySteps, batchBoundary } from "./history-timeline.mjs";

export const RELIABILITY_STABILITY_THRESHOLDS = Object.freeze({
  spf: [0.03, 0.05, 0.07, 0.1],
  hhad: [0.03, 0.05, 0.07, 0.1],
});

const THREE_WAY_LABELS = ["胜", "平", "负"];

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

// 所选方向的去水市场概率。并列时与 correct 的 1/k 计分一致，取并列项均值。
// 赔率缺失或非法时返回 null：没有市场基准就无法证明相对市场的增量。
export function selectedMarketProbability(odds, indices) {
  const safe = Array.isArray(odds) ? odds.map(Number) : [];
  if (!safe.length || !safe.every((odd) => Number.isFinite(odd) && odd > 1)) {
    return null;
  }
  if (!Array.isArray(indices) || !indices.length) return null;
  const inverse = safe.map((odd) => 1 / odd);
  const total = inverse.reduce((sum, value) => sum + value, 0);
  return mean(indices.map((index) => inverse[index] / total));
}

function topProbabilityView(probabilities) {
  if (!Array.isArray(probabilities) || !probabilities.length) return null;
  const highest = Math.max(...probabilities);
  const indices = probabilities
    .map((value, index) => ({ value: Number(value), index }))
    .filter(({ value }) => Math.abs(value - highest) < 1e-12)
    .map(({ index }) => index);
  const competitors = probabilities.filter(
    (_, index) => !indices.includes(index),
  );
  return {
    highest,
    indices,
    margin: highest - Math.max(0, ...competitors),
  };
}

function threeWayMatchFromEvent(event) {
  return {
    league: event.league,
    had: event.spf
      ? {
          h: event.spf.odds[0],
          d: event.spf.odds[1],
          a: event.spf.odds[2],
        }
      : null,
    hhad: event.hhad
      ? {
          h: event.hhad.odds[0],
          d: event.hhad.odds[1],
          a: event.hhad.odds[2],
          goalLine: event.hhad.handicap,
        }
      : null,
  };
}

function threeWayProbabilities(samples, market) {
  if (!samples.length) return null;
  const counts = THREE_WAY_LABELS.map(() => 0);
  for (const sample of samples) {
    const index = THREE_WAY_LABELS.indexOf(String(sample.result));
    if (index >= 0) counts[index] += 1;
  }
  const total = counts.reduce((sum, value) => sum + value, 0);
  return total ? applyZeroCellFloor(counts).probabilities : null;
}

/**
 * 构建可靠性训练与投注报告共用的三项盘时间滚动观测。
 * 返回数组保留无样本目标，确保 60/20/20 的时间边界不会因过滤而漂移。
 */
export function buildThreeWayReliabilityObservations(
  events,
  market,
  thresholds,
  {
    warmup = 500,
    stabilityThresholds = RELIABILITY_STABILITY_THRESHOLDS,
  } = {},
) {
  const sourceFile = "database-timeline", sourceRows = events.length;
  let history, previousHistory, added = 0;
  const observations = [];

  for (const { target, history: prior } of historySteps(events)) {
    if (previousHistory !== prior) {
      history = { spfHistory: [], hhadHistory: [], pairedHistory: [] };
      previousHistory = prior;
      added = 0;
    }
    while (added < prior.length) {
      const row = prior[added++];
      if (row.spf) history.spfHistory.push(row.spf);
      if (row.hhad) history.hhadHistory.push(row.hhad);
      if (row.pair) history.pairedHistory.push(row.pair);
    }
    if (prior.length >= warmup && target[market]) {
      const selections = new Map();
      for (const threshold of stabilityThresholds[market]) {
        const result = selectThreeWaySimilarity(
          threeWayMatchFromEvent(target),
          history,
          {
            spfTolerance:
              market === "spf" ? threshold : thresholds.spf,
            hhadTolerance:
              market === "hhad" ? threshold : thresholds.hhad,
          },
        );
        selections.set(threshold, result[market]?.similar || []);
      }
      const production = selections.get(thresholds[market]) || [];
      const values = threeWayProbabilities(production, market);
      const top = topProbabilityView(values);
      const actualIndex = THREE_WAY_LABELS.indexOf(
        String(target[market].result),
      );
      const common = {
        sourceFile: target.sourceFile,
        order: observations.length,
        historyBatchId: target.historyBatchId || 0,
        odds: target[market].odds.map(Number),
        actualIndex,
        probabilities: values,
      };
      if (!top) {
        observations.push({
          ...common,
          available: false,
          samples: 0,
          topProbability: 0,
          margin: 0,
          stable: false,
          consensus: 0,
          correct: 0,
        });
      } else {
        const selectedIndex = top.indices.length === 1 ? top.indices[0] : -1;
        const support = [...selections.values()].filter((samples) => {
          const pointTop = topProbabilityView(
            threeWayProbabilities(samples, market),
          );
          return (
            pointTop?.indices.length === 1 &&
            pointTop.indices[0] === selectedIndex
          );
        }).length;
        observations.push({
          ...common,
          available: true,
          samples: production.length,
          topProbability: top.highest,
          margin: top.margin,
          stable: selectedIndex >= 0 && support === selections.size,
          consensus: selections.size ? support / selections.size : 0,
          correct: top.indices.includes(actualIndex)
            ? 1 / top.indices.length
            : 0,
          marketProbability: selectedMarketProbability(
            common.odds,
            top.indices,
          ),
        });
      }
    }
  }
  return { sourceFile, sourceRows, observations };
}

function unavailableGoalObservation() {
  return {
    available: false,
    samples: 0,
    topProbability: 0,
    margin: 0,
    stable: false,
    consensus: 0,
    correct: 0,
  };
}

export function buildGoalReliabilityObservation(
  target,
  similar,
  {
    fractions = [0.25, 0.5, 0.75, 1],
    bandwidth = 1,
    weightingMethod = "exponential-composite-distance",
  } = {},
) {
  const rows = Array.isArray(similar) ? similar : [];
  const predictions = fractions.map((fraction) => {
    const sampleSize = rows.length
      ? Math.max(1, Math.ceil(rows.length * Number(fraction)))
      : 0;
    return predictGoals(target?.odds || [], rows.slice(0, sampleSize), {
      empiricalOnly: true,
      requireSamples: true,
      weighting: {
        enabled: true,
        weightField: "similarityWeight",
        method: weightingMethod,
        tolerance: bandwidth,
        floor: 0.01,
        power: 1,
        coreRatio: 0.5,
      },
    });
  });
  const production = predictions.at(-1);
  const values = production?.weightedEmpirical;
  const top = production?.available ? topProbabilityView(values) : null;
  if (!top) return unavailableGoalObservation();

  const selectedIndex = top.indices.length === 1 ? top.indices[0] : -1;
  const support = predictions.filter((prediction) => {
    const pointTop = prediction.available
      ? topProbabilityView(prediction.weightedEmpirical)
      : null;
    return (
      pointTop?.indices.length === 1 && pointTop.indices[0] === selectedIndex
    );
  }).length;
  const actualIndex = GOAL_LABELS.indexOf(String(target?.goals));
  return {
    available: true,
    samples: Number(production.stats?.total || 0),
    topProbability: top.highest,
    margin: top.margin,
    stable: selectedIndex >= 0 && support === predictions.length,
    consensus: predictions.length ? support / predictions.length : 0,
    correct: top.indices.includes(actualIndex) ? 1 / top.indices.length : 0,
    marketProbability: selectedMarketProbability(target?.odds, top.indices),
  };
}

function percentile(values, probability) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const ratio = position - lower;
  return sorted[lower] * (1 - ratio) + sorted[upper] * ratio;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function quantileCandidates(values) {
  if (!values.length) return [];
  return [...new Set(
    [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((probability) =>
      Number(percentile(values, probability).toFixed(10)),
    ),
  )].sort((left, right) => left - right);
}

export function reliabilityRuleMatches(observation, rule) {
  return Boolean(
    observation.available &&
      observation.samples >= rule.minSamples &&
      observation.topProbability >= rule.minTopProbability &&
      observation.margin >= rule.minMargin &&
      observation.consensus >= rule.minConsensus &&
      (!rule.requireStable || observation.stable)
  );
}

function segmentMetrics(observations, rule, start, end) {
  const segment = observations.slice(start, end);
  const available = segment.filter((row) => row.available);
  const selected = available.filter((row) =>
    reliabilityRuleMatches(row, rule),
  );
  const baselineAccuracy = mean(available.map((row) => row.correct));
  const selectedAccuracy = mean(selected.map((row) => row.correct));
  const priced = selected.filter((row) => Number.isFinite(row.marketProbability));
  // 市场增量：筛出场次的实际命中率 − 同批场次所选方向的去水市场概率。
  // 只比"命中率高于全体"会把"挑市场热门"误当成模型能力；这里要求比市场本身更准。
  const selectedMarketProbability = priced.length
    ? mean(priced.map((row) => row.marketProbability))
    : null;
  const marketEdge = priced.length
    ? mean(priced.map((row) => row.correct - row.marketProbability))
    : null;
  return {
    targets: segment.length,
    available: available.length,
    modelCoverage: segment.length ? available.length / segment.length : 0,
    selected: selected.length,
    coverage: available.length ? selected.length / available.length : 0,
    baselineAccuracy,
    selectedAccuracy,
    accuracyLift: selectedAccuracy - baselineAccuracy,
    selectedMarketProbability,
    marketEdge,
  };
}

// 市场增量的区块 Bootstrap：同一筛选规则下 (命中 − 市场概率) 的均值区间。
function marketEdgeBootstrap(
  observations,
  rule,
  start,
  end,
  { iterations = 1000, blockSize = 20, seed = 20260929 } = {},
) {
  const segment = observations.slice(start, end);
  const random = mulberry32(seed + start + end);
  const values = [];
  for (let iteration = 0; iteration < iterations && segment.length; iteration += 1) {
    const sampled = [];
    while (sampled.length < segment.length) {
      const blockStart = Math.floor(random() * segment.length);
      const take = Math.min(blockSize, segment.length - sampled.length);
      for (let offset = 0; offset < take; offset += 1) {
        sampled.push(segment[(blockStart + offset) % segment.length]);
      }
    }
    const edges = sampled
      .filter((row) => reliabilityRuleMatches(row, rule))
      .filter((row) => Number.isFinite(row.marketProbability))
      .map((row) => row.correct - row.marketProbability);
    if (edges.length) values.push(mean(edges));
  }
  return {
    iterations: values.length,
    blockSize,
    confidence: 0.95,
    marketEdge: values.length
      ? { lower: percentile(values, 0.025), upper: percentile(values, 0.975) }
      : null,
  };
}

function selectionBootstrap(
  observations,
  rule,
  start,
  end,
  { iterations = 1000, blockSize = 20, seed = 20260727 } = {},
) {
  const segment = observations.slice(start, end);
  if (!segment.length) {
    return {
      iterations: 0,
      blockSize,
      confidence: 0.95,
      accuracyLift: { lower: 0, upper: 0 },
    };
  }
  const random = mulberry32(seed + start + end);
  const deltas = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampled = [];
    while (sampled.length < segment.length) {
      const blockStart = Math.floor(random() * segment.length);
      const take = Math.min(blockSize, segment.length - sampled.length);
      for (let offset = 0; offset < take; offset += 1) {
        sampled.push(segment[(blockStart + offset) % segment.length]);
      }
    }
    const available = sampled.filter((row) => row.available);
    const selected = available.filter((row) =>
      reliabilityRuleMatches(row, rule),
    );
    if (!available.length || !selected.length) continue;
    deltas.push(
      mean(selected.map((row) => row.correct)) -
        mean(available.map((row) => row.correct)),
    );
  }
  return {
    iterations: deltas.length,
    blockSize,
    confidence: 0.95,
    accuracyLift: {
      lower: percentile(deltas, 0.025),
      upper: percentile(deltas, 0.975),
    },
  };
}

export function tuneReliabilityPolicy(
  observations,
  {
    threshold,
    trainFraction = 0.6,
    calibrationFraction = 0.2,
    minimumTrainSelected = 300,
    minimumValidationSelected = 100,
    minimumTrainLift = 0.03,
    minimumCalibrationLift = 0.03,
    minimumTestLift = 0.02,
    // v2：命中率提升之外，筛出场次还必须在中间与最新两段都比去水市场概率更准
    // （点估计 > 0 且区块 Bootstrap 下界 ≥ 0）。设为 false 可复现 v1 旧门禁。
    requireMarketEdge = true,
  } = {},
) {
  const safe = observations.filter((row) => Number.isFinite(row.correct));
  const trainEnd = batchBoundary(safe, Math.floor(safe.length * trainFraction));
  const calibrationEnd = batchBoundary(safe, Math.floor(
    safe.length * (trainFraction + calibrationFraction),
  ));
  const training = safe.slice(0, trainEnd).filter((row) => row.available);
  if (!training.length) throw new Error("没有可用于可靠性训练的历史预测");
  const sampleCandidates = quantileCandidates(
    training.map((row) => row.samples),
  );
  const topCandidates = quantileCandidates(
    training.map((row) => row.topProbability),
  );
  const marginCandidates = quantileCandidates(
    training.map((row) => row.margin),
  );
  let best = null;
  for (const minSamples of sampleCandidates) {
    for (const minTopProbability of topCandidates) {
      for (const minMargin of marginCandidates) {
        for (const requireStable of [false, true]) {
          for (const minConsensus of [0, 0.75, 1]) {
            const rule = {
              threshold,
              minSamples: Math.ceil(minSamples),
              minTopProbability,
              minMargin,
              requireStable,
              minConsensus,
            };
            const train = segmentMetrics(safe, rule, 0, trainEnd);
            if (
              train.selected < minimumTrainSelected ||
              train.coverage < 0.12 ||
              train.coverage > 0.65
            ) {
              continue;
            }
            const candidate = { rule, train };
            if (
              !best ||
              train.accuracyLift > best.train.accuracyLift ||
              (train.accuracyLift === best.train.accuracyLift &&
                train.selectedAccuracy > best.train.selectedAccuracy) ||
              (train.accuracyLift === best.train.accuracyLift &&
                train.selectedAccuracy === best.train.selectedAccuracy &&
                train.coverage > best.train.coverage)
            ) {
              best = candidate;
            }
          }
        }
      }
    }
  }
  if (!best) throw new Error("没有满足覆盖率约束的可靠性规则");
  const calibration = segmentMetrics(
    safe,
    best.rule,
    trainEnd,
    calibrationEnd,
  );
  const calibrationSignificance = selectionBootstrap(
    safe,
    best.rule,
    trainEnd,
    calibrationEnd,
  );
  const calibrationPassed = Boolean(
    best.train.accuracyLift >= minimumTrainLift &&
      calibration.selected >= minimumValidationSelected &&
      calibration.coverage >= 0.08 &&
      calibration.accuracyLift >= minimumCalibrationLift &&
      calibrationSignificance.accuracyLift.lower >= 0
  );
  const test = segmentMetrics(
    safe,
    best.rule,
    calibrationEnd,
    safe.length,
  );
  const testSignificance = selectionBootstrap(
    safe,
    best.rule,
    calibrationEnd,
    safe.length,
  );
  const testPassed = Boolean(
    calibrationPassed &&
      test.selected >= minimumValidationSelected &&
      test.coverage >= 0.08 &&
      test.accuracyLift >= minimumTestLift &&
      testSignificance.accuracyLift.lower >= 0
  );
  const calibrationMarket = marketEdgeBootstrap(
    safe,
    best.rule,
    trainEnd,
    calibrationEnd,
  );
  const testMarket = marketEdgeBootstrap(
    safe,
    best.rule,
    calibrationEnd,
    safe.length,
  );
  const edgePassed = (metrics, significance) =>
    Number.isFinite(metrics.marketEdge) &&
    metrics.marketEdge > 0 &&
    Number.isFinite(significance.marketEdge?.lower) &&
    significance.marketEdge.lower >= 0;
  const marketEdgePassed =
    edgePassed(calibration, calibrationMarket) && edgePassed(test, testMarket);
  const passed = testPassed && (!requireMarketEdge || marketEdgePassed);
  const reason = passed
    ? requireMarketEdge
      ? "规则在中间20%和最新20%均提高命中率，且筛出场次的实际命中率稳定高于去水市场概率"
      : "训练段选出的规则在中间20%和最新20%均提高命中率，且连续区块Bootstrap的95%下界不低于0"
    : !calibrationPassed
      ? "训练段筛选规则未能在中间20%稳定复现，本玩法不标记“重点参考”"
      : !testPassed
        ? "规则通过中间20%验证，但未通过最新20%最终门禁，本玩法不标记“重点参考”"
        : "规则挑出的比赛命中率更高，但没有比赔率隐含概率更准（只是挑中了市场热门），本玩法不标记“重点参考”";
  return {
    enabled: passed,
    rule: best.rule,
    train: best.train,
    calibration,
    calibrationSignificance,
    calibrationMarketSignificance: calibrationMarket,
    test,
    testSignificance,
    testMarketSignificance: testMarket,
    gate: {
      passed,
      calibrationPassed,
      testPassed,
      marketEdgePassed,
      requireMarketEdge,
      minimumTrainLift,
      minimumCalibrationLift,
      minimumTestLift,
      reason,
    },
  };
}
