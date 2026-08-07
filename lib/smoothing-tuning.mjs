import {
  blockBootstrapComparison,
  classificationDelta,
} from "./significance.mjs";
import {
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
  target.evaluated += 1;
  target.correct += topScore(probabilities, actualIndex);
  target.logLoss -= Math.log(Math.max(1e-12, probabilities[actualIndex]));
  target.brier += probabilities.reduce((sum, probability, index) => {
    const actual = index === actualIndex ? 1 : 0;
    return sum + (probability - actual) ** 2;
  }, 0);
  target.sampleSizes.push(sampleSize);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
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
  };
}

function comparison(candidate, baseline) {
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

function improves(value) {
  const epsilon = 1e-10;
  return (
    value?.evaluated > 0 &&
    value.delta.logLoss < -epsilon &&
    value.delta.brier < -epsilon &&
    value.delta.accuracy >= -epsilon
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

function rawDistribution(rows, labels, outcomeField) {
  const counts = labels.map(() => 0);
  for (const row of rows) {
    const index = labels.indexOf(String(row[outcomeField]));
    if (index >= 0) counts[index] += 1;
  }
  return counts.map((count) => count / rows.length);
}

export function tuneHistoricalSmoothing(
  rows,
  {
    labels,
    outcomeField,
    distance,
    threshold,
    strengths = [1, 2, 3, 5, 8, 12, 20],
    compatible = () => true,
    warmup = 500,
    validationFraction = 0.2,
    relaxedMultiplier = 2,
    minLocalizedSamples = 30,
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
      const similar = history.filter(
        (row) =>
          compatible(row, target) &&
          distance(row, target) <= threshold &&
          labels.includes(String(row[outcomeField])),
      );
      if (!similar.length) continue;
      const raw = rawDistribution(similar, labels, outcomeField);
      const prior = selectHistoricalPrior(history, target, {
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
      ? blockBootstrapComparison(selectedInternal.validationDeltas)
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
  const passed =
    tuningPassed && validationPassed && Boolean(significance.passed);

  return {
    threshold,
    relaxedTolerance: threshold * relaxedMultiplier,
    minLocalizedSamples,
    candidateStrength: reference.strength,
    strength: passed ? reference.strength : 0,
    changed: passed,
    selected: {
      ...reference,
      significance,
    },
    baseline: baselineSummary,
    candidates: results,
    production: {
      enabled: passed,
      strength: passed ? reference.strength : 0,
      referenceStrength: reference.strength,
      relaxedMultiplier,
      minLocalizedSamples,
    },
    gate: {
      passed,
      tuningPassed,
      validationPassed,
      significancePassed: Boolean(significance.passed),
      reason: passed
        ? "历史平滑通过前80%选择、最新20%指标门禁和95%区块Bootstrap显著性门禁"
        : !tuningPassed
          ? "较早调参段没有平滑强度同时改善 Log Loss、Brier 且保持命中率，生产继续使用原始历史占比"
          : !validationPassed
            ? "较早段选出的平滑强度未通过最新20%独立验证，生产继续使用原始历史占比"
            : "平滑改善未通过95%区块Bootstrap显著性门禁，生产继续使用原始历史占比",
    },
    sources,
  };
}
