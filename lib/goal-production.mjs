import {
  GOAL_ZERO_BANDS,
  GOAL_ZERO_ODDS_TOLERANCE,
  SAME_LEAGUE_GOAL_ZERO_ODDS_TOLERANCE,
  findSimilarByGoalBand,
} from "./goal-zero-odds.mjs";
import { predictGoals } from "./predictor.mjs";

export const PRODUCTION_GOAL_POOL_FRACTIONS = [0.25, 0.5, 0.75, 1];

export function selectProductionGoalSimilarity(
  history,
  target,
  {
    intervals = GOAL_ZERO_BANDS,
    policies = {},
    sameLeague = false,
    zeroOddsTolerance = sameLeague
      ? SAME_LEAGUE_GOAL_ZERO_ODDS_TOLERANCE
      : GOAL_ZERO_ODDS_TOLERANCE,
  } = {},
) {
  return findSimilarByGoalBand(history, target?.odds || [], {
    intervals,
    policies,
    zeroOddsTolerance,
    targetInitialOdds: target?.initialOdds || null,
    league: target?.league || "",
    sameLeague,
  });
}

export function productionGoalWeightingOptions(resolved) {
  return {
    enabled: true,
    weightField: "similarityWeight",
    method:
      resolved?.weighting?.method || "exponential-composite-distance",
    tolerance: resolved?.weighting?.bandwidth || 1,
    floor: 0.01,
    power: 1,
    coreRatio: 0.5,
  };
}

export function predictProductionGoals(
  targetOdds,
  resolved,
  { samples = resolved?.similar || [], blendOptions = {} } = {},
) {
  return predictGoals(targetOdds, samples, {
    ...blendOptions,
    weighting: productionGoalWeightingOptions(resolved),
  });
}

export function productionGoalFeaturePools(
  history,
  target,
  options = {},
) {
  const resolved = selectProductionGoalSimilarity(history, target, options);
  return {
    resolved,
    pools: PRODUCTION_GOAL_POOL_FRACTIONS.map((fraction) => {
      const sampleCount = resolved.similar.length
        ? Math.max(1, Math.ceil(resolved.similar.length * fraction))
        : 0;
      if (!sampleCount) {
        return {
          fraction,
          sampleCount: 0,
          effectiveSampleSize: 0,
          probabilities: [],
        };
      }
      const model = predictProductionGoals(target.odds, resolved, {
        samples: resolved.similar.slice(0, sampleCount),
        blendOptions: { empiricalOnly: true, requireSamples: true },
      });
      return {
        fraction,
        sampleCount,
        effectiveSampleSize: Number(model.weighting?.effectiveSamples || 0),
        probabilities: model.final.map(Number),
      };
    }),
  };
}
