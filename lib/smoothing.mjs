function emptyCounts(labels) {
  return Object.fromEntries(labels.map((label) => [label, 0]));
}

function countOutcomes(rows, labels, outcomeField) {
  const counts = emptyCounts(labels);
  for (const row of rows) {
    const label = String(row?.[outcomeField] ?? "");
    if (label in counts) counts[label] += 1;
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    counts,
    total,
    probabilities: labels.map((label) =>
      total ? counts[label] / total : 1 / labels.length,
    ),
  };
}

function sourceLabel(source) {
  return {
    "same-league-nearby": "同联赛宽赔率带",
    "all-leagues-nearby": "全联赛宽赔率带",
    "same-league-all": "同联赛全部历史",
    "all-history": "全部历史基础分布",
    uniform: "均匀先验",
  }[source] || source;
}

export function selectHistoricalPrior(
  history,
  target,
  {
    labels,
    outcomeField,
    distance,
    compatible = () => true,
    relaxedTolerance,
    minLocalizedSamples = 30,
  },
) {
  const valid = history.filter(
    (row) =>
      compatible(row, target) &&
      labels.includes(String(row?.[outcomeField] ?? "")),
  );
  const nearby = valid.filter(
    (row) => distance(row, target) <= relaxedTolerance,
  );
  const sameLeague = valid.filter(
    (row) => row.league && row.league === target.league,
  );
  const sameLeagueNearby = nearby.filter(
    (row) => row.league && row.league === target.league,
  );
  const minimum = Math.max(1, Math.trunc(minLocalizedSamples));

  let rows = valid;
  let source = "all-history";
  if (sameLeagueNearby.length >= minimum) {
    rows = sameLeagueNearby;
    source = "same-league-nearby";
  } else if (nearby.length >= minimum) {
    rows = nearby;
    source = "all-leagues-nearby";
  } else if (sameLeague.length >= minimum) {
    rows = sameLeague;
    source = "same-league-all";
  }

  if (!rows.length) {
    return {
      source: "uniform",
      sourceLabel: sourceLabel("uniform"),
      sampleSize: 0,
      counts: emptyCounts(labels),
      probabilities: labels.map(() => 1 / labels.length),
      relaxedTolerance,
      minLocalizedSamples: minimum,
    };
  }

  const stats = countOutcomes(rows, labels, outcomeField);
  return {
    source,
    sourceLabel: sourceLabel(source),
    sampleSize: stats.total,
    counts: stats.counts,
    probabilities: stats.probabilities,
    relaxedTolerance,
    minLocalizedSamples: minimum,
  };
}

export function smoothHistoricalDistribution(
  empirical,
  sampleSize,
  {
    enabled = false,
    strength = 0,
    prior = null,
    validated = false,
    reason = "",
  } = {},
) {
  const safeSampleSize = Math.max(0, Number(sampleSize) || 0);
  const safeStrength = Math.max(0, Number(strength) || 0);
  const fallback = empirical.map(() => 1 / Math.max(1, empirical.length));
  const priorProbabilities =
    Array.isArray(prior?.probabilities) &&
    prior.probabilities.length === empirical.length
      ? prior.probabilities
      : fallback;
  const priorTotal = priorProbabilities.reduce(
    (sum, value) => sum + Math.max(0, Number(value) || 0),
    0,
  );
  const normalizedPrior = priorProbabilities.map((value) =>
    priorTotal ? Math.max(0, Number(value) || 0) / priorTotal : 1 / empirical.length,
  );
  const stable =
    safeSampleSize > 0 && safeStrength > 0
      ? empirical.map(
          (value, index) =>
            (safeSampleSize * value +
              safeStrength * normalizedPrior[index]) /
            (safeSampleSize + safeStrength),
        )
      : [...empirical];
  const applied = Boolean(enabled && safeSampleSize > 0 && safeStrength > 0);

  return {
    applied,
    referenceOnly: !applied && safeSampleSize > 0 && safeStrength > 0,
    validated: Boolean(validated),
    strength: safeStrength,
    prior: {
      source: prior?.source || "uniform",
      sourceLabel: prior?.sourceLabel || sourceLabel("uniform"),
      sampleSize: Number(prior?.sampleSize || 0),
      counts: prior?.counts || null,
      probabilities: normalizedPrior,
      relaxedTolerance: prior?.relaxedTolerance ?? null,
      minLocalizedSamples: prior?.minLocalizedSamples ?? null,
    },
    probabilities: stable,
    adjustment: stable.map((value, index) => value - empirical[index]),
    reason,
  };
}
