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
  };
}

function addTarget(target) {
  target.targets += 1;
}

function addCase(target, probabilities, actualIndex, sampleSize) {
  target.evaluated += 1;
  target.sampleSizes.push(sampleSize);
  const highest = Math.max(...probabilities);
  const topIndices = probabilities
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => Math.abs(value - highest) < 1e-12)
    .map(({ index }) => index);
  if (topIndices.includes(actualIndex)) {
    target.correct += 1 / topIndices.length;
  }
  target.logLoss -= Math.log(Math.max(1e-12, probabilities[actualIndex]));
  target.brier += probabilities.reduce((sum, probability, index) => {
    const actual = index === actualIndex ? 1 : 0;
    return sum + (probability - actual) ** 2;
  }, 0);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function summarize(value) {
  if (!value.evaluated) {
    return {
      targets: value.targets,
      evaluated: 0,
      accuracy: 0,
      logLoss: 0,
      brier: 0,
      coverage: 0,
      medianSamples: 0,
    };
  }
  return {
    targets: value.targets,
    evaluated: value.evaluated,
    accuracy: value.correct / value.evaluated,
    logLoss: value.logLoss / value.evaluated,
    brier: value.brier / value.evaluated,
    coverage: value.targets ? value.evaluated / value.targets : 0,
    medianSamples: median(value.sampleSizes),
  };
}

function distribution(counts, total) {
  return counts.map((count) => count / total);
}

function pairedAccumulator() {
  return {
    candidate: accumulator(),
    baseline: accumulator(),
  };
}

function addPairedCase(
  pair,
  candidate,
  baseline,
  actualIndex,
  candidateSamples,
  baselineSamples,
) {
  addTarget(pair.candidate);
  addTarget(pair.baseline);
  addCase(pair.candidate, candidate, actualIndex, candidateSamples);
  addCase(pair.baseline, baseline, actualIndex, baselineSamples);
}

function summarizePair(pair) {
  const candidate = summarize(pair.candidate);
  const baseline = summarize(pair.baseline);
  return {
    evaluated: candidate.evaluated,
    candidate,
    baseline,
    delta: {
      accuracy: candidate.accuracy - baseline.accuracy,
      logLoss: candidate.logLoss - baseline.logLoss,
      brier: candidate.brier - baseline.brier,
    },
  };
}

