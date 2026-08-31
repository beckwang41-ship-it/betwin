import {
  blockBootstrapStrategyComparison,
  pairedStrategyCase,
} from "./strategy-evaluation.mjs";

function uniqueSorted(values) {
  return [...new Set(values.map(Number))]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
}

export function selectAdaptiveSimilarity(
  history,
  targetOdds,
  {
    thresholds,
    minSamples,
    finder,
    finderOptions = {},
  },
) {
  const ladder = uniqueSorted(thresholds);
  if (!ladder.length) {
    throw new Error("动态相似范围至少需要一个候选阈值");
  }
  const required = Math.max(1, Math.round(Number(minSamples) || 1));
  const attempts = [];
  let selected = null;
  for (const threshold of ladder) {
    const similar = finder(history, targetOdds, {
      ...finderOptions,
      tolerance: threshold,
    });
    const attempt = { threshold, samples: similar.length, similar };
    attempts.push(attempt);
    selected = attempt;
    if (similar.length >= required) break;
  }
  return {
    threshold: selected.threshold,
    similar: selected.similar,
    samples: selected.samples,
    minSamples: required,
    reachedMinSamples: selected.samples >= required,
    attempts: attempts.map(({ threshold, samples }) => ({
      threshold,
      samples,
    })),
  };
}

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
    topTwoCorrect: 0,
    logLoss: 0,
    brier: 0,
    sampleSizes: [],
    thresholdCounts: {},
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function addCase(target, probabilities, actualIndex, samples, threshold) {
  target.targets += 1;
  if (!probabilities) return;
  target.evaluated += 1;
  target.sampleSizes.push(samples);
  const ranked = probabilities
    .map((value, index) => ({ value, index }))
    .sort((left, right) => right.value - left.value);
  const highest = ranked[0].value;
  const topIndices = ranked
    .filter(({ value }) => Math.abs(value - highest) < 1e-12)
    .map(({ index }) => index);
  if (topIndices.includes(actualIndex)) {
    target.correct += 1 / topIndices.length;
  }
  if (ranked.slice(0, 2).some(({ index }) => index === actualIndex)) {
    target.topTwoCorrect += 1;
  }
  target.logLoss -= Math.log(Math.max(1e-12, probabilities[actualIndex]));
  target.brier += probabilities.reduce((sum, probability, index) => {
    const actual = index === actualIndex ? 1 : 0;
    return sum + (probability - actual) ** 2;
  }, 0);
  const key = String(threshold);
  target.thresholdCounts[key] = (target.thresholdCounts[key] || 0) + 1;
}

function summarize(value) {
  if (!value.evaluated) {
    return {
      targets: value.targets,
      evaluated: 0,
      accuracy: 0,
      topTwoCoverage: 0,
      logLoss: 0,
      brier: 0,
      coverage: 0,
      medianSamples: 0,
      thresholdCounts: {},
    };
  }
  return {
    targets: value.targets,
    evaluated: value.evaluated,
    accuracy: value.correct / value.evaluated,
    topTwoCoverage: value.topTwoCorrect / value.evaluated,
    logLoss: value.logLoss / value.evaluated,
    brier: value.brier / value.evaluated,
    coverage: value.targets ? value.evaluated / value.targets : 0,
    medianSamples: median(value.sampleSizes),
    thresholdCounts: value.thresholdCounts,
  };
}

function pairedAccumulator() {
  return {
    adaptive: accumulator(),
    baseline: accumulator(),
  };
}

function addPair(
  pair,
  adaptive,
  baseline,
  actualIndex,
  adaptiveSamples,
  baselineSamples,
  adaptiveThreshold,
  baselineThreshold,
) {
  addCase(
    pair.adaptive,
    adaptive,
    actualIndex,
    adaptiveSamples,
    adaptiveThreshold,
  );
  addCase(
    pair.baseline,
    baseline,
    actualIndex,
    baselineSamples,
    baselineThreshold,
  );
}

function summarizePair(pair) {
  const adaptive = summarize(pair.adaptive);
  const baseline = summarize(pair.baseline);
  return {
    evaluated: adaptive.evaluated,
    adaptive,
    baseline,
    delta: {
      accuracy: adaptive.accuracy - baseline.accuracy,
      topTwoCoverage:
        adaptive.topTwoCoverage - baseline.topTwoCoverage,
      logLoss: adaptive.logLoss - baseline.logLoss,
      brier: adaptive.brier - baseline.brier,
    },
  };
}

function improves(comparison, objective) {
  if (!comparison?.evaluated) return false;
  const epsilon = 1e-10;
  const targetDelta =
    objective === "top-two"
      ? comparison.delta.topTwoCoverage
      : comparison.delta.accuracy;
  return (
    targetDelta >= -epsilon &&
    comparison.delta.logLoss < -epsilon &&
    comparison.delta.brier < -epsilon
  );
}

function better(left, right, objective) {
  if (!right) return true;
  const metric =
    objective === "top-two" ? "topTwoCoverage" : "accuracy";
  if (Math.abs(left.delta[metric] - right.delta[metric]) > 1e-10) {
    return left.delta[metric] > right.delta[metric];
  }
  if (Math.abs(left.delta.logLoss - right.delta.logLoss) > 1e-10) {
    return left.delta.logLoss < right.delta.logLoss;
  }
  if (Math.abs(left.delta.brier - right.delta.brier) > 1e-10) {
    return left.delta.brier < right.delta.brier;
  }
  return left.minSamples > right.minSamples;
}

function probabilityDistribution(counts, total) {
  return total ? counts.map((count) => count / total) : null;
}

