import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createShadowPredictionLedger } from "../lib/shadow-prediction-ledger.mjs";
import { SPF_SHADOW_MODEL_VERSION } from "../lib/three-way-shadow.mjs";

function snapshot(overrides = {}) {
  return {
    matchId: "shadow-001",
    modelVersion: SPF_SHADOW_MODEL_VERSION,
    capturedAt: "2026-09-02T01:00:00.000Z",
    sourceUpdatedAt: "2026-09-01T01:00:00.000Z",
    historySourceFile: "history.xlsx",
    historyRowWatermark: 100,
    league: "测试联赛",
    home: "主队",
    away: "客队",
    displayName: "主队 vs 客队",
    odds: [2.1, 3.2, 3.8],
    baseline: {
      available: true,
      matchingMode: "joint",
      samples: 30,
      probabilities: [0.55, 0.25, 0.2],
      topLabels: ["胜"],
    },
    candidate: {
      available: true,
      matchingMode: "joint",
      samples: 42,
      probabilities: [0.48, 0.3, 0.22],
      topLabels: ["胜"],
    },
    ...overrides,
  };
}

test("影子账本独立保存、结算并生成成对比较", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-shadow-"));
  const ledger = createShadowPredictionLedger(path.join(directory, "shadow.db"));
  try {
    assert.equal(ledger.record(snapshot()), true);
    assert.equal(ledger.record(snapshot()), false);
    assert.equal(
      ledger.record(
        snapshot({
          capturedAt: "2026-09-02T02:00:00.000Z",
          candidate: {
            ...snapshot().candidate,
            samples: 43,
          },
        }),
      ),
      true,
    );
    assert.equal(ledger.pending().length, 1);
    const [pending] = ledger.pending();
    assert.equal(pending.history_row_watermark, 100);
    assert.equal(pending.candidate_samples, 43);
    ledger.settle(pending.id, {
      actualResult: "胜",
      score: "2-0",
      sourceFile: "history.xlsx",
      sourceRow: 101,
      settledAt: "2026-09-02T03:00:00.000Z",
    });
    assert.equal(ledger.record(snapshot()), false);

    const report = ledger.summary();
    assert.equal(report.reportOnly, true);
    assert.equal(report.affectsProduction, false);
    assert.equal(report.totals.snapshots, 1);
    assert.equal(report.totals.settled, 1);
    assert.equal(report.totals.commonEvaluated, 1);
    assert.equal(report.baseline.accuracy, 1);
    assert.equal(report.candidate.accuracy, 1);
    assert.equal(report.reviewGate.enoughFreshSamples, false);
    assert.equal(report.reviewGate.eligibleForManualReview, false);
    assert.equal(report.reviewGate.productionChanged, false);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("影子模型首次启用只冻结水位，不回填当时已经存在的比赛", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-shadow-cutoff-"));
  const databasePath = path.join(directory, "shadow.db");
  const ledger = createShadowPredictionLedger(databasePath, {
    initialMatchIds: ["existing-001"],
    activatedAt: "2026-09-02T00:00:00.000Z",
  });
  try {
    assert.equal(
      ledger.record(snapshot({ matchId: "existing-001" })),
      false,
    );
    assert.equal(ledger.record(snapshot({ matchId: "future-001" })), true);
    const report = ledger.summary();
    assert.equal(report.totals.snapshots, 1);
    assert.equal(report.activation.activatedAt, "2026-09-02T00:00:00.000Z");
    assert.equal(report.activation.initialMatchesExcluded, 1);
    assert.equal(report.activation.backfillExistingMatches, false);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
