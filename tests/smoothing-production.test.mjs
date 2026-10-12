import assert from "node:assert/strict";
import test from "node:test";
import { resolveSmoothingProduction, SMOOTHING_VALIDATION_VERSION, smoothingPolicyToken, smoothingValidationSignature } from "../lib/smoothing-production.mjs";
import { HISTORY_TIMELINE_VERSION } from "../lib/history-timeline.mjs";

function candidate() {
  return {
    generatedAt: "2026-08-27T00:00:00.000Z",
    candidateOnly: true,
    data: {
      timelineVersion: HISTORY_TIMELINE_VERSION,
      validationVersion: SMOOTHING_VALIDATION_VERSION,
      verifiedMatches: 8171,
      sourceUpdatedAt: "2026-08-26T15:05:03+00:00",
      matchingVersion: "spf-hhad-joint-v1",
      goalMatchingVersion: "goal-zero-composite-v1",
    },
    markets: {
      spf: {
        candidateStrength: 20,
        gate: { passed: true },
        production: { relaxedMultiplier: 2, minLocalizedSamples: 30 },
      },
      hhad: {
        candidateStrength: 20,
        gate: { passed: true },
        production: { relaxedMultiplier: 2, minLocalizedSamples: 30 },
      },
      goals: {
        candidateStrength: 20,
        gate: { passed: false },
        production: { relaxedMultiplier: 2, minLocalizedSamples: 30 },
      },
    },
  };
}

function matchingApproval() {
  const value = candidate();
  return {
    runtimeEnabled: true,
    approvedAt: "2026-08-27T01:00:00.000Z",
    approvedArtifact: {
      generatedAt: value.generatedAt,
      ...value.data,
    },
    markets: {
      spf: { enabled: false, strength: 0 },
      hhad: { enabled: true, strength: 20 },
      goals: { enabled: false, strength: 0 },
    },
  };
}

test("平滑候选通过也不会在没有人工批准时自动上线", () => {
  const result = resolveSmoothingProduction(candidate(), {
    runtimeEnabled: false,
  });
  assert.equal(result.runtimeEnabled, false);
  assert.equal(result.status, "disabled");
  assert.equal(result.markets.spf.enabled, false);
  assert.equal(result.markets.hhad.enabled, false);
  assert.equal(result.markets.hhad.strength, 0);
  assert.equal(result.markets.hhad.referenceStrength, 20);
});

test("只有版本和数据水位完全匹配的人工批准才能启用指定玩法", () => {
  const result = resolveSmoothingProduction(candidate(), matchingApproval());
  assert.equal(result.runtimeEnabled, true);
  assert.equal(result.status, "approved");
  assert.equal(result.markets.spf.enabled, false);
  assert.equal(result.markets.hhad.enabled, true);
  assert.equal(result.markets.hhad.strength, 20);
  assert.equal(result.markets.goals.enabled, false);
});

test("过期候选或批准强度不一致时保持关闭", () => {
  const stale = resolveSmoothingProduction(candidate(), matchingApproval(), {
    candidateStale: true,
  });
  assert.equal(stale.runtimeEnabled, false);
  assert.equal(stale.status, "candidate-stale");

  const approval = matchingApproval();
  approval.markets.hhad.strength = 12;
  const mismatch = resolveSmoothingProduction(candidate(), approval);
  assert.equal(mismatch.runtimeEnabled, false);
  assert.equal(mismatch.status, "approval-mismatch");
  assert.equal(mismatch.markets.hhad.enabled, false);
});

test("旧回测协议不能凭已有人工批准重新启用", () => {
  const old = candidate();
  delete old.data.timelineVersion;
  assert.equal(resolveSmoothingProduction(old, matchingApproval()).runtimeEnabled, false);
  const approval = matchingApproval();
  delete approval.approvedArtifact.validationVersion;
  assert.equal(resolveSmoothingProduction(candidate(), approval).runtimeEnabled, false);
});

test("实际平滑规则进入版本，关闭或未验证范围不改变原模型版本", () => {
  const policy = { enabled: true, strength: 20 };
  const token = smoothingPolicyToken(policy);
  assert.match(token, /^:smoothing-/);
  assert.notEqual(token, smoothingPolicyToken({ ...policy, strength: 12 }));
  assert.notEqual(token, smoothingPolicyToken({ ...policy, minLocalizedSamples: 40 }));
  assert.equal(token, smoothingPolicyToken({ ...policy, referenceStrength: 3, reason: "说明变化" }));
  assert.equal(smoothingPolicyToken({ ...policy, enabled: false }), "");
  assert.equal(smoothingPolicyToken(policy, { sameLeague: true }), "");
  assert.equal(smoothingPolicyToken(policy, { usesRecommendedThreshold: false }), "");
  assert.equal(smoothingValidationSignature({}), "off");
  assert.notEqual(smoothingValidationSignature({ hhad: policy }), "off");
});