function adaptiveIndex(sampleSizes, minSamples) {
  const index = sampleSizes.findIndex((size) => size >= minSamples);
  return index >= 0 ? index : sampleSizes.length - 1;
}

export function tuneAdaptiveMinimumSamples(
  rows,
  {
    labels,
    outcomeField,
    thresholds,
    minSampleCandidates,
    baselineThreshold,
    distance,
    compatible = () => true,
    targetEligible = () => true,
    actualForTarget = (target) => target[outcomeField],
    oddsForTarget = (target) => target.odds,
    sampleResolver = null,
    outcomeForSample = (row) => row[outcomeField],
    probabilityResolver = probabilityDistribution,
    warmup = 500,
    validationFraction = 0.2,
    objective = "accuracy",
  },
) {
  const ladder = uniqueSorted([...thresholds, baselineThreshold]);
  const minimums = uniqueSorted(minSampleCandidates).map((value) =>
    Math.round(value),
  );
  const baselineIndex = ladder.findIndex(
    (value) => Math.abs(value - baselineThreshold) < 1e-12,
  );
  const candidates = minimums.map((minSamples) => ({
    minSamples,
    tuning: accumulator(),
    validation: accumulator(),
    tuningPair: pairedAccumulator(),
    validationPair: pairedAccumulator(),
    validationStrategyCases: [],
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
      if (!targetEligible(target)) continue;
      const actualIndex = labels.indexOf(String(actualForTarget(target)));
      if (actualIndex < 0) continue;
      const bucket =
        targetIndex >= validationStart ? "validation" : "tuning";
      const priorRows = group.slice(0, targetIndex);
      const counts = ladder.map(() =>
        Array.from({ length: labels.length }, () => 0),
      );
      const sampleSizes = ladder.map(() => 0);
      if (sampleResolver) {
        for (let index = 0; index < ladder.length; index += 1) {
          const samples = sampleResolver(target, priorRows, ladder[index]);
          for (const sample of samples) {
            const labelIndex = labels.indexOf(
              String(outcomeForSample(sample)),
            );
            if (labelIndex < 0) continue;
            counts[index][labelIndex] += 1;
            sampleSizes[index] += 1;
          }
        }
      } else {
        for (let historyIndex = 0; historyIndex < targetIndex; historyIndex += 1) {
          const history = group[historyIndex];
          if (!compatible(history, target)) continue;
          const value = distance(history, target);
          const labelIndex = labels.indexOf(String(history[outcomeField]));
          if (labelIndex < 0) continue;
          const first = ladder.findIndex((threshold) => value <= threshold);
          if (first < 0) continue;
          for (let index = first; index < ladder.length; index += 1) {
            counts[index][labelIndex] += 1;
            sampleSizes[index] += 1;
          }
        }
      }
      const probabilities = counts.map((values, index) =>
        sampleSizes[index]
          ? probabilityResolver(values, sampleSizes[index])
          : null,
      );
      const baseline = probabilities[baselineIndex];
      for (const candidate of candidates) {
        const index = adaptiveIndex(sampleSizes, candidate.minSamples);
        const adaptive = probabilities[index];
        const targetAccumulator = candidate[bucket];
        addCase(
          targetAccumulator,
          adaptive,
          actualIndex,
          sampleSizes[index],
          ladder[index],
        );
        if (adaptive && baseline) {
          addPair(
            bucket === "validation"
              ? candidate.validationPair
              : candidate.tuningPair,
            adaptive,
            baseline,
            actualIndex,
            sampleSizes[index],
            sampleSizes[baselineIndex],
            ladder[index],
            baselineThreshold,
          );
          if (bucket === "validation") {
            candidate.validationStrategyCases.push(
              pairedStrategyCase(
                adaptive,
                baseline,
                oddsForTarget(target),
                actualIndex,
                { sourceFile, order: target.sourceRow },
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

  const results = candidates.map((candidate) => ({
    minSamples: candidate.minSamples,
    tuning: summarize(candidate.tuning),
    validation: summarize(candidate.validation),
    tuningComparison: summarizePair(candidate.tuningPair),
    validationComparison: summarizePair(candidate.validationPair),
    strategy: blockBootstrapStrategyComparison(
      candidate.validationStrategyCases,
    ),
  }));
  let selected = null;
  for (const candidate of results.filter((item) =>
    improves(item.tuningComparison, objective),
  )) {
    if (
      better(
        { minSamples: candidate.minSamples, ...candidate.tuningComparison },
        selected,
        objective,
      )
    ) {
      selected = {
        minSamples: candidate.minSamples,
        ...candidate.tuningComparison,
      };
    }
  }
  const selectedResult = selected
    ? results.find((item) => item.minSamples === selected.minSamples)
    : null;
  const tuningPassed = Boolean(selectedResult);
  const validationPassed =
    tuningPassed &&
    improves(selectedResult.validationComparison, objective);
  const enabled = tuningPassed && validationPassed;
  return {
    enabled,
    objective,
    thresholds: ladder,
    baselineThreshold,
    minSamples: enabled ? selectedResult.minSamples : null,
    selected: selectedResult,
    candidates: results,
    gate: {
      passed: enabled,
      tuningPassed,
      validationPassed,
      reason: enabled
        ? "动态最小范围在较早80%和最新20%均优于固定范围"
        : !tuningPassed
          ? "较早80%没有动态最低样本规则同时改善目标指标、Log Loss和Brier"
          : "较早80%选出的动态规则未通过最新20%验证",
    },
    sources,
  };
}
