import { smoothHistoricalDistribution } from "./smoothing.mjs";

export const OUTCOME_LABELS = ["胜", "平", "负"];
export const GOAL_LABELS = ["0", "1", "2", "3", "4", "5", "6", "7+"];
const MOVEMENT_EPSILON = 0.0005;

export function selectTopGoalPair(
  probabilities,
  odds = [],
  labels = GOAL_LABELS,
) {
  if (
    !Array.isArray(probabilities) ||
    probabilities.length < 2 ||
    probabilities.length !== labels.length ||
    probabilities.some((value) => !Number.isFinite(Number(value)))
  ) {
    return {
      available: false,
      indices: [],
      labels: [],
      probability: 0,
      odds: [],
      stakeUnits: 2,
    };
  }
  const indices = probabilities
    .map((value, index) => ({ index, probability: Number(value) }))
    .sort(
      (left, right) =>
        right.probability - left.probability ||
        left.index - right.index,
    )
    .slice(0, 2)
    .map(({ index }) => index);
  const probability = indices.reduce(
    (total, index) => total + Number(probabilities[index]),
    0,
  );
  return {
    available: true,
    indices,
    labels: indices.map((index) => labels[index]),
    probability,
    odds: indices.map((index) => Number(odds[index])).filter(Number.isFinite),
    stakeUnits: 2,
  };
}

function validOdds(odds, expectedLength = null) {
  return (
    Array.isArray(odds) &&
    (!expectedLength || odds.length === expectedLength) &&
    odds.length > 0 &&
    odds.every((odd) => Number.isFinite(Number(odd)) && Number(odd) > 1)
  );
}

function rmsDistance(left, right) {
  const mse =
    left.reduce((sum, value, index) => {
      const delta = value - right[index];
      return sum + delta * delta;
    }, 0) / left.length;
  return Math.sqrt(mse);
}

export function normalizeOdds(odds) {
  const implied = odds.map((odd) => 1 / Number(odd));
  const total = implied.reduce((sum, value) => sum + value, 0);
  return implied.map((value) => value / total);
}

export function spfDistance(historyOdds, targetOdds) {
  return Math.max(
    ...historyOdds.map((odd, index) =>
      Math.abs(Number(odd) / Number(targetOdds[index]) - 1),
    ),
  );
}

export function goalDistance(historyOdds, targetOdds) {
  const history = normalizeOdds(historyOdds);
  const target = normalizeOdds(targetOdds);
  return Math.max(
    ...history.map((value, index) => Math.abs(value - target[index])),
  );
}

function expectedGoals(probabilities) {
  return probabilities.reduce(
    (sum, probability, index) =>
      sum + probability * (index === 7 ? 7.5 : index),
    0,
  );
}

export function probabilityMovement(initialOdds, finalOdds) {
  if (
    !validOdds(initialOdds) ||
    !validOdds(finalOdds, initialOdds?.length)
  ) {
    return {
      applied: false,
      reason: "missing-initial",
      initial: [],
      final: [],
      delta: [],
      magnitude: 0,
    };
  }
  const initial = normalizeOdds(initialOdds);
  const final = normalizeOdds(finalOdds);
  const delta = final.map((value, index) => value - initial[index]);
  const magnitude = Math.max(...delta.map((value) => Math.abs(value)));
  return {
    applied: magnitude >= MOVEMENT_EPSILON,
    reason: magnitude >= MOVEMENT_EPSILON ? "available" : "no-change",
    initial,
    final,
    delta,
    magnitude,
  };
}

export function movementDistance(
  historyInitialOdds,
  historyFinalOdds,
  targetInitialOdds,
  targetFinalOdds,
) {
  const history = probabilityMovement(historyInitialOdds, historyFinalOdds);
  const target = probabilityMovement(targetInitialOdds, targetFinalOdds);
  if (!history.delta.length || !target.delta.length) return Number.POSITIVE_INFINITY;
  return rmsDistance(history.delta, target.delta);
}

export function findSimilarSpf(
  history,
  targetOdds,
  { tolerance = 0.1, league = "", sameLeague = false } = {},
) {
  return history
    .filter((row) => !sameLeague || row.league === league)
    .map((row) => ({ ...row, distance: spfDistance(row.odds, targetOdds) }))
    .filter((row) => row.distance <= tolerance)
    .sort((a, b) => a.distance - b.distance);
}

