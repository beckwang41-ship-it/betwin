import {
  blockBootstrapComparison,
  classificationDelta,
} from "./significance.mjs";
import {
  applyZeroCellFloor,
  selectHistoricalPrior,
  smoothHistoricalDistribution,
} from "./smoothing.mjs";

function groupBySource(rows) {
  const groups = new Map();
  for (const row of rows) {
    const source = row.sourceFile || "unknown";
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push(row);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.sourceRow - right.sourceRow);
  }
  return groups;
}

function accumulator() {
  return {
    targets: 0,
    evaluated: 0,
    correct: 0,
    logLoss: 0,
    brier: 0,
    sampleSizes: [],
    calibrationCases: [],
  };
}

function topScore(probabilities, actualIndex) {
  const highest = Math.max(...probabilities);
  const top = probabilities
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => Math.abs(value - highest) < 1e-12);
  return top.some(({ index }) => index === actualIndex) ? 1 / top.length : 0;
}

function addCase(target, probabilities, actualIndex, sampleSize) {
  const confidence = Math.max(...probabilities);
  const score = topScore(probabilities, actualIndex);
  target.evaluated += 1;
  target.correct += score;
  target.logLoss -= Math.log(Math.max(1e-12, probabilities[actualIndex]));
  target.brier += probabilities.reduce((sum, probability, index) => {
    const actual = index === actualIndex ? 1 : 0;
    return sum + (probability - actual) ** 2;
  }, 0);
  target.sampleSizes.push(sampleSize);
  target.calibrationCases.push({ confidence, score });
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function calibrationSummary(cases, { bins = 10, minBinSamples = 30 } = {}) {
  const definitions = Array.from({ length: bins }, (_, index) => ({
    from: index / bins,
    to: (index + 1) / bins,
    count: 0,
    confidence: 0,
    score: 0,
  }));
  for (const item of cases) {
    const index = Math.min(
      bins - 1,
      Math.max(0, Math.floor(Number(item.confidence) * bins)),
    );
    const bucket = definitions[index];
    bucket.count += 1;
    bucket.confidence += Number(item.confidence);
    bucket.score += Number(item.score);
  }
  let expectedCalibrationError = 0;
  let maximumCalibrationError = null;
  const summarizedBins = definitions.map((bucket) => {
    const predictedAverage = bucket.count
      ? bucket.confidence / bucket.count
      : null;
    const actualAccuracy = bucket.count ? bucket.score / bucket.count : null;
    const absoluteGap = bucket.count
      ? Math.abs(predictedAverage - actualAccuracy)
      : null;
    if (bucket.count) {
      expectedCalibrationError +=
        (bucket.count / Math.max(1, cases.length)) * absoluteGap;
    }
    if (bucket.count >= minBinSamples) {
      maximumCalibrationError = Math.max(
        maximumCalibrationError || 0,
        absoluteGap,
      );
    }
    return {
      from: bucket.from,
      to: bucket.to,
      count: bucket.count,
      predictedAverage,
      actualAccuracy,
      gap:
        predictedAverage === null ? null : actualAccuracy - predictedAverage,
    };
  });
  const highConfidence = cases.filter((item) => item.confidence >= 0.75);
  const highPredicted = highConfidence.length
    ? highConfidence.reduce((sum, item) => sum + item.confidence, 0) /
      highConfidence.length
    : null;
  const highActual = highConfidence.length
    ? highConfidence.reduce((sum, item) => sum + item.score, 0) /
      highConfidence.length
    : null;
  const highObservedGap =
    highPredicted === null ? null : Math.abs(highActual - highPredicted);
  return {
    bins: summarizedBins,
    expectedCalibrationError,
    maximumCalibrationError,
    highConfidence: {
      threshold: 0.75,
      count: highConfidence.length,
      predictedAverage: highPredicted,
      actualAccuracy: highActual,
      observedAbsoluteGap: highObservedGap,
      absoluteGap:
        highConfidence.length >= minBinSamples ? highObservedGap : null,
    },
  };
}

function summarize(value) {
  return {
    targets: value.targets,
    evaluated: value.evaluated,
    accuracy: value.evaluated ? value.correct / value.evaluated : 0,
    logLoss: value.evaluated ? value.logLoss / value.evaluated : 0,
    brier: value.evaluated ? value.brier / value.evaluated : 0,
    coverage: value.targets ? value.evaluated / value.targets : 0,
    medianSamples: median(value.sampleSizes),
    calibration: calibrationSummary(value.calibrationCases),
  };
}

function metricDelta(candidate, baseline) {
  return candidate === null || baseline === null
    ? null
    : candidate - baseline;
}

export function assessHighConfidenceCalibration(
  candidate = {},
  baseline = {},
  { epsilon = 1e-10 } = {},
) {
  const baselineGap = baseline.absoluteGap === null || baseline.absoluteGap === undefined
    ? null
    : Number(baseline.absoluteGap);
  if (!Number.isFinite(baselineGap)) {
    return {
      passed: true,
      status: "baseline-insufficient",
      delta: null,
    };
  }

  const candidateCount = Math.max(0, Number(candidate.count) || 0);
  const candidateGap = candidate.absoluteGap === null || candidate.absoluteGap === undefined
    ? null
    : Number(candidate.absoluteGap);
  if (candidateCount === 0 && !Number.isFinite(candidateGap)) {
    return {
      passed: true,
      status: "no-candidate-claims",
      delta: -baselineGap,
    };
  }
  if (!Number.isFinite(candidateGap)) {
    return {
      passed: false,
      status: "candidate-insufficient",
      delta: null,
    };
  }

  const delta = candidateGap - baselineGap;
  return {
    passed: delta <= epsilon,
    status: delta <= epsilon ? "non-regressing" : "regressing",
    delta,
  };
}

function comparison(candidate, baseline) {
  const highConfidenceGuard = assessHighConfidenceCalibration(
    candidate.calibration.highConfidence,
    baseline.calibration.highConfidence,
  );
  return {
    evaluated: candidate.evaluated,
    candidate,
    baseline,
    delta: {
      accuracy: candidate.accuracy - baseline.accuracy,
      logLoss: candidate.logLoss - baseline.logLoss,
      brier: candidate.brier - baseline.brier,
      expectedCalibrationError:
        candidate.calibration.expectedCalibrationError -
        baseline.calibration.expectedCalibrationError,
      maximumCalibrationError: metricDelta(
        candidate.calibration.maximumCalibrationError,
        baseline.calibration.maximumCalibrationError,
      ),
      highConfidenceGap: highConfidenceGuard.delta,
    },
    highConfidenceGuard,
  };
}

function calibrationImproves(value) {
  const epsilon = 1e-10;
  const nonRegressing = (delta) => delta === null || delta <= epsilon;
  return (
    value.delta.expectedCalibrationError < -epsilon &&
    nonRegressing(value.delta.maximumCalibrationError) &&
    value.highConfidenceGuard?.passed === true
  );
}

function improves(value) {
  const epsilon = 1e-10;
  return (
    value?.evaluated > 0 &&
    value.delta.logLoss < -epsilon &&
    value.delta.brier < -epsilon &&
    value.delta.accuracy >= -epsilon &&
    calibrationImproves(value)
  );
}

function better(left, right) {
  if (!right) return true;
  if (Math.abs(left.delta.logLoss - right.delta.logLoss) > 1e-10) {
    return left.delta.logLoss < right.delta.logLoss;
  }
  if (Math.abs(left.delta.brier - right.delta.brier) > 1e-10) {
    return left.delta.brier < right.delta.brier;
  }
  if (Math.abs(left.delta.accuracy - right.delta.accuracy) > 1e-10) {
    return left.delta.accuracy > right.delta.accuracy;
  }
  return left.strength < right.strength;
}

function outcomeCounts(rows, labels, outcomeField) {
  const counts = labels.map(() => 0);
  for (const row of rows) {
    const index = labels.indexOf(String(row[outcomeField]));
    if (index >= 0) counts[index] += 1;
  }
  return counts;
}

function rawDistribution(rows, labels, outcomeField) {
  const counts = outcomeCounts(rows, labels, outcomeField);
  return counts.map((count) => count / rows.length);
}

// empiricalResolver 可以只返回概率数组；需要复用生产加权计数时，也可以
// 返回 { probabilities, counts }。显式 counts 优先，避免用原始场次数把加权
// 概率还原成错误的伪计数。
export function floorEmpiricalDistribution(
  empirical,
  fallbackSampleSize,
  options = {},
) {
  const probabilities = Array.isArray(empirical)
    ? empirical
    : empirical?.probabilities;
  if (!Array.isArray(probabilities) || !probabilities.length) return [];
  const explicitCounts = Array.isArray(empirical?.counts)
    && empirical.counts.length === probabilities.length
    ? empirical.counts.map((value) => Math.max(0, Number(value) || 0))
    : null;
  const total = Math.max(0, Number(fallbackSampleSize) || 0);
  const counts = explicitCounts || probabilities.map(
    (value) => Math.max(0, Number(value) || 0) * total,
  );
  if (!counts.some((value) => value > 0)) return probabilities;
  const result = applyZeroCellFloor(
    counts,
    options,
  );
  return result.applied ? result.probabilities : probabilities;
}

export function tuneHistoricalSmoothing(
  rows,
  {
    labels,
    outcomeField,
    distance,
    threshold,
    sampleResolver = null,
    empiricalResolver = null,
    priorResolver = null,
    strengths = [1, 2, 3, 5, 8, 12, 20],
    compatible = () => true,
    warmup = 500,
    validationFraction = 0.2,
    relaxedMultiplier = 2,
    minLocalizedSamples = 30,
    // 默认严格要求命中率95%区间下界不低于0。若以后允许非劣界限，必须
    // 由预先确定的业务容忍度传入，不能依据Bootstrap随机种子波动倒推。
    accuracyMargin = 0,
    // 防零层参数，透传给 applyZeroCellFloor。传 false 可关闭（仅用于
    // 对照实验），生产调参不应关闭——基线口径必须与 predictSpf 一致。
    zeroCellFloor = null,
  },
) {
  const candidates = [...new Set(strengths)]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right)
    .map((strength) => ({
      strength,
      tuning: accumulator(),
      validation: accumulator(),
      validationDeltas: [],
    }));
  const baseline = {
    tuning: accumulator(),
    validation: accumulator(),
  };
  const sources = [];

  for (const [sourceFile, group] of groupBySource(rows)) {
    const validationStart = Math.max(
      warmup + 1,
      Math.floor(group.length * (1 - validationFraction)),
    );
    let tuningCases = 0;
    let validationCases = 0;

    for (let targetIndex = warmup; targetIndex < group.length; targetIndex += 1) {
      const target = group[targetIndex];
      const actualIndex = labels.indexOf(String(target[outcomeField]));
      if (actualIndex < 0) continue;
      const bucket =
        targetIndex >= validationStart ? "validation" : "tuning";
      baseline[bucket].targets += 1;
      for (const candidate of candidates) candidate[bucket].targets += 1;

      const history = group.slice(0, targetIndex);
      const similar = (sampleResolver
        ? sampleResolver(target, history)
        : history.filter(
            (row) =>
              compatible(row, target) &&
              distance(row, target) <= threshold,
          )
      ).filter((row) => labels.includes(String(row[outcomeField])));
      if (!similar.length) continue;
      // 基线必须与生产口径一致：predictSpf/predictGoals 已无条件套用
      // 防零层，所以这里的对照组也要防零。否则门禁会把「防零带来的
      // 改善」错记在生产平滑账上——实测 LogLoss 增量因此虚高 26 倍
      // （-0.3327 vs -0.0127），见 scripts/test_floor_vs_gate.mjs。
      const empirical = empiricalResolver
        ? empiricalResolver(similar, target, history)
        : rawDistribution(similar, labels, outcomeField);
      const rawUnfloored = Array.isArray(empirical)
        ? empirical
        : empirical?.probabilities;
      if (!Array.isArray(rawUnfloored) || rawUnfloored.length !== labels.length) {
        continue;
      }
      const raw = zeroCellFloor === false
        ? rawUnfloored
        : floorEmpiricalDistribution(
            empirical,
            similar.length,
            zeroCellFloor || {},
          );
      const prior = priorResolver
        ? priorResolver(history, target, {
            labels,
            outcomeField,
            threshold,
            relaxedMultiplier,
            minLocalizedSamples,
          })
        : selectHistoricalPrior(history, target, {
            labels,
            outcomeField,
            distance,
            compatible,
            relaxedTolerance: threshold * relaxedMultiplier,
            minLocalizedSamples,
          });
      addCase(baseline[bucket], raw, actualIndex, similar.length);

      for (const candidate of candidates) {
        const stable = smoothHistoricalDistribution(raw, similar.length, {
          enabled: true,
          validated: true,
          strength: candidate.strength,
          prior,
        }).probabilities;
        addCase(candidate[bucket], stable, actualIndex, similar.length);
        if (bucket === "validation") {
          candidate.validationDeltas.push(
            classificationDelta(stable, raw, actualIndex, {
              sourceFile,
              order: target.sourceRow,
            }),
          );
        }
      }

      if (bucket === "validation") validationCases += 1;
      else tuningCases += 1;
    }
    sources.push({
      sourceFile,
      rows: group.length,
      warmup: Math.min(group.length, warmup),
      tuningCases,
      validationCases,
    });
  }

  const baselineSummary = {
    tuning: summarize(baseline.tuning),
    validation: summarize(baseline.validation),
  };
  const results = candidates.map((candidate) => {
    const tuning = summarize(candidate.tuning);
    const validation = summarize(candidate.validation);
    return {
      strength: candidate.strength,
      tuning,
      validation,
      tuningComparison: comparison(tuning, baselineSummary.tuning),
      validationComparison: comparison(
        validation,
        baselineSummary.validation,
      ),
    };
  });

  let selected = null;
  for (const candidate of results.filter((item) =>
    improves(item.tuningComparison),
  )) {
    const ranked = {
      strength: candidate.strength,
      ...candidate.tuningComparison,
    };
    if (better(ranked, selected)) selected = ranked;
  }
  const reference =
    (selected &&
      results.find((item) => item.strength === selected.strength)) ||
    [...results].sort(
      (left, right) =>
        left.tuningComparison.delta.logLoss -
          right.tuningComparison.delta.logLoss ||
        left.strength - right.strength,
    )[0];
  const tuningPassed = Boolean(selected);
  const validationPassed =
    tuningPassed && improves(reference.validationComparison);
  const selectedInternal = candidates.find(
    (candidate) => candidate.strength === reference.strength,
  );
  const significance =
    validationPassed && selectedInternal
      ? blockBootstrapComparison(selectedInternal.validationDeltas, {
          accuracyMargin,
        })
      : {
          passed: false,
          status: "not-run",
          reason: "基础指标门禁未通过，未运行显著性检验",
          iterations: 0,
          blockSize: 20,
          confidence: 0.95,
          evaluated: 0,
          accuracyMargin,
          metrics: null,
        };
  const passed =
    tuningPassed && validationPassed && Boolean(significance.passed);

  return {
    threshold,
    relaxedTolerance: threshold * relaxedMultiplier,
    minLocalizedSamples,
    candidateStrength: reference.strength,
    // 离线调参只产出「候选强度」。生产强度恒为 0，只能由
    // data/smoothing-production.json 的人工批准流程写入
    // （见 lib/smoothing-production.mjs）。这里保持 0 避免调参
    // 结果被误读为已上线。
    strength: 0,
    changed: false,
    candidateChanged: passed,
    selected: {
      ...reference,
      significance,
    },
    baseline: baselineSummary,
    candidates: results,
    production: {
      // 同上：调参层不具备上线权限，enabled/strength 恒为关闭态。
      enabled: false,
      strength: 0,
      candidatePassed: passed,
      candidateStrength: reference.strength,
      referenceStrength: reference.strength,
      relaxedMultiplier,
      minLocalizedSamples,
    },
    gate: {
      passed,
      tuningPassed,
      validationPassed,
      significancePassed: Boolean(significance.passed),
      accuracyMargin,
      reason: passed
        ? `历史平滑通过前80%选择、最新20%的命中率/Log Loss/Brier/ECE/MCE门禁，` +
          `以及95%区块Bootstrap显著性门禁（命中率非劣界限 ${(accuracyMargin * 100).toFixed(2)}pp）`
        : !tuningPassed
          ? "较早调参段没有平滑强度同时改善 Log Loss、Brier、ECE，且保持命中率和MCE，生产继续使用原始历史占比"
          : !validationPassed
            ? "较早段选出的平滑强度未通过最新20%独立验证，生产继续使用原始历史占比"
            : "平滑改善未通过95%区块Bootstrap显著性门禁，生产继续使用原始历史占比",
    },
    sources,
  };
}
