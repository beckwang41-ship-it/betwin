export const THREE_WAY_COHERENCE_VERSION = "score-margin-joint-v1";

const LABELS = ["胜", "平", "负"];

export function parseScoreMargin(score) {
  const matched = String(score ?? "")
    .trim()
    .match(/^(\d+)\s*[-:：]\s*(\d+)$/);
  if (!matched) return null;
  return Number(matched[1]) - Number(matched[2]);
}

export function settleMargin(margin, handicap = 0) {
  const adjusted = Number(margin) + Number(handicap);
  if (!Number.isFinite(adjusted)) return null;
  if (adjusted > 0) return "胜";
  if (adjusted < 0) return "负";
  return "平";
}

function possibleCells(handicap) {
  const bound = Math.max(8, Math.abs(Number(handicap)) + 4);
  const cells = new Map();
  for (let margin = -bound; margin <= bound; margin += 1) {
    const spf = settleMargin(margin, 0);
    const hhad = settleMargin(margin, handicap);
    const key = `${spf}\u0000${hhad}`;
    if (!cells.has(key)) {
      cells.set(key, { key, spf, hhad, count: 0, weight: 0 });
    }
  }
  return [...cells.values()];
}

function emptyMarket() {
  return {
    labels: [...LABELS],
    counts: [0, 0, 0],
    weightedCounts: [0, 0, 0],
    posteriorCounts: [0, 0, 0],
    rawProbabilities: [0, 0, 0],
    weightedProbabilities: [0, 0, 0],
    probabilities: [0, 0, 0],
  };
}

function marketFromCells(cells, field, sampleSize, totalWeight, denominator) {
  const market = emptyMarket();
  for (const cell of cells) {
    const index = LABELS.indexOf(cell[field]);
    market.counts[index] += cell.count;
    market.weightedCounts[index] += cell.weight;
    market.posteriorCounts[index] += cell.posteriorWeight;
    market.probabilities[index] += cell.probability;
  }
  market.rawProbabilities = market.counts.map((count) =>
    sampleSize ? count / sampleSize : 0,
  );
  market.weightedProbabilities = market.weightedCounts.map((weight) =>
    totalWeight ? weight / totalWeight : 0,
  );
  if (!denominator) market.probabilities = [0, 0, 0];
  return market;
}

function effectiveSampleSize(weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const squared = weights.reduce((sum, weight) => sum + weight ** 2, 0);
  return squared ? total ** 2 / squared : 0;
}

function apportionedDisplay(cells, units = 1000) {
  const apportioned = cells.map((cell, index) => {
    const exact = cell.probability * units;
    const whole = Math.floor(exact);
    return { index, whole, remainder: exact - whole };
  });
  let missing = units - apportioned.reduce((sum, cell) => sum + cell.whole, 0);
  for (const cell of [...apportioned].sort(
    (left, right) =>
      right.remainder - left.remainder || left.index - right.index,
  )) {
    if (missing <= 0) break;
    cell.whole += 1;
    missing -= 1;
  }
  const byIndex = new Map(apportioned.map((cell) => [cell.index, cell.whole]));
  const market = (field) => {
    const values = [0, 0, 0];
    cells.forEach((cell, index) => {
      values[LABELS.indexOf(cell[field])] += byIndex.get(index) || 0;
    });
    return values.map((value) => value / units);
  };
  return {
    precision: 3,
    units,
    spf: market("spf"),
    hhad: market("hhad"),
  };
}

function consistencyResidual(spf, hhad, handicap) {
  if (Number(handicap) === -1) {
    return Math.max(
      Math.abs(spf[0] - hhad[0] - hhad[1]),
      Math.abs(spf[1] + spf[2] - hhad[2]),
    );
  }
  if (Number(handicap) === 1) {
    return Math.max(
      Math.abs(spf[0] + spf[1] - hhad[0]),
      Math.abs(spf[2] - hhad[1] - hhad[2]),
    );
  }
  return 0;
}

export function buildCoherentThreeWayDistribution(
  rows,
  { handicap, priorMass = 1.5, weightField = "jointWeight" } = {},
) {
  const numericHandicap = Number(handicap);
  if (!Number.isInteger(numericHandicap)) {
    throw new TypeError("让球数必须是整数，才能构建统一净胜球分布");
  }

  const cells = possibleCells(numericHandicap);
  const cellsByKey = new Map(cells.map((cell) => [cell.key, cell]));
  const validWeights = [];
  let invalidScoreSamples = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const margin = parseScoreMargin(row?.score ?? row?.spf?.score);
    if (margin === null) {
      invalidScoreSamples += 1;
      continue;
    }
    const spf = settleMargin(margin, 0);
    const hhad = settleMargin(margin, numericHandicap);
    const cell = cellsByKey.get(`${spf}\u0000${hhad}`);
    if (!cell) {
      invalidScoreSamples += 1;
      continue;
    }
    const configuredWeight = Number(row?.[weightField]);
    const weight = Number.isFinite(configuredWeight) && configuredWeight > 0
      ? configuredWeight
      : 1;
    cell.count += 1;
    cell.weight += weight;
    validWeights.push(weight);
  }

  const sampleSize = validWeights.length;
  const totalWeight = validWeights.reduce((sum, weight) => sum + weight, 0);
  const safePriorMass = Math.max(0, Number(priorMass) || 0);
  const alpha = cells.length ? safePriorMass / cells.length : 0;
  const denominator = totalWeight + safePriorMass;

  for (const cell of cells) {
    cell.posteriorWeight = cell.weight + alpha;
    cell.probability = denominator ? cell.posteriorWeight / denominator : 0;
  }

  const spf = marketFromCells(
    cells,
    "spf",
    sampleSize,
    totalWeight,
    denominator,
  );
  const hhad = marketFromCells(
    cells,
    "hhad",
    sampleSize,
    totalWeight,
    denominator,
  );
  const maxResidual = sampleSize
    ? consistencyResidual(spf.probabilities, hhad.probabilities, numericHandicap)
    : 0;
  const display = sampleSize
    ? apportionedDisplay(cells)
    : { precision: 3, units: 1000, spf: [0, 0, 0], hhad: [0, 0, 0] };

  return {
    version: THREE_WAY_COHERENCE_VERSION,
    available: sampleSize > 0,
    handicap: numericHandicap,
    sampleSize,
    invalidScoreSamples,
    totalWeight,
    effectiveSamples: effectiveSampleSize(validWeights),
    prior: {
      applied: sampleSize > 0 && safePriorMass > 0,
      priorMass: safePriorMass,
      alpha,
      cellCount: cells.length,
      zeroCells: cells.filter((cell) => cell.count === 0).length,
    },
    cells,
    spf,
    hhad,
    display,
    consistency: {
      coherent: sampleSize > 0,
      method: "single-score-margin-distribution",
      maxResidual: maxResidual < 1e-15 ? 0 : maxResidual,
    },
  };
}