export function findSimilarGoals(
  history,
  targetOdds,
  { tolerance = 0.005, league = "", sameLeague = false } = {},
) {
  return history
    .filter((row) => !sameLeague || row.league === league)
    .map((row) => ({ ...row, distance: goalDistance(row.odds, targetOdds) }))
    .filter((row) => row.distance <= tolerance)
    .sort((a, b) => a.distance - b.distance);
}

export function findSimilarSpfMovements(
  history,
  targetInitialOdds,
  targetFinalOdds,
  {
    finalTolerance = 0.1,
    initialTolerance = finalTolerance * 1.5,
    movementTolerance = Math.max(0.006, finalTolerance * 0.15),
  } = {},
) {
  const targetMovement = probabilityMovement(targetInitialOdds, targetFinalOdds);
  if (!targetMovement.applied) return [];
  return history
    .filter((row) => validOdds(row.initialOdds, targetFinalOdds.length))
    .map((row) => {
      const finalDistance = spfDistance(row.odds, targetFinalOdds);
      const initialDistance = spfDistance(row.initialOdds, targetInitialOdds);
      const trendDistance = movementDistance(
        row.initialOdds,
        row.odds,
        targetInitialOdds,
        targetFinalOdds,
      );
      const movementScore =
        (finalDistance / finalTolerance) * 0.4 +
        (initialDistance / initialTolerance) * 0.25 +
        (trendDistance / movementTolerance) * 0.35;
      return {
        ...row,
        finalDistance,
        initialDistance,
        movementDistance: trendDistance,
        movementScore,
      };
    })
    .filter(
      (row) =>
        row.finalDistance <= finalTolerance &&
        row.initialDistance <= initialTolerance &&
        row.movementDistance <= movementTolerance,
    )
    .sort((left, right) => left.movementScore - right.movementScore);
}

export function findSimilarGoalMovements(
  history,
  targetInitialOdds,
  targetFinalOdds,
  {
    finalTolerance = 0.005,
    initialTolerance = finalTolerance * 2,
    movementTolerance = Math.max(0.003, finalTolerance * 1.5),
  } = {},
) {
  const targetMovement = probabilityMovement(targetInitialOdds, targetFinalOdds);
  if (!targetMovement.applied) return [];
  return history
    .filter((row) => validOdds(row.initialOdds, targetFinalOdds.length))
    .map((row) => {
      const finalDistance = goalDistance(row.odds, targetFinalOdds);
      const initialDistance = goalDistance(row.initialOdds, targetInitialOdds);
      const trendDistance = movementDistance(
        row.initialOdds,
        row.odds,
        targetInitialOdds,
        targetFinalOdds,
      );
      const movementScore =
        (finalDistance / finalTolerance) * 0.4 +
        (initialDistance / initialTolerance) * 0.25 +
        (trendDistance / movementTolerance) * 0.35;
      return {
        ...row,
        finalDistance,
        initialDistance,
        movementDistance: trendDistance,
        movementScore,
      };
    })
    .filter(
      (row) =>
        row.finalDistance <= finalTolerance &&
        row.initialDistance <= initialTolerance &&
        row.movementDistance <= movementTolerance,
    )
    .sort((left, right) => left.movementScore - right.movementScore);
}

export function distribution(rows, field, labels) {
  const counts = Object.fromEntries(labels.map((label) => [label, 0]));
  for (const row of rows) {
    const label = String(row[field]);
    if (label in counts) counts[label] += 1;
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    counts,
    probabilities: Object.fromEntries(
      labels.map((label) => [label, total ? counts[label] / total : 0]),
    ),
    total,
  };
}

export function distanceWeight(
  distance,
  {
    enabled = true,
    tolerance = 1,
    floor = 0.2,
    power = 2,
  } = {},
) {
  if (!enabled) return 1;
  const safeTolerance = Math.max(Number(tolerance) || 0, Number.EPSILON);
  const safeFloor = Math.min(1, Math.max(Number(floor) || 0, 0.01));
  const safePower = Math.max(Number(power) || 1, 0.1);
  const numericDistance = Number(distance);
  const ratio = Number.isFinite(numericDistance)
    ? Math.min(1, Math.max(0, numericDistance / safeTolerance))
    : 0;
  return safeFloor + (1 - safeFloor) * (1 - ratio) ** safePower;
}

