import { adjustedThreeWayProbabilities } from "./smoothing.mjs";

const V35_MIN_SAMPLES = 16;
const V35_TOP_N = 20;
const V35_STD_PROBABILITY = 0.1;
const V35_STD_TREND = 0.03;
const V35_TREND_WEIGHT = 2;
const V35_TIME_TAU = 600;

const LEAGUE_TIERS = {
  Tier1: [
    "德甲",
    "德乙",
    "荷甲",
    "荷乙",
    "澳甲",
    "挪超",
    "奥甲",
    "瑞典超",
    "日职",
    "韩职",
    "美职",
  ],
  Tier2: [
    "意甲",
    "意乙",
    "西乙",
    "法乙",
    "阿甲",
    "葡超",
    "希腊超",
    "俄超",
    "巴西甲",
    "解放者杯",
    "南美杯",
    "非洲杯",
  ],
  Tier3: [
    "英超",
    "西甲",
    "法甲",
    "英冠",
    "英甲",
    "欧冠",
    "欧罗巴",
    "欧协联",
    "世界杯",
    "欧洲杯",
    "亚洲杯",
    "美洲杯",
    "欧国联",
  ],
  Tier4: [
    "英足总杯",
    "英联杯",
    "足总杯",
    "国王杯",
    "德国杯",
    "意大利杯",
    "法国杯",
  ],
};

const SPF_LEAGUE_BASE = {
  Tier1: [0.424, 0.25, 0.326],
  Tier2: [0.39, 0.279, 0.331],
  Tier3: [0.449, 0.24, 0.311],
  Tier4: [0.392, 0.234, 0.374],
  Other: [0.431, 0.24, 0.328],
};

function validOdds(odds) {
  return (
    Array.isArray(odds) &&
    odds.length === 3 &&
    odds.every((odd) => Number.isFinite(Number(odd)) && Number(odd) > 0)
  );
}

function normalize(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return total > 0 ? values.map((value) => value / total) : null;
}

export function plainProbabilities(odds) {
  if (!validOdds(odds)) return null;
  return normalize(odds.map((odd) => 1 / Number(odd)));
}

export function v35TrueProbabilities(odds, market) {
  return adjustedThreeWayProbabilities(odds, market);
}

export function assignV35Tier(league) {
  const value = String(league || "");
  for (const [tier, keywords] of Object.entries(LEAGUE_TIERS)) {
    if (keywords.some((keyword) => value.includes(keyword))) return tier;
  }
  return "Other";
}

function sameTierLeague(league, tier) {
  return (LEAGUE_TIERS[tier] || []).some((keyword) =>
    String(league || "").includes(keyword),
  );
}

function normalizedHandicap(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 4) / 4 : null;
}

function trend(odds, initialOdds, index) {
  if (!validOdds(initialOdds)) return 0;
  const initial = Number(initialOdds[index]);
  return initial ? (Number(odds[index]) - initial) / initial : 0;
}

function selectLeaguePool(history, target) {
  const exact = history.filter(
    (row) => String(row.league) === String(target.league),
  );
  if (exact.length >= 20) return { pool: exact, scope: "league" };
  const tier = assignV35Tier(target.league);
  if (tier !== "Other") {
    const tierPool = history.filter((row) => sameTierLeague(row.league, tier));
    if (tierPool.length > 50) return { pool: tierPool, scope: "tier" };
  }
  return { pool: exact, scope: "league-small" };
}

function probabilityDistance(history, target, market, historyProbabilityMode) {
  const historyProbabilities =
    historyProbabilityMode === "symmetric"
      ? v35TrueProbabilities(history.odds, market)
      : plainProbabilities(history.odds);
  const targetProbabilities = v35TrueProbabilities(target.odds, market);
  if (!historyProbabilities || !targetProbabilities) return null;
  return historyProbabilities.reduce((sum, value, index) => {
    const delta = (value - targetProbabilities[index]) / V35_STD_PROBABILITY;
    return sum + delta * delta;
  }, 0);
}

