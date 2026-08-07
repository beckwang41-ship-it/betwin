import { distanceWeight } from "./predictor.mjs";
import {
  blockBootstrapComparison,
  classificationDelta,
} from "./significance.mjs";

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
    evaluated: 0,
    correct: 0,
    logLoss: 0,
    brier: 0,
  };
}

function topIndex(probabilities) {
  return probabilities.indexOf(Math.max(...probabilities));
}

function addCase(target, probabilities, actualIndex) {
  target.evaluated += 1;
  if (topIndex(probabilities) === actualIndex) target.correct += 1;
  target.logLoss -= Math.log(
    Math.max(1e-12, probabilities[actualIndex]),
  );
  target.brier += probabilities.reduce((sum, probability, index) => {
    const actual = index === actualIndex ? 1 : 0;
    return sum + (probability - actual) ** 2;
  }, 0);
}

function summarize(target) {
  if (!target.evaluated) {
    return { evaluated: 0, accuracy: 0, logLoss: 0, brier: 0 };
  }
  return {
    evaluated: target.evaluated,
    accuracy: target.correct / target.evaluated,
    logLoss: target.logLoss / target.evaluated,
    brier: target.brier / target.evaluated,
  };
}

function probabilitiesFor(samples, labelCount, candidate, tolerance) {
  const counts = Array.from({ length: labelCount }, () => 0);
  let total = 0;
  for (const sample of samples) {
    const weight = candidate.uniform
      ? 1
      : distanceWeight(sample.distance, {
          enabled: true,
          tolerance,
          floor: candidate.floor,
          power: candidate.power,
        });
    counts[sample.labelIndex] += weight;
    total += weight;
  }
  return counts.map((value) => value / total);
}

function improves(candidate, baseline) {
  const epsilon = 1e-10;
  return (
    candidate.evaluated === baseline.evaluated &&
    candidate.evaluated > 0 &&
    candidate.logLoss < baseline.logLoss - epsilon &&
    candidate.brier < baseline.brier - epsilon &&
    candidate.accuracy >= baseline.accuracy - epsilon
  );
}

function better(left, right) {
  if (!right) return true;
  if (Math.abs(left.logLoss - right.logLoss) > 1e-10) {
    return left.logLoss < right.logLoss;
  }
  if (Math.abs(left.brier - right.brier) > 1e-10) {
    return left.brier < right.brier;
  }
  return left.accuracy > right.accuracy;
}

export function tuneSimilarityWeighting(
  rows,
  {
    labels,
    outcomeField,
    tolerance,
    candidates,
    distance,
    compatible = () => true,
    warmup = 500,
    validationFraction = 0.2,
  },
) {
  const uniform = {
    id: "uniform",
    uniform: true,
    enabled: false,
    floor: 1,
    power: 1,
  };
  const options = [
    uniform,
    ...candidates.map((candidate, index) => ({
      id: candidate.id || `weighted-${index + 1}`,
      uniform: false,
      enabled: true,
      floor: candidate.floor,
      power: candidate.power,
    })),
  ].map((candidate) => ({
    ...candidate,
    tuningAccumulator: accumulator(),
    validationAccumulator: accumulator(),
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
      const samples = [];
      for (let historyIndex = 0; historyIndex < targetIndex; historyIndex += 1) {
        const history = group[historyIndex];
        if (!compatible(history, target)) continue;
        const value = distance(history, target);
        if (value > tolerance) continue;
        const labelIndex = labels.indexOf(String(history[outcomeField]));
        if (labelIndex < 0) continue;
        samples.push({ labelIndex, distance: value });
      }
      if (!samples.length) continue;
      const bucket =
        targetIndex >= validationStart ? "validation" : "tuning";
      const candidateProbabilities = options.map((candidate) =>
        probabilitiesFor(
          samples,
          labels.length,
          candidate,
          tolerance,
        ),
      );
      for (let index = 0; index < options.length; index += 1) {
        const candidate = options[index];
        const probabilities = candidateProbabilities[index];
        addCase(
          bucket === "validation"
            ? candidate.validationAccumulator
            : candidate.tuningAccumulator,
          probabilities,
          actualIndex,
        );
        if (bucket === "validation" && !candidate.uniform) {
          candidate.validationDeltas.push(
            classificationDelta(
              probabilities,
              candidateProbabilities[0],
              actualIndex,
              {
                sourceFile,
                order: target.sourceRow,
              },
            ),
          );
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

  const results = options.map((candidate) => ({
    id: candidate.id,
    uniform: candidate.uniform,
    enabled: candidate.enabled,
    floor: candidate.floor,
    power: candidate.power,
    tuning: summarize(candidate.tuningAccumulator),
    validation: summarize(candidate.validationAccumulator),
  }));
  const baseline = results.find((candidate) => candidate.uniform);
  let selected = null;
  for (const candidate of results.filter(
    (item) => !item.uniform && improves(item.tuning, baseline.tuning),
  )) {
    if (better(candidate.tuning, selected?.tuning)) selected = candidate;
  }
  const tuningPassed = Boolean(selected);
  const validationPassed =
    tuningPassed && improves(selected.validation, baseline.validation);
  const selectedOption = selected
    ? options.find((candidate) => candidate.id === selected.id)
    : null;
  const significance =
    validationPassed && selectedOption
      ? blockBootstrapComparison(selectedOption.validationDeltas)
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
  if (selected) selected.significance = significance;
  const significancePassed = Boolean(significance.passed);
  const passed =
    tuningPassed && validationPassed && significancePassed;
  const production = passed
    ? {
        enabled: true,
        floor: selected.floor,
        power: selected.power,
        coreRatio: 0.5,
      }
    : {
        enabled: false,
        floor: 1,
        power: 1,
        coreRatio: 0.5,
      };

  return {
    threshold: tolerance,
    selected: selected || baseline,
    baseline,
    candidates: results.filter((candidate) => !candidate.uniform),
    production,
    gate: {
      passed,
      tuningPassed,
      validationPassed,
      significancePassed,
      reason: passed
        ? "较早调参段、最新验证段和95%区块Bootstrap显著性门禁均通过"
        : !tuningPassed
          ? "较早调参段没有权重方案同时改善 Log Loss、Brier 且保持命中率"
          : !validationPassed
            ? "较早段选出的权重未通过最新20%独立验证，生产环境回退等权统计"
            : "权重改善未通过95%区块Bootstrap显著性门禁，生产环境回退等权统计",
    },
    sources,
  };
}
