import { ZERO_CELL_FLOOR_VERSION } from "./smoothing.mjs";

export const FORMAL_PRODUCTION_THRESHOLDS = Object.freeze({
  spf: 0.07,
  hhad: 0.07,
  goals: 0.015,
});

export const FORMAL_PRODUCTION_PROBABILITY_POLICY =
  `historical-similarity-v3-${ZERO_CELL_FLOOR_VERSION}`;

export function reliabilityValidationIsCurrent(
  config,
  {
    verifiedMatches,
    sourceUpdatedAt,
    matchingVersion,
    goalMatchingVersion,
    probabilityPolicy = FORMAL_PRODUCTION_PROBABILITY_POLICY,
    thresholds = FORMAL_PRODUCTION_THRESHOLDS,
  },
) {
  const configuredThresholds = config?.data?.thresholds || {};
  return Boolean(
    config?.data?.verifiedMatches === verifiedMatches &&
      config?.data?.sourceUpdatedAt === sourceUpdatedAt &&
      config?.data?.matchingVersion === matchingVersion &&
      config?.data?.goalMatchingVersion === goalMatchingVersion &&
      config?.data?.probabilityPolicy === probabilityPolicy &&
      Object.keys(thresholds).every(
        (market) =>
          Math.abs(
            Number(configuredThresholds[market]) - Number(thresholds[market]),
          ) <= 1e-12,
      ),
  );
}
