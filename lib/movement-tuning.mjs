import {
  findSimilarGoalMovements,
  findSimilarGoals,
  findSimilarSpf,
  findSimilarSpfMovements,
  predictGoals,
  predictSpf,
  probabilityMovement,
} from "./predictor.mjs";
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
    targets: 0,
    evaluated: 0,
    correct: 0,
    logLoss: 0,
    brier: 0,
    movementSamples: [],
  };
}

function addTarget(target) {
  target.targets += 1;
}

function addCase(target, probabilities, actualIndex, movementSamples) {
  target.evaluated += 1;
  target.movementSamples.push(movementSamples);
  const highest = Math.max(...probabilities);
  const top = probabilities
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => Math.abs(value - highest) < 1e-12);
  if (top.some(({ index }) => index === actualIndex)) {
    target.correct += 1 / top.length;
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

function summarize(target) {
  if (!target.evaluated) {
    return {
      targets: target.targets,
      evaluated: 0,
      accuracy: 0,
      logLoss: 0,
      brier: 0,
      coverage: 0,
      medianMovementSamples: 0,
    };
  }
  return {
    targets: target.targets,
    evaluated: target.evaluated,
    accuracy: target.correct / target.evaluated,
    logLoss: target.logLoss / target.evaluated,
    brier: target.brier / target.evaluated,
    coverage: target.targets ? target.evaluated / target.targets : 0,
    medianMovementSamples: median(target.movementSamples),
  };
}

function blend(base, trend, weight) {
  return base.map(
    (value, index) => value * (1 - weight) + trend[index] * weight,
  );
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
  if (Math.abs(left.accuracy - right.accuracy) > 1e-10) {
    return left.accuracy > right.accuracy;
  }
  return left.weight < right.weight;
}

function empirical(probabilityObject, labels) {
  return labels.map((label) => probabilityObject[label] || 0);
}

export function tuneMovementCorrection(
  rows,
  {
    market,
    labels,
    outcomeField,
    tolerance,
    weights,
    compatible = () => true,
    warmup = 500,
    validationFraction = 0.2,
  },
) {
  const safeWeights = [...new Set(weights)]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 1)
    .sort((left, right) => left - right);
  const candidates = [
    { weight: 0, baseline: true },
    ...safeWeights.map((weight) => ({ weight, baseline: false })),
  ].map((candidate) => ({
    ...candidate,
    tuningAccumulator: accumulator(),
    validationAccumulator: accumulator(),
    validationDeltas: [],
  }));
  const sources = [];
  const isGoals = market === "goals";

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
      const targetAccumulators = candidates.map((candidate) =>
        bucket === "validation"
          ? candidate.validationAccumulator
          : candidate.tuningAccumulator,
      );
      targetAccumulators.forEach(addTarget);

      const history = group
        .slice(0, targetIndex)
        .filter((row) => compatible(row, target));
      const similar = isGoals
        ? findSimilarGoals(history, target.odds, { tolerance })
        : findSimilarSpf(history, target.odds, { tolerance });
      if (!similar.length) {
        if (bucket === "validation") validationCases += 1;
        else tuningCases += 1;
        continue;
      }
      const movement = probabilityMovement(target.initialOdds, target.odds);
      if (!movement.applied) {
        if (bucket === "validation") validationCases += 1;
        else tuningCases += 1;
        continue;
      }
      const movementRows = isGoals
        ? findSimilarGoalMovements(
            similar,
            target.initialOdds,
            target.odds,
            { finalTolerance: tolerance },
          )
        : findSimilarSpfMovements(
            similar,
            target.initialOdds,
            target.odds,
            { finalTolerance: tolerance },
          );
      if (!movementRows.length) {
        if (bucket === "validation") validationCases += 1;
        else tuningCases += 1;
        continue;
      }

      const basePrediction = isGoals
        ? predictGoals(target.odds, similar, {
            empiricalOnly: true,
            weighting: { enabled: false },
          })
        : predictSpf(target.odds, similar, {
            empiricalOnly: true,
            weighting: { enabled: false },
          });
      const trendPrediction = isGoals
        ? predictGoals(target.odds, movementRows, {
            empiricalOnly: true,
            weighting: { enabled: false },
          })
        : predictSpf(target.odds, movementRows, {
            empiricalOnly: true,
            weighting: { enabled: false },
          });
      const base = basePrediction.final;
      const trend = empirical(trendPrediction.stats.probabilities, labels);
      for (let index = 0; index < candidates.length; index += 1) {
        const probabilities = blend(
          base,
          trend,
          candidates[index].weight,
        );
        addCase(
          targetAccumulators[index],
          probabilities,
          actualIndex,
          movementRows.length,
        );
        if (bucket === "validation" && !candidates[index].baseline) {
          candidates[index].validationDeltas.push(
            classificationDelta(
              probabilities,
              base,
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

  const results = candidates.map((candidate) => ({
    weight: candidate.weight,
    baseline: candidate.baseline,
    tuning: summarize(candidate.tuningAccumulator),
    validation: summarize(candidate.validationAccumulator),
  }));
  const baseline = results.find((candidate) => candidate.baseline);
  let selected = null;
  for (const candidate of results.filter(
    (item) => !item.baseline && improves(item.tuning, baseline.tuning),
  )) {
    if (better(candidate.tuning, selected?.tuning)) selected = candidate;
  }
  const tuningPassed = Boolean(selected);
  const validationPassed =
    tuningPassed && improves(selected.validation, baseline.validation);
  const selectedCandidate = selected
    ? candidates.find(
        (candidate) => candidate.weight === selected.weight,
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
  if (selected) selected.significance = significance;
  const significancePassed = Boolean(significance.passed);
  const passed =
    tuningPassed && validationPassed && significancePassed;

  return {
    tolerance,
    selected: selected || baseline,
    baseline,
    candidates: results.filter((candidate) => !candidate.baseline),
    production: {
      enabled: passed,
      fixedWeight: passed ? selected.weight : 0,
      minSamples: 1,
    },
    gate: {
      passed,
      tuningPassed,
      validationPassed,
      significancePassed,
      reason: passed
        ? "初赔走势修正通过较早调参段、最新20%验证段和95%区块Bootstrap显著性门禁"
        : !tuningPassed
          ? "较早调参段没有走势修正比例同时改善 Log Loss、Brier 且保持命中率，生产环境仅展示走势参考"
          : !validationPassed
            ? "较早段选出的走势修正比例未通过最新20%独立验证，生产环境仅展示走势参考"
            : "走势修正改善未通过95%区块Bootstrap显著性门禁，生产环境仅展示走势参考",
    },
    sources,
  };
}
