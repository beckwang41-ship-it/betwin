import { ZERO_CELL_FLOOR_VERSION } from "./smoothing.mjs";
import { HISTORY_TIMELINE_VERSION } from "./history-timeline.mjs";

export const FORMAL_PRODUCTION_THRESHOLDS = Object.freeze({
  spf: 0.07,
  hhad: 0.07,
  goals: 0.015,
});

export const FORMAL_PRODUCTION_PROBABILITY_POLICY =
  `historical-similarity-v3-${ZERO_CELL_FLOOR_VERSION}`;

// v2：重点参考门禁要求筛出场次比去水市场概率更准（见 tuneReliabilityPolicy）。
// v1 配置只证明"命中率高于全体"，会把挑市场热门误当成模型能力，因此视为过期。
export const RELIABILITY_GATE_VERSION = "market-edge-v2";

export function reliabilityValidationIsCurrent(
  config,
  {
    verifiedMatches,
    sourceUpdatedAt,
    matchingVersion,
    goalMatchingVersion,
    probabilityPolicy = FORMAL_PRODUCTION_PROBABILITY_POLICY,
    smoothingSignature = "off",
    thresholds = FORMAL_PRODUCTION_THRESHOLDS,
  },
) {
  const configuredThresholds = config?.data?.thresholds || {};
  return Boolean(
    (config?.data?.smoothingSignature || "off") === smoothingSignature &&
    config?.data?.gateVersion === RELIABILITY_GATE_VERSION &&
    config?.data?.timelineVersion === HISTORY_TIMELINE_VERSION &&
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
