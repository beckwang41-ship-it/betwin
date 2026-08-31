import assert from "node:assert/strict";
import test from "node:test";
import {
  FORMAL_PRODUCTION_PROBABILITY_POLICY,
  FORMAL_PRODUCTION_THRESHOLDS,
  reliabilityValidationIsCurrent,
} from "../lib/reliability-validation.mjs";

const state = {
  verifiedMatches: 8122,
  sourceUpdatedAt: "2026-08-23T03:46:06+00:00",
  matchingVersion: "spf-hhad-joint-v1",
  goalMatchingVersion: "goal-zero-composite-v1",
  probabilityPolicy: FORMAL_PRODUCTION_PROBABILITY_POLICY,
  thresholds: FORMAL_PRODUCTION_THRESHOLDS,
};

function config(overrides = {}) {
  return {
    data: {
      verifiedMatches: state.verifiedMatches,
      sourceUpdatedAt: state.sourceUpdatedAt,
      matchingVersion: state.matchingVersion,
      goalMatchingVersion: state.goalMatchingVersion,
      probabilityPolicy: state.probabilityPolicy,
      thresholds: { ...FORMAL_PRODUCTION_THRESHOLDS },
      ...overrides,
    },
  };
}

test("正式规则验证仅在数据、匹配器和固定阈值全部一致时有效", () => {
  assert.equal(reliabilityValidationIsCurrent(config(), state), true);
  assert.equal(
    reliabilityValidationIsCurrent(
      config({ verifiedMatches: state.verifiedMatches + 1 }),
      state,
    ),
    false,
  );
  assert.equal(
    reliabilityValidationIsCurrent(
      config({ thresholds: { ...FORMAL_PRODUCTION_THRESHOLDS, spf: 0.1 } }),
      state,
    ),
    false,
  );
  assert.equal(
    reliabilityValidationIsCurrent(
      config({ probabilityPolicy: "historical-similarity-v3" }),
      state,
    ),
    false,
  );
});