export function selectV35Samples(
  history,
  target,
  market,
  { historyProbabilityMode = "original" } = {},
) {
  if (!validOdds(target?.odds)) return null;
  const targetHandicap = normalizedHandicap(target.handicap);
  if (targetHandicap === null) return null;
  const { pool: leaguePool, scope } = selectLeaguePool(history, target);
  const candidatePool = leaguePool.filter((row) => {
    const handicap = normalizedHandicap(row.handicap);
    if (handicap === null || Math.abs(handicap - targetHandicap) > 0.01) {
      return false;
    }
    if (!validOdds(row.odds)) return false;
    return (
      Number(row.odds[0]) >= Number(target.odds[0]) * 0.85 &&
      Number(row.odds[0]) <= Number(target.odds[0]) * 1.15 &&
      Number(row.odds[2]) >= Number(target.odds[2]) * 0.85 &&
      Number(row.odds[2]) <= Number(target.odds[2]) * 1.15
    );
  });
  if (candidatePool.length < V35_MIN_SAMPLES) return null;

  const targetWinTrend = trend(target.odds, target.initialOdds, 0);
  const targetLossTrend = trend(target.odds, target.initialOdds, 2);
  const ranked = candidatePool
    .map((row) => {
      const structureSquared = probabilityDistance(
        row,
        target,
        market,
        historyProbabilityMode,
      );
      if (structureSquared === null) return null;
      const winDelta =
        (trend(row.odds, row.initialOdds, 0) - targetWinTrend) / V35_STD_TREND;
      const lossDelta =
        (trend(row.odds, row.initialOdds, 2) - targetLossTrend) / V35_STD_TREND;
      const distance = Math.sqrt(
        structureSquared +
          V35_TREND_WEIGHT * (winDelta * winDelta + lossDelta * lossDelta),
      );
      const age = Math.max(0, Number(target.sourceRow) - Number(row.sourceRow));
      const weight =
        (1 / (distance + 0.05)) * Math.exp(-age / V35_TIME_TAU);
      return { ...row, distance, weight };
    })
    .filter(Boolean)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, V35_TOP_N);
  if (!ranked.length) return null;
  return { samples: ranked, candidateSamples: candidatePool.length, scope };
}

export function v35Prediction(
  history,
  target,
  market,
  { historyProbabilityMode = "original" } = {},
) {
  const selection = selectV35Samples(history, target, market, {
    historyProbabilityMode,
  });
  if (!selection) return null;
  const smoothed = v35SmoothedSamples(selection.samples, target, market, {
    weighted: true,
  });
  if (!smoothed) return null;
  return {
    ...smoothed,
    samples: selection.samples,
    sampleSize: selection.samples.length,
    candidateSamples: selection.candidateSamples,
    scope: selection.scope,
    historyProbabilityMode,
  };
}

export function v35SmoothedSamples(
  samples,
  target,
  market,
  { weighted = true } = {},
) {
  if (!samples?.length) return null;
  const weightedCounts = [0, 0, 0];
  const labels = ["胜", "平", "负"];
  let totalWeight = 0;
  let squaredWeight = 0;
  for (const sample of samples) {
    const index = labels.indexOf(String(sample.result));
    const weight = weighted ? Number(sample.weight) : 1;
    if (index < 0 || !Number.isFinite(weight) || weight <= 0) continue;
    weightedCounts[index] += weight;
    totalWeight += weight;
    squaredWeight += weight * weight;
  }
  if (!totalWeight) return null;
  const effectiveSamples = squaredWeight
    ? (totalWeight * totalWeight) / squaredWeight
    : 0;
  const smoothingStrength = Math.max(
    1,
    Math.min(20, 20 / Math.max(effectiveSamples, 0.5)),
  );
  const prior =
    market === "spf"
      ? SPF_LEAGUE_BASE[assignV35Tier(target.league)]
      : v35TrueProbabilities(target.odds, "hhad");
  const probabilities = weightedCounts.map(
    (value, index) =>
      (value + smoothingStrength * prior[index]) /
      (totalWeight + smoothingStrength),
  );
  return {
    probabilities,
    effectiveSamples,
    smoothingStrength,
  };
}

export const V35_COMPARISON_PARAMETERS = Object.freeze({
  minimumSamples: V35_MIN_SAMPLES,
  topN: V35_TOP_N,
  probabilityScale: V35_STD_PROBABILITY,
  trendScale: V35_STD_TREND,
  trendWeight: V35_TREND_WEIGHT,
  timeTau: V35_TIME_TAU,
});
