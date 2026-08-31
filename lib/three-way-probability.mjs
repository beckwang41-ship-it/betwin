import {
  movementDistance,
  normalizeOdds,
  spfDistance,
} from "./predictor.mjs";

export const THREE_WAY_PROBABILITY_LABELS = ["胜", "平", "负"];

function validOdds(odds) {
  return (
    Array.isArray(odds) &&
    odds.length === 3 &&
    odds.every((value) => Number.isFinite(Number(value)) && Number(value) > 1)
  );
}

function normalizeWeights(weights) {
  const safe = weights.map((value) => Math.max(0, Number(value) || 0));
  const total = safe.reduce((sum, value) => sum + value, 0);
  return total ? safe.map((value) => value / total) : safe.map(() => 0);
}

export function impliedThreeWayProbabilities(odds) {
  return validOdds(odds) ? normalizeOdds(odds) : null;
}

export function uniformThreeWayProbabilities(samples) {
  if (!Array.isArray(samples) || !samples.length) return null;
  const counts = [0, 0, 0];
  for (const sample of samples) {
    const index = THREE_WAY_PROBABILITY_LABELS.indexOf(String(sample.result));
    if (index >= 0) counts[index] += 1;
  }
  const total = counts.reduce((sum, value) => sum + value, 0);
  return total ? counts.map((value) => value / total) : null;
}

export function compositeThreeWayDistance(
  sample,
  target,
  {
    finalWeight = 0.7,
    initialWeight = 0.15,
    movementWeight = 0.15,
    finalScale = 0.1,
    initialScale = 0.15,
    movementScale = 0.015,
  } = {},
) {
  if (!validOdds(sample?.odds) || !validOdds(target?.odds)) return null;
  const components = [
    {
      available: true,
      weight: finalWeight,
      distance:
        spfDistance(sample.odds, target.odds) /
        Math.max(Number(finalScale) || 0, Number.EPSILON),
    },
  ];
  const hasInitial = validOdds(sample.initialOdds) && validOdds(target.initialOdds);
  if (hasInitial) {
    components.push({
      available: true,
      weight: initialWeight,
      distance:
        spfDistance(sample.initialOdds, target.initialOdds) /
        Math.max(Number(initialScale) || 0, Number.EPSILON),
    });
    const trendDistance = movementDistance(
      sample.initialOdds,
      sample.odds,
      target.initialOdds,
      target.odds,
    );
    if (Number.isFinite(trendDistance)) {
      components.push({
        available: true,
        weight: movementWeight,
        distance:
          trendDistance /
          Math.max(Number(movementScale) || 0, Number.EPSILON),
      });
    }
  }
  const active = components.filter(
    (component) => component.available && component.weight > 0,
  );
  const totalWeight = active.reduce(
    (sum, component) => sum + component.weight,
    0,
  );
  if (!totalWeight) return null;
  return active.reduce(
    (sum, component) =>
      sum + (component.weight / totalWeight) * component.distance,
    0,
  );
}

export function weightedThreeWayProbabilities(
  samples,
  target,
  { decay = 1, ...distanceOptions } = {},
) {
  if (!Array.isArray(samples) || !samples.length) return null;
  const counts = [0, 0, 0];
  let totalWeight = 0;
  let squaredWeight = 0;
  let usableSamples = 0;
  let minimumWeight = Number.POSITIVE_INFINITY;
  let maximumWeight = 0;
  let coreSamples = 0;
  for (const sample of samples) {
    const index = THREE_WAY_PROBABILITY_LABELS.indexOf(String(sample.result));
    if (index < 0) continue;
    const distance = compositeThreeWayDistance(
      sample,
      target,
      distanceOptions,
    );
    if (!Number.isFinite(distance)) continue;
    const weight = Math.exp(-Math.max(0, Number(decay) || 0) * distance);
    counts[index] += weight;
    totalWeight += weight;
    squaredWeight += weight ** 2;
    usableSamples += 1;
    minimumWeight = Math.min(minimumWeight, weight);
    maximumWeight = Math.max(maximumWeight, weight);
    if (distance <= 0.5) coreSamples += 1;
  }
  if (!totalWeight) return null;
  return {
    probabilities: counts.map((value) => value / totalWeight),
    usableSamples,
    effectiveSamples: squaredWeight ? totalWeight ** 2 / squaredWeight : 0,
    totalWeight,
    minimumWeight: Number.isFinite(minimumWeight) ? minimumWeight : 0,
    maximumWeight,
    coreSamples,
  };
}

export function blendThreeWayProbabilities(
  historical,
  market,
  marketWeight = 0,
) {
  if (!historical && !market) return null;
  if (!historical) return [...market];
  if (!market) return [...historical];
  const weight = Math.min(1, Math.max(0, Number(marketWeight) || 0));
  return normalizeWeights(
    historical.map(
      (value, index) => value * (1 - weight) + market[index] * weight,
    ),
  );
}