function improves(pair) {
  const epsilon = 1e-10;
  return (
    pair.evaluated > 0 &&
    pair.delta.logLoss < -epsilon &&
    pair.delta.brier < -epsilon &&
    pair.delta.accuracy >= -epsilon
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
  return left.threshold < right.threshold;
}

export function tuneMarketThreshold(
  rows,
  {
    labels,
    outcomeField,
    tolerances,
    currentTolerance,
    distance,
    compatible = () => true,
    warmup = 500,
    validationFraction = 0.2,
  },
) {
  const safeTolerances = [...new Set([...tolerances, currentTolerance])]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  const baselineIndex = safeTolerances.findIndex(
    (value) => Math.abs(value - currentTolerance) < 1e-12,
  );
  const candidates = safeTolerances.map((threshold) => ({
    threshold,
    tuningAccumulator: accumulator(),
    validationAccumulator: accumulator(),
    tuningPair: pairedAccumulator(),
    validationPair: pairedAccumulator(),
    validationDeltas: [],
  }));
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
      const counts = safeTolerances.map(() =>
        Array.from({ length: labels.length }, () => 0),
      );
      const sampleSizes = safeTolerances.map(() => 0);

      for (let historyIndex = 0; historyIndex < targetIndex; historyIndex += 1) {
        const history = group[historyIndex];
        if (!compatible(history, target)) continue;
        const value = distance(history, target);
        const labelIndex = labels.indexOf(String(history[outcomeField]));
        if (labelIndex < 0) continue;
        const firstTolerance = safeTolerances.findIndex(
          (threshold) => value <= threshold,
        );
        if (firstTolerance < 0) continue;
        for (
          let toleranceIndex = firstTolerance;
          toleranceIndex < safeTolerances.length;
          toleranceIndex += 1
        ) {
          counts[toleranceIndex][labelIndex] += 1;
          sampleSizes[toleranceIndex] += 1;
        }
      }

      const probabilities = counts.map((values, index) =>
        sampleSizes[index] ? distribution(values, sampleSizes[index]) : null,
      );
      const baseline = probabilities[baselineIndex];
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const targetAccumulator =
          bucket === "validation"
            ? candidate.validationAccumulator
            : candidate.tuningAccumulator;
        addTarget(targetAccumulator);
        if (probabilities[index]) {
          addCase(
            targetAccumulator,
            probabilities[index],
            actualIndex,
            sampleSizes[index],
          );
        }
        if (index !== baselineIndex && probabilities[index] && baseline) {
          addPairedCase(
            bucket === "validation"
              ? candidate.validationPair
              : candidate.tuningPair,
            probabilities[index],
            baseline,
            actualIndex,
            sampleSizes[index],
            sampleSizes[baselineIndex],
          );
          if (bucket === "validation") {
            candidate.validationDeltas.push(
              classificationDelta(
                probabilities[index],
                baseline,
                actualIndex,
                {
                  sourceFile,
                  order: target.sourceRow,
                },
              ),
            );
          }
        }
      }

      if (bucket === "validation") validationCases += 1;
      else tuningCases += 1;
    }

    sources.push({
      sourceFile,
      rows: group.length,
      warmup: Math.min(warmup, group.length),
      tuningCases,
      validationCases,
    });
  }

  const results = candidates.map((candidate, index) => ({
    threshold: candidate.threshold,
    isCurrent: index === baselineIndex,
    tuning: summarize(candidate.tuningAccumulator),
    validation: summarize(candidate.validationAccumulator),
    tuningComparison:
      index === baselineIndex ? null : summarizePair(candidate.tuningPair),
    validationComparison:
      index === baselineIndex
        ? null
        : summarizePair(candidate.validationPair),
  }));
  const baseline = results[baselineIndex];
  let selected = null;
  for (const candidate of results.filter(
    (item) =>
      !item.isCurrent &&
      improves(item.tuningComparison),
  )) {
    const comparison = {
      threshold: candidate.threshold,
      ...candidate.tuningComparison,
    };
    if (better(comparison, selected)) selected = comparison;
  }

  const selectedResult = selected
    ? results.find((item) => item.threshold === selected.threshold)
    : baseline;
  const tuningPassed = Boolean(selected);
  const validationPassed =
    tuningPassed && improves(selectedResult.validationComparison);
  const selectedCandidate = selected
    ? candidates.find(
        (candidate) => candidate.threshold === selectedResult.threshold,
      )
    : null;
  const significance =
    validationPassed && selectedCandidate
      ? blockBootstrapComparison(selectedCandidate.validationDeltas)
      : {
          passed: false,
          status: "not-run",
          reason: "基础指标门禁未通过，未运行显著性检验",
          iterations: 0,
          blockSize: 20,
          confidence: 0.95,
          evaluated: 0,
          metrics: null,
        };
  selectedResult.significance = significance;
  const significancePassed = Boolean(significance.passed);
  const changed = tuningPassed && validationPassed;
  const productionThreshold = changed
    ? selectedResult.threshold
    : currentTolerance;

  return {
    currentThreshold: currentTolerance,
    candidateThreshold: selectedResult.threshold,
    threshold: productionThreshold,
    changed,
    selected: selectedResult,
    baseline,
    candidates: results,
    gate: {
      passed: changed,
      tuningPassed,
      validationPassed,
      significancePassed,
      confidence: significancePassed
        ? "strict"
        : changed
          ? "provisional"
          : "rejected",
      reason: changed
        ? significancePassed
          ? "候选阈值通过前80%选择、最新20%指标门禁和95%区块Bootstrap显著性门禁"
          : "候选阈值在前80%和最新20%均改善，按表现优先策略采用；尚未通过95%显著性门禁，标记为观察中"
        : !tuningPassed
          ? "较早调参段没有候选阈值同时改善 Log Loss、Brier 且保持命中率，保留当前阈值"
          : !validationPassed
            ? "较早段选出的候选阈值未通过最新20%独立验证，保留当前阈值"
            : "候选阈值的改善未通过95%区块Bootstrap显著性门禁，保留当前阈值",
    },
    sources,
  };
}

// 兼容旧测试和外部调用；新代码应使用 tuneMarketThreshold。
export const tuneMarket = tuneMarketThreshold;
import {
  blockBootstrapComparison,
  classificationDelta,
} from "./significance.mjs";