export function weightedDistribution(
  rows,
  field,
  labels,
  {
    enabled = false,
    tolerance = 1,
    floor = 0.2,
    power = 2,
    coreRatio = 0.5,
  } = {},
) {
  const raw = distribution(rows, field, labels);
  const safeTolerance = Math.max(Number(tolerance) || 0, Number.EPSILON);
  const safeFloor = Math.min(1, Math.max(Number(floor) || 0, 0.01));
  const safePower = Math.max(Number(power) || 1, 0.1);
  const weightedCounts = Object.fromEntries(
    labels.map((label) => [label, 0]),
  );
  let totalWeight = 0;
  let squaredWeightTotal = 0;
  let coreSamples = 0;
  let minimumWeight = rows.length ? Number.POSITIVE_INFINITY : 0;
  let maximumWeight = 0;

  for (const row of rows) {
    const label = String(row[field]);
    if (!(label in weightedCounts)) continue;
    const distance = Number(row.distance);
    const ratio = Number.isFinite(distance)
      ? Math.min(1, Math.max(0, distance / safeTolerance))
      : 0;
    const weight = distanceWeight(distance, {
      enabled,
      tolerance: safeTolerance,
      floor: safeFloor,
      power: safePower,
    });
    weightedCounts[label] += weight;
    totalWeight += weight;
    squaredWeightTotal += weight ** 2;
    minimumWeight = Math.min(minimumWeight, weight);
    maximumWeight = Math.max(maximumWeight, weight);
    if (!Number.isFinite(distance) || ratio <= coreRatio) coreSamples += 1;
  }

  return {
    enabled: Boolean(enabled),
    method: enabled ? "distance-decay-with-floor" : "uniform",
    tolerance: safeTolerance,
    floor: safeFloor,
    power: safePower,
    coreRatio,
    raw,
    weightedCounts,
    probabilities: Object.fromEntries(
      labels.map((label) => [
        label,
        totalWeight ? weightedCounts[label] / totalWeight : 0,
      ]),
    ),
    totalWeight,
    effectiveSamples: squaredWeightTotal
      ? totalWeight ** 2 / squaredWeightTotal
      : 0,
    coreSamples,
    minimumWeight: Number.isFinite(minimumWeight) ? minimumWeight : 0,
    maximumWeight,
  };
}

export function blendPrediction(
  market,
  empirical,
  sampleSize,
  {
    enabled = true,
    fixedWeight = null,
    minSamples = 1,
    maxWeight = 0.45,
    scale = 800,
    empiricalOnly = false,
  } = {},
) {
  if (empiricalOnly) {
    return sampleSize
      ? {
          probabilities: [...empirical],
          empiricalWeight: 1,
          available: true,
        }
      : {
          probabilities: market.map(() => 0),
          empiricalWeight: 0,
          available: false,
        };
  }
  if (!enabled || sampleSize < minSamples) {
    return {
      probabilities: [...market],
      empiricalWeight: 0,
      available: true,
    };
  }
  const empiricalWeight =
    fixedWeight === null
      ? Math.min(maxWeight, sampleSize / (sampleSize + scale))
      : Math.max(0, Math.min(1, Number(fixedWeight)));
  const probabilities = market.map(
    (value, index) =>
      value * (1 - empiricalWeight) + empirical[index] * empiricalWeight,
  );
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  return {
    probabilities: probabilities.map((value) => value / total),
    empiricalWeight,
    available: true,
  };
}

export function confidenceLabel(probabilities, sampleSize) {
  const sorted = [...probabilities].sort((a, b) => b - a);
  const lead = sorted[0] - sorted[1];
  if (sampleSize >= 120 && sorted[0] >= 0.58 && lead >= 0.14) return "较高";
  if (sampleSize >= 60 && sorted[0] >= 0.45 && lead >= 0.06) return "中等";
  return "谨慎";
}

function highestProbabilityLabels(labels, probabilities, available) {
  if (!available) return [];
  const highest = Math.max(...probabilities);
  return labels.filter(
    (_, index) => Math.abs(probabilities[index] - highest) < 1e-12,
  );
}

export function summarizeStability(points) {
  const safePoints = Array.isArray(points) ? points : [];
  const complete =
    safePoints.length > 0 &&
    safePoints.every(
      (point) =>
        point.available &&
        !point.isTie &&
        typeof point.predicted === "string" &&
        point.predicted.length > 0,
    );
  if (!complete) {
    return {
      status: "insufficient",
      stable: false,
      direction: null,
      points: safePoints,
    };
  }
  const directions = new Set(safePoints.map((point) => point.predicted));
  const stable = directions.size === 1;
  return {
    status: stable ? "stable" : "unstable",
    stable,
    direction: stable ? safePoints[0].predicted : null,
    points: safePoints,
  };
}

