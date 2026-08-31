import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateArtifact,
  resolveProductionApproval,
} from "../lib/production-approval.mjs";

function candidate({ strategyPassed = true, gatePassed = true } = {}) {
  return {
    generatedAt: "2026-08-28T03:38:00.000Z",
    // 故意设为 true：候选文件的这个字段必须被完全忽略。
    runtimeEnabled: true,
    data: { verifiedMatches: 9003, sourceUpdatedAt: "2026-08-26T15:05:03+00:00" },
    methodology: { matchingVersion: "v3", goalMatchingVersion: "g1" },
    markets: {
      spf: {
        minSamples: 100,
        thresholds: [0.03, 0.05, 0.07],
        gate: { passed: gatePassed },
        selected: {
          strategy: {
            passed: strategyPassed,
            status: strategyPassed ? "better" : "uncertain",
            roiDelta: strategyPassed ? 0.012 : 0.0012,
          },
        },
      },
    },
  };
}

const OPTIONS = {
  markets: ["spf"],
  moduleLabel: "动态范围",
  paramsOf: (node) => ({
    minSamples: node?.minSamples ?? null,
    thresholds: node?.thresholds ?? [],
  }),
  approvedParamsOf: (node) => ({
    minSamples: node?.minSamples ?? null,
    thresholds: node?.thresholds ?? [],
  }),
};

function approval(overrides = {}) {
  return {
    runtimeEnabled: true,
    approvedAt: "2026-08-28T04:00:00.000Z",
    approvedArtifact: candidateArtifact(candidate()),
    markets: {
      spf: { enabled: true, minSamples: 100, thresholds: [0.03, 0.05, 0.07] },
    },
    ...overrides,
  };
}

test("candidate runtimeEnabled cannot enable production on its own", () => {
  // 候选文件 runtimeEnabled=true，但没有独立批准文件 → 必须保持关闭。
  const result = resolveProductionApproval(candidate(), {}, OPTIONS);
  assert.equal(result.runtimeEnabled, false);
  assert.equal(result.markets.spf.enabled, false);
  assert.equal(result.status, "disabled");
  assert.match(result.reason, /尚未人工批准上线/);
});

test("approval enables production only when both gates pass", () => {
  const result = resolveProductionApproval(candidate(), approval(), OPTIONS);
  assert.equal(result.runtimeEnabled, true);
  assert.equal(result.markets.spf.enabled, true);
  assert.equal(result.markets.spf.probabilityPassed, true);
  assert.equal(result.markets.spf.strategyPassed, true);
  assert.deepEqual(result.enabledMarkets, ["spf"]);
});

test("failed ROI gate blocks production even with manual approval", () => {
  const failed = candidate({ strategyPassed: false });
  const result = resolveProductionApproval(
    failed,
    approval({ approvedArtifact: candidateArtifact(failed) }),
    OPTIONS,
  );
  assert.equal(result.runtimeEnabled, false);
  assert.equal(result.status, "gates-blocked");
  assert.equal(result.markets.spf.probabilityPassed, true);
  assert.equal(result.markets.spf.strategyPassed, false);
  assert.equal(result.markets.spf.strategyStatus, "uncertain");
  assert.match(result.markets.spf.reason, /未通过投注ROI门禁/);
});

test("missing ROI evaluation is treated as not passing", () => {
  const bare = candidate();
  delete bare.markets.spf.selected;
  const result = resolveProductionApproval(
    bare,
    approval({ approvedArtifact: candidateArtifact(bare) }),
    OPTIONS,
  );
  assert.equal(result.runtimeEnabled, false);
  assert.equal(result.markets.spf.strategyStatus, "not-run");
  assert.match(result.markets.spf.reason, /尚未运行投注ROI门禁/);
});

test("failed probability gate blocks production even when ROI passes", () => {
  const failed = candidate({ gatePassed: false });
  const result = resolveProductionApproval(
    failed,
    approval({ approvedArtifact: candidateArtifact(failed) }),
    OPTIONS,
  );
  assert.equal(result.runtimeEnabled, false);
  assert.match(result.markets.spf.reason, /未通过概率门禁/);
});

test("stale candidate and artifact drift both block production", () => {
  const stale = resolveProductionApproval(candidate(), approval(), {
    ...OPTIONS,
    candidateStale: true,
  });
  assert.equal(stale.status, "candidate-stale");
  assert.equal(stale.runtimeEnabled, false);

  const drifted = resolveProductionApproval(
    candidate(),
    approval({
      approvedArtifact: {
        ...candidateArtifact(candidate()),
        verifiedMatches: 8000,
      },
    }),
    OPTIONS,
  );
  assert.equal(drifted.status, "approval-mismatch");
  assert.equal(drifted.runtimeEnabled, false);
});

test("parameter drift between approval and candidate blocks production", () => {
  const result = resolveProductionApproval(
    candidate(),
    approval({
      markets: { spf: { enabled: true, minSamples: 150, thresholds: [0.03] } },
    }),
    OPTIONS,
  );
  assert.equal(result.runtimeEnabled, false);
  assert.equal(result.markets.spf.paramsMatch, false);
  assert.match(result.markets.spf.reason, /参数与当前候选参数不一致/);
});

test("gate evidence drift invalidates an approval even when metadata is unchanged", () => {
  const changed = candidate();
  changed.markets.spf.gate.passed = false;
  const result = resolveProductionApproval(changed, approval(), OPTIONS);

  assert.equal(result.runtimeEnabled, false);
  assert.equal(result.approvalCurrent, false);
  assert.equal(result.status, "approval-mismatch");
});
