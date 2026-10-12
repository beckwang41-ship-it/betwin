import { predictSpf } from "./predictor.mjs";
import { DEFAULT_ZERO_CELL_PRIOR_MASS } from "./smoothing.mjs";
import { threeWayOddsDistance } from "./three-way-distance.mjs";
import { THREE_WAY_MATCHING_VERSION } from "./three-way-matching.mjs";

export const SPF_SHADOW_BASELINE = Object.freeze({
  method: "relative-max",
  threshold: 0.07,
});

export const SPF_SHADOW_CANDIDATE = Object.freeze({
  method: "hellinger",
  threshold: 0.04,
});

export const SPF_SHADOW_MODEL_VERSION =
  `spf-shadow-distance-v1:${THREE_WAY_MATCHING_VERSION}:` +
  `baseline-${SPF_SHADOW_BASELINE.method}-${SPF_SHADOW_BASELINE.threshold}:` +
  `candidate-${SPF_SHADOW_CANDIDATE.method}-${SPF_SHADOW_CANDIDATE.threshold}:` +
  `zero-floor-m${DEFAULT_ZERO_CELL_PRIOR_MASS}:all-leagues`;

function oddsFromMarket(market) {
  if (!market) return null;
  const odds = [market.h, market.d, market.a].map(Number);
  return odds.every((value) => Number.isFinite(value) && value > 1)
    ? odds
    : null;
}

function selectSpfSamples(match, histories, distancePolicy) {
  const hadOdds = oddsFromMarket(match?.had);
  if (!hadOdds) {
    return { available: false, mode: "missing-spf", samples: [] };
  }
  const hhadOdds = oddsFromMarket(match?.hhad);
  if (hhadOdds) {
    const handicap = Number(match.hhad.goalLine);
    const samples = (histories?.pairedHistory || [])
      .filter(
        (row) =>
          row?.spf &&
          row?.hhad &&
          Number(row.hhad.handicap) === handicap &&
          threeWayOddsDistance(
            row.spf.odds,
            hadOdds,
            distancePolicy.method,
          ) <= distancePolicy.threshold &&
          threeWayOddsDistance(
            row.hhad.odds,
            hhadOdds,
            distancePolicy.method,
          ) <= distancePolicy.threshold,
      )
      .map((row) => row.spf);
    return {
      available: samples.length > 0,
      mode: samples.length ? "joint" : "joint-unavailable",
      samples,
    };
  }
  const samples = (histories?.spfHistory || []).filter(
    (row) =>
      threeWayOddsDistance(row.odds, hadOdds, distancePolicy.method) <=
      distancePolicy.threshold,
  );
  return {
    available: samples.length > 0,
    mode: "standalone",
    samples,
  };
}

function frozenPrediction(odds, selection) {
  const prediction = predictSpf(odds, selection.samples, {
    empiricalOnly: true,
    requireSamples: true,
    weighting: { enabled: false },
    smoothing: { enabled: false, strength: 0 },
    zeroCellFloor: { priorMass: DEFAULT_ZERO_CELL_PRIOR_MASS },
  });
  return {
    available: Boolean(selection.available && prediction.available),
    matchingMode: selection.mode,
    samples: prediction.stats.total,
    probabilities: prediction.available ? prediction.final : [],
    topLabels: prediction.available ? prediction.topLabels : [],
    predicted: prediction.available ? prediction.topLabels.join(" / ") : null,
  };
}

export function buildSpfShadowComparison(match, histories) {
  const odds = oddsFromMarket(match?.had);
  if (!odds) return null;
  const baselineSelection = selectSpfSamples(
    match,
    histories,
    SPF_SHADOW_BASELINE,
  );
  const candidateSelection = selectSpfSamples(
    match,
    histories,
    SPF_SHADOW_CANDIDATE,
  );
  return {
    modelVersion: SPF_SHADOW_MODEL_VERSION,
    scope: "all-leagues",
    market: "spf",
    odds,
    baseline: {
      policy: SPF_SHADOW_BASELINE,
      ...frozenPrediction(odds, baselineSelection),
    },
    candidate: {
      policy: SPF_SHADOW_CANDIDATE,
      ...frozenPrediction(odds, candidateSelection),
    },
  };
}