export function predictSpf(targetOdds, similarRows, blendOptions = {}) {
  const market = normalizeOdds(targetOdds);
  const weighted = weightedDistribution(
    similarRows,
    "result",
    OUTCOME_LABELS,
    blendOptions.weighting,
  );
  const stats = weighted.raw;
  const empirical = OUTCOME_LABELS.map(
    (label) => stats.probabilities[label],
  );
  const weightedEmpirical = OUTCOME_LABELS.map(
    (label) => weighted.probabilities[label],
  );
  const smoothing = smoothHistoricalDistribution(
    weightedEmpirical,
    stats.total,
    blendOptions.smoothing,
  );
  const modelEmpirical = smoothing.applied
    ? smoothing.probabilities
    : weightedEmpirical;
  const blended = blendPrediction(
    market,
    modelEmpirical,
    stats.total,
    blendOptions,
  );
  const topLabels = highestProbabilityLabels(
    OUTCOME_LABELS,
    blended.probabilities,
    blended.available,
  );
  return {
    labels: OUTCOME_LABELS,
    market,
    empirical,
    weightedEmpirical,
    stableEmpirical: smoothing.probabilities,
    smoothing,
    weighting: weighted,
    final: blended.probabilities,
    empiricalWeight: blended.empiricalWeight,
    available: blended.available,
    predicted: topLabels[0] || null,
    topLabels,
    isTie: topLabels.length > 1,
    confidence: blended.available
      ? confidenceLabel(
          blended.probabilities,
          weighted.effectiveSamples,
        )
      : "无样本",
    stats,
  };
}

function movementBlend(
  baseline,
  movementRows,
  {
    initialOdds,
    finalOdds,
    field,
    labels,
    minSamples = 12,
    maxWeight = 0.15,
    fixedWeight = null,
    applyCorrection = true,
    validation = null,
  },
) {
  const targetMovement = probabilityMovement(initialOdds, finalOdds);
  const trendStats = distribution(movementRows, field, labels);
  const trendEmpirical = labels.map(
    (label) => trendStats.probabilities[label],
  );
  if (!targetMovement.applied || trendStats.total < minSamples) {
    return {
      probabilities: [...baseline],
      movement: {
        ...targetMovement,
        applied: false,
        reason: targetMovement.applied
          ? "insufficient-samples"
          : targetMovement.reason,
        sampleSize: trendStats.total,
        minSamples,
        weight: 0,
        empirical: trendEmpirical,
        adjustment: baseline.map(() => 0),
        validation,
      },
    };
  }

  if (!applyCorrection) {
    return {
      probabilities: [...baseline],
      movement: {
        ...targetMovement,
        applied: false,
        referenceOnly: true,
        reason: "reference-only",
        sampleSize: trendStats.total,
        minSamples,
        weight: 0,
        empirical: trendEmpirical,
        adjustment: baseline.map(() => 0),
        validation,
      },
    };
  }

  const movementStrength = Math.min(1, targetMovement.magnitude / 0.01);
  const sampleStrength = trendStats.total / (trendStats.total + 200);
  const hasFixedWeight =
    fixedWeight !== null &&
    fixedWeight !== undefined &&
    Number.isFinite(Number(fixedWeight));
  const weight = hasFixedWeight
    ? Math.max(0, Math.min(1, Number(fixedWeight)))
    : Math.min(
        maxWeight,
        maxWeight * movementStrength * sampleStrength,
      );
  const probabilities = baseline.map(
    (value, index) =>
      value * (1 - weight) + trendEmpirical[index] * weight,
  );
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  const normalized = probabilities.map((value) => value / total);
  return {
    probabilities: normalized,
    movement: {
      ...targetMovement,
      applied: true,
      reason: "applied",
      sampleSize: trendStats.total,
      minSamples,
      weight,
      empirical: trendEmpirical,
      adjustment: normalized.map((value, index) => value - baseline[index]),
      validation,
    },
  };
}

