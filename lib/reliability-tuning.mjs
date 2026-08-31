import { GOAL_LABELS, predictGoals } from "./predictor.mjs";
import { applyZeroCellFloor } from "./smoothing.mjs";
import { selectThreeWaySimilarity } from "./three-way-matching.mjs";
import { buildCoherentThreeWayDistribution } from "./three-way-coherence.mjs";

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

function dominantSource(rows) {
  const counts = new Map();
  for (const row of rows) {
    counts.set(row.sourceFile, (counts.get(row.sourceFile) || 0) + 1);
  }
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1],
  )[0];
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
  if (samples.every((sample) => sample.coherentJoint)) {
    const coherent = buildCoherentThreeWayDistribution(samples, {
      handicap: samples[0].jointHandicap,
    });
    return coherent.available ? coherent[market].probabilities : null;
  }
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
  const [sourceFile, sourceRows] = dominantSource(events);
  const rows = events
    .filter((row) => row.sourceFile === sourceFile)
    .sort((left, right) => left.sourceRow - right.sourceRow);
  const history = { spfHistory: [], hhadHistory: [], pairedHistory: [] };
  const observations = [];

  for (let index = 0; index < rows.length; index += 1) {
    const target = rows[index];
    if (index >= warmup && target[market]) {
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
        sourceFile,
        order: target.sourceRow,
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
        });
      }
    }
    if (target.spf) history.spfHistory.push(target.spf);
    if (target.hhad) history.hhadHistory.push(target.hhad);
    if (target.pair) history.pairedHistory.push(target.pair);
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
  return {
    targets: segment.length,
    available: available.length,
    modelCoverage: segment.length ? available.length / segment.length : 0,
    selected: selected.length,
    coverage: available.length ? selected.length / available.length : 0,
    baselineAccuracy,
    selectedAccuracy,
    accuracyLift: selectedAccuracy - baselineAccuracy,
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
  } = {},
) {
  const safe = observations.filter((row) => Number.isFinite(row.correct));
  const trainEnd = Math.floor(safe.length * trainFraction);
  const calibrationEnd = Math.floor(
    safe.length * (trainFraction + calibrationFraction),
  );
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
  const reason = testPassed
    ? "训练段选出的规则在中间20%和最新20%均提高命中率，且连续区块Bootstrap的95%下界不低于0"
    : !calibrationPassed
      ? "训练段筛选规则未能在中间20%稳定复现，本玩法不标记“重点参考”"
      : "规则通过中间20%验证，但未通过最新20%最终门禁，本玩法不标记“重点参考”";
  return {
    enabled: testPassed,
    rule: best.rule,
    train: best.train,
    calibration,
    calibrationSignificance,
    test,
    testSignificance,
    gate: {
      passed: testPassed,
      calibrationPassed,
      testPassed,
      minimumTrainLift,
      minimumCalibrationLift,
      minimumTestLift,
      reason,
    },
  };
}
