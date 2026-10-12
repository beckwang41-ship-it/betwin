import assert from "node:assert/strict";
import test from "node:test";
import { HISTORY_TIMELINE_VERSION } from "../lib/history-timeline.mjs";
import {
  FORMAL_PRODUCTION_PROBABILITY_POLICY,
  FORMAL_PRODUCTION_THRESHOLDS,
  RELIABILITY_GATE_VERSION,
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
      gateVersion: RELIABILITY_GATE_VERSION,
      timelineVersion: HISTORY_TIMELINE_VERSION,
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
  assert.equal(reliabilityValidationIsCurrent(config({ timelineVersion: undefined }), state), false);
  // v1 门禁（只比命中率、不比市场）生成的配置必须失效并触发重验
  assert.equal(reliabilityValidationIsCurrent(config({ gateVersion: undefined }), state), false);
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

test("开启平滑不能继续沿用未平滑的可靠性验证", () => {
  assert.equal(reliabilityValidationIsCurrent(config(), { ...state, smoothingSignature: "hhad:smoothing-test" }), false);
  assert.equal(reliabilityValidationIsCurrent(config({ smoothingSignature: "hhad:smoothing-test" }), {
    ...state, smoothingSignature: "hhad:smoothing-test",
  }), true);
});