export function predictSpfWithMovement(
  targetFinalOdds,
  similarRows,
  movementRows,
  targetInitialOdds,
  movementOptions = {},
) {
  const { blendOptions = {}, ...trendOptions } = movementOptions;
  const base = predictSpf(targetFinalOdds, similarRows, blendOptions);
  const adjusted = movementBlend(base.final, movementRows, {
    initialOdds: targetInitialOdds,
    finalOdds: targetFinalOdds,
    field: "result",
    labels: OUTCOME_LABELS,
    ...trendOptions,
  });
  const topLabels = highestProbabilityLabels(
    OUTCOME_LABELS,
    adjusted.probabilities,
    base.available,
  );
  return {
    ...base,
    baseline: base.final,
    final: adjusted.probabilities,
    predicted: topLabels[0] || null,
    topLabels,
    isTie: topLabels.length > 1,
    confidence: base.available
      ? confidenceLabel(
          adjusted.probabilities,
          base.weighting.effectiveSamples,
        )
      : "无样本",
    movement: adjusted.movement,
  };
}

export function predictGoals(targetOdds, similarRows, blendOptions = {}) {
  const market = normalizeOdds(targetOdds);
  const weighted = weightedDistribution(
    similarRows,
    "goals",
    GOAL_LABELS,
    blendOptions.weighting,
  );
  const stats = weighted.raw;
  const empirical = GOAL_LABELS.map(
    (label) => stats.probabilities[label],
  );
  const weightedEmpirical = GOAL_LABELS.map(
    (label) => weighted.probabilities[label],
  );
  const smoothing = smoothHistoricalDistribution(
    weightedEmpirical,
    stats.total,
    blendOptions.smoothing,
  );
  const modelEmpirical = smoothing.applied
    ? smoothing.probabilities
    : weightedEmpirical;
  const blended = blendPrediction(
    market,
    modelEmpirical,
    stats.total,
    blendOptions,
  );
  const topIndices = blended.available
    ? blended.probabilities
        .map((value, index) => ({ value, index }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 3)
        .map(({ index }) => GOAL_LABELS[index])
    : [];
  const topLabels = highestProbabilityLabels(
    GOAL_LABELS,
    blended.probabilities,
    blended.available,
  );
  const expected = expectedGoals(market);
  const historicalExpected = blended.available
    ? expectedGoals(blended.probabilities)
    : null;
  return {
    labels: GOAL_LABELS,
    market,
    empirical,
    weightedEmpirical,
    stableEmpirical: smoothing.probabilities,
    smoothing,
    weighting: weighted,
    final: blended.probabilities,
    empiricalWeight: blended.empiricalWeight,
    available: blended.available,
    predicted: topLabels[0] || null,
    topLabels,
    isTie: topLabels.length > 1,
    topThree: topIndices,
    goalPair: blended.available
      ? selectTopGoalPair(blended.probabilities, targetOdds)
      : selectTopGoalPair([]),
    expected,
    historicalExpected,
    stats,
  };
}

export function predictGoalsWithMovement(
  targetFinalOdds,
  similarRows,
  movementRows,
  targetInitialOdds,
  movementOptions = {},
) {
  const { blendOptions = {}, ...trendOptions } = movementOptions;
  const base = predictGoals(targetFinalOdds, similarRows, blendOptions);
  const adjusted = movementBlend(base.final, movementRows, {
    initialOdds: targetInitialOdds,
    finalOdds: targetFinalOdds,
    field: "goals",
    labels: GOAL_LABELS,
    minSamples: 12,
    maxWeight: 0.12,
    ...trendOptions,
  });
  const ranked = base.available
    ? adjusted.probabilities
        .map((value, index) => ({ value, index }))
        .sort((left, right) => right.value - left.value)
    : [];
  const topThree = ranked
    .slice(0, 3)
    .map(({ index }) => GOAL_LABELS[index]);
  const topLabels = highestProbabilityLabels(
    GOAL_LABELS,
    adjusted.probabilities,
    base.available,
  );
  const historicalExpected = base.available
    ? expectedGoals(adjusted.probabilities)
    : null;
  return {
    ...base,
    baseline: base.final,
    final: adjusted.probabilities,
    predicted: topLabels[0] || null,
    topLabels,
    isTie: topLabels.length > 1,
    topThree,
    goalPair: base.available
      ? selectTopGoalPair(adjusted.probabilities, targetFinalOdds)
      : selectTopGoalPair([]),
    expected: base.expected,
    historicalExpected,
    movement: adjusted.movement,
  };
}

export function paginate(rows, page = 1, pageSize = 20) {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * pageSize;
  return {
    rows: rows.slice(start, start + pageSize),
    page: safePage,
    pageSize,
    total: rows.length,
    totalPages,
  };
}
