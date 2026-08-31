import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPredictionLedger } from "../lib/prediction-ledger.mjs";

function snapshot(overrides = {}) {
  return {
    matchId: "fixture-001",
    policyVersion: "selection-v3@test",
    algorithmVersion: "historical-similarity-v3:spf:test-algorithm",
    dataVersion: "history@2026-07-26T01:00:00.000Z",
    validationStatus: "validated",
    market: "spf",
    handicap: null,
    capturedAt: "2026-07-27T01:00:00.000Z",
    sourceUpdatedAt: "2026-07-26T01:00:00.000Z",
    historySourceFile: "历史进球.xlsx",
    historyRowWatermark: 100,
    league: "英超",
    home: "主队",
    away: "客队",
    displayName: "主队 vs 客队",
    predicted: "胜",
    topLabels: ["胜"],
    selectedProbability: 0.62,
    selectedOdds: 2.1,
    probabilities: [0.62, 0.22, 0.16],
    odds: [2.1, 3.2, 3.8],
    reliabilityLevel: "recommended",
    reliabilityLabel: "建议预测",
    reliabilityReason: "最新测试通过",
    threshold: 0.07,
    samples: 37,
    settings: {
      spfTolerance: 0.07,
      sameLeague: false,
      diagnostics: { initialOdds: [3.5, 3.2, 2.1] },
    },
    ...overrides,
  };
}

test("账本快照不可重复，并能结算命中与模拟盈亏", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-ledger-"));
  const ledger = createPredictionLedger(path.join(directory, "ledger.db"));
  try {
    assert.equal(ledger.record(snapshot()), true);
    assert.equal(ledger.record(snapshot()), false);
    assert.equal(
      ledger.record(
        snapshot({
          policyVersion: "selection-v4@before-result",
          capturedAt: "2026-07-27T02:00:00.000Z",
          predicted: "负",
          topLabels: ["负"],
          selectedProbability: 0.55,
          selectedOdds: 3.8,
          probabilities: [0.25, 0.2, 0.55],
        }),
      ),
      true,
    );

    let summary = ledger.summary();
    assert.equal(summary.totals.fixtures, 1);
    assert.equal(summary.totals.pendingFixtures, 1);
    assert.equal(summary.totals.settledFixtures, 0);
    assert.equal(summary.totals.snapshots, 1);
    assert.equal(summary.totals.pending, 1);
    assert.equal(summary.byReliability.recommended.accuracy, null);
    assert.equal(summary.rows[0].policyVersion, "selection-v4@before-result");
    assert.equal(
      summary.rows[0].algorithmVersion,
      "historical-similarity-v3:spf:test-algorithm",
    );
    assert.equal(
      summary.rows[0].dataVersion,
      "history@2026-07-26T01:00:00.000Z",
    );
    assert.equal(summary.rows[0].validationStatus, "validated");
    assert.equal(summary.rows[0].capturedAt, "2026-07-27T02:00:00.000Z");
    assert.equal(summary.rows[0].predicted, "负");
    assert.equal(summary.rows[0].selectedOdds, 3.8);

    const [pending] = ledger.pending();
    ledger.settle(pending.id, {
      actualResult: "负",
      score: "2:0",
      correct: true,
      selectedOdds: pending.selected_odds,
      sourceFile: "历史进球.xlsx",
      sourceRow: 101,
      settledAt: "2026-07-27T03:00:00.000Z",
    });
    assert.equal(
      ledger.record(
        snapshot({
          policyVersion: "selection-v4@after-result",
          capturedAt: "2026-07-28T01:00:00.000Z",
        }),
      ),
      false,
    );

    summary = ledger.summary();
    assert.equal(summary.totals.pending, 0);
    assert.equal(summary.totals.settled, 1);
    assert.equal(summary.totals.pendingFixtures, 0);
    assert.equal(summary.totals.settledFixtures, 1);
    assert.equal(summary.byReliability.recommended.accuracy, 1);
    assert.equal(summary.byReliability.recommended.simulatedProfit, 2.8);
    assert.equal(summary.overall.sampleLevel, "insufficient");
    assert.equal(summary.overall.accuracyLow, 0.2065);
    assert.equal(summary.overall.accuracyHigh, 1);
    assert.equal(summary.calibration.settled, 1);
    assert.equal(summary.calibration.bins[2].settled, 1);
    assert.equal(summary.calibration.bins[2].predictedAverage, 0.55);
    assert.equal(summary.calibration.bins[2].actualAccuracy, 1);
    assert.equal(summary.oddsBenchmark.byMarketScope.spf.all.compared, 1);
    assert.equal(summary.oddsBenchmark.byMarketScope.spf.all.modelCorrect, 1);
    assert.equal(summary.oddsBenchmark.byMarketScope.spf.all.oddsCorrect, 0);
    assert.equal(summary.oddsBenchmark.byMarketScope.spf.all.netWins, 1);
    assert.equal(summary.oddsBenchmark.byMarketScope.spf.all.lift, 1);
    assert.equal(
      summary.oddsBenchmark.byMarketScope.spf.all.liftMethod,
      "chronological-block-bootstrap",
    );
    assert.equal(
      summary.oddsBenchmark.byMarketScope.spf.all.liftIterations,
      1000,
    );
    assert.equal(
      summary.oddsBenchmark.byMarketScope.spf.all.liftImprovementProbability,
      1,
    );
    assert.equal(
      summary.oddsBenchmark.byMarketScope.spf.all.liftStatus,
      "insufficient",
    );
    assert.equal(summary.errorDiagnosis.overall.settled, 1);
    assert.equal(summary.errorDiagnosis.overall.misses, 0);
    assert.equal(summary.errorDiagnosis.byMarket.spf.accuracy, 1);
    assert.equal(summary.errorDiagnosis.byOddsBand[3].label, "3.01以上");
    assert.equal(summary.errorDiagnosis.byOddsBand[3].settled, 1);
    assert.equal(summary.errorDiagnosis.byLeague[0].label, "英超");
    assert.equal(summary.errorDiagnosis.oddsDirection.different.settled, 1);
    assert.equal(summary.errorDiagnosis.oddsDirection.different.accuracy, 1);
    assert.equal(summary.errorDiagnosis.movementDirection.changed.settled, 1);
    assert.equal(summary.errorDiagnosis.movementDirection.unavailable, 0);
    assert.deepEqual(summary.errorDiagnosis.confusion.spf.labels, ["胜", "平", "负"]);
    assert.equal(summary.errorDiagnosis.confusion.spf.singlePredictions, 1);
    assert.equal(summary.errorDiagnosis.confusion.spf.matrix[2][2], 1);
    assert.equal(summary.errorDiagnosis.confusion.spf.topErrors.length, 0);
    assert.equal(summary.errorDiagnosis.confusion.goals.singlePredictions, 0);
    assert.equal(summary.rows[0].correct, true);
    assert.equal(summary.rows[0].score, "2:0");

    const drilldown = ledger.summary({
      status: "settled",
      market: "spf",
      predicted: "负",
      actual: "负",
    });
    assert.equal(drilldown.filtered.fixtures, 1);
    assert.equal(drilldown.rows.length, 1);
    assert.equal(
      ledger.summary({ predicted: "胜", actual: "负" }).filtered.fixtures,
      0,
    );
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("更新待结算预测时保留首次留档的历史行水位", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-ledger-"));
  const ledger = createPredictionLedger(path.join(directory, "ledger.db"));
  try {
    assert.equal(ledger.record(snapshot({ historyRowWatermark: 100 })), true);
    assert.equal(
      ledger.record(
        snapshot({
          capturedAt: "2026-07-28T01:00:00.000Z",
          historyRowWatermark: 120,
          predicted: "平",
          topLabels: ["平"],
          selectedProbability: 0.51,
          selectedOdds: 3.2,
        }),
      ),
      true,
    );

    const [pending] = ledger.pending();
    assert.equal(pending.captured_at, "2026-07-28T01:00:00.000Z");
    assert.equal(pending.predicted, "平");
    assert.equal(pending.history_row_watermark, 100);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("单场账本按比赛筛选并分页，汇总数字使用同一筛选结果", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-ledger-page-"));
  const ledger = createPredictionLedger(path.join(directory, "ledger.db"));
  try {
    for (let index = 1; index <= 3; index += 1) {
      ledger.record(
        snapshot({
          matchId: `fixture-00${index}`,
          capturedAt: `2026-07-2${index}T01:00:00.000Z`,
          home: `主队${index}`,
          away: `客队${index}`,
          displayName: `主队${index} vs 客队${index}`,
        }),
      );
    }
    const page = ledger.summary({ status: "pending", page: 2, pageSize: 2 });
    assert.equal(page.totals.fixtures, 3);
    assert.equal(page.filtered.fixtures, 3);
    assert.equal(page.page.totalItems, 3);
    assert.equal(page.page.totalPages, 2);
    assert.equal(page.rows.length, 1);

    const searched = ledger.summary({ query: "主队2", pageSize: 20 });
    assert.equal(searched.filtered.fixtures, 1);
    assert.equal(searched.rows[0].matchId, "fixture-002");
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("单场账本可只统计当前预测模型版本", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-ledger-version-"));
  const ledger = createPredictionLedger(path.join(directory, "ledger.db"));
  try {
    ledger.record(snapshot({ matchId: "legacy-fixture" }));
    ledger.record(
      snapshot({
        matchId: "current-fixture",
        policyVersion: "historical-similarity-v2:selection-v3@test:all-leagues",
      }),
    );
    ledger.record(
      snapshot({
        matchId: "old-same-family-fixture",
        policyVersion: "historical-similarity-v2:selection-v3@old:all-leagues",
      }),
    );
    const current = ledger.summary({
      policyVersion: "current",
      currentPolicyPrefix: "historical-similarity-v2:",
      currentPolicyVersions: [
        "historical-similarity-v2:selection-v3@test:all-leagues",
      ],
    });
    assert.equal(current.totals.fixtures, 1);
    assert.equal(current.rows[0].matchId, "current-fixture");

    const legacy = ledger.summary({
      policyVersion: "legacy",
      currentPolicyPrefix: "historical-similarity-v2:",
      currentPolicyVersions: [
        "historical-similarity-v2:selection-v3@test:all-leagues",
      ],
    });
    assert.equal(legacy.totals.fixtures, 2);
    assert.ok(
      legacy.rows.every((row) => row.matchId !== "current-fixture"),
    );
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("当前算法跨数据和验证版本累计，但排除不同生产阈值", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-ledger-algorithm-"));
  const ledger = createPredictionLedger(path.join(directory, "ledger.db"));
  const stableVersion =
    "historical-similarity-v3:spf:spf-hhad-joint-v1:tolerance-7.00pct:all-leagues";
  try {
    ledger.record(
      snapshot({
        matchId: "current-validated",
        policyVersion:
          "historical-similarity-v3:selection-v1@old:all-leagues",
        algorithmVersion: null,
        threshold: 0.07,
        validationStatus: "validated",
      }),
    );
    ledger.record(
      snapshot({
        matchId: "current-pending-validation",
        policyVersion:
          "historical-similarity-v3:selection-v1@new:pending-validation:all-leagues",
        algorithmVersion: null,
        threshold: 0.07,
        validationStatus: "pending_revalidation",
      }),
    );
    ledger.record(
      snapshot({
        matchId: "different-threshold",
        policyVersion:
          "historical-similarity-v3:selection-v1@new:all-leagues",
        algorithmVersion: null,
        threshold: 0.1,
      }),
    );

    const current = ledger.summary({
      policyVersion: "current",
      currentPolicyVersions: [stableVersion],
      currentAlgorithmSpec: {
        probabilityPolicy: "historical-similarity-v3",
        thresholds: { spf: 0.07, hhad: 0.07, goals: 0.015 },
        goalZeroToleranceAll: 2,
        goalZeroToleranceSameLeague: 2.5,
        versions: {
          spf: { all: stableVersion, sameLeague: `${stableVersion}:same` },
        },
      },
    });
    assert.equal(current.totals.fixtures, 2);
    assert.deepEqual(
      new Set(current.rows.map((row) => row.algorithmVersion)),
      new Set([stableVersion]),
    );
    assert.ok(
      current.rows.some(
        (row) => row.validationStatus === "pending_revalidation",
      ),
    );
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("三个玩法在同一比赛中分别留档", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-ledger-"));
  const ledger = createPredictionLedger(path.join(directory, "ledger.db"));
  try {
    assert.equal(ledger.record(snapshot({ market: "spf" })), true);
    assert.equal(
      ledger.record(
        snapshot({
          market: "hhad",
          handicap: -1,
          predicted: "负",
          topLabels: ["负"],
        }),
      ),
      true,
    );
    assert.equal(
      ledger.record(
        snapshot({
          market: "goals",
          predicted: "3",
          topLabels: ["3"],
        }),
      ),
      true,
    );
    const summary = ledger.summary();
    assert.equal(summary.totals.fixtures, 1);
    assert.equal(summary.totals.snapshots, 3);
    assert.equal(summary.byMarket.spf.total, 1);
    assert.equal(summary.byMarket.hhad.total, 1);
    assert.equal(summary.byMarket.goals.total, 1);
    assert.equal(summary.byMarket.goalsPair.total, 1);
    assert.equal(summary.byMarket.goalsPair.pending, 1);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("全部联赛和同联赛作为两本独立账保存", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-ledger-"));
  const ledger = createPredictionLedger(path.join(directory, "ledger.db"));
  try {
    assert.equal(ledger.record(snapshot()), true);
    assert.equal(
      ledger.record(
        snapshot({
          policyVersion: "selection-v3@test:same-league",
          predicted: "平",
          topLabels: ["平"],
          selectedProbability: 0.48,
          selectedOdds: 3.2,
          samples: 8,
          settings: { spfTolerance: 0.07, sameLeague: true },
        }),
      ),
      true,
    );
    const summary = ledger.summary();
    assert.equal(summary.totals.fixtures, 1);
    assert.equal(summary.totals.snapshots, 2);
    assert.equal(summary.byScope.all.total, 1);
    assert.equal(summary.byScope.sameLeague.total, 1);
    assert.equal(summary.byMarketScope.spf.all.total, 1);
    assert.equal(summary.byMarketScope.spf.sameLeague.total, 1);
    assert.equal(summary.byMarketScope.hhad.all.total, 0);
    assert.deepEqual(
      summary.rows.map((row) => row.sampleScope).sort(),
      ["全部联赛", "同联赛"],
    );

    for (const pending of ledger.pending()) {
      const labels = JSON.parse(pending.top_labels_json || "[]");
      ledger.settle(pending.id, {
        actualResult: "胜",
        score: "1:0",
        correct: labels.includes("胜"),
        selectedOdds: pending.selected_odds,
        sourceFile: "历史进球.xlsx",
        sourceRow: 101,
        settledAt: "2026-07-27T03:00:00.000Z",
      });
    }
    const paired = ledger.summary().scopeComparison.byMarket.spf;
    assert.equal(paired.paired, 1);
    assert.equal(paired.directionsDiffer, 1);
    assert.equal(paired.allCorrect, 1);
    assert.equal(paired.sameLeagueCorrect, 0);
    assert.equal(paired.sameLeagueNetWins, -1);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("总进球双选按两注成本独立结算", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-ledger-"));
  const ledger = createPredictionLedger(path.join(directory, "ledger.db"));
  try {
    ledger.record(
      snapshot({
        market: "goals",
        predicted: "2",
        topLabels: ["2"],
        selectedProbability: 0.27,
        selectedOdds: 3.4,
        probabilities: [0.03, 0.13, 0.27, 0.25, 0.15, 0.08, 0.05, 0.04],
        odds: [15, 5.5, 3.4, 3.6, 6, 12, 20, 30],
      }),
    );
    const [pending] = ledger.pending();
    ledger.settle(pending.id, {
      actualResult: "3",
      score: "2:1",
      correct: false,
      selectedOdds: pending.selected_odds,
      sourceFile: "历史进球.xlsx",
      sourceRow: 101,
      settledAt: "2026-07-27T03:00:00.000Z",
    });

    const summary = ledger.summary();
    assert.equal(summary.byMarket.goals.accuracy, 0);
    assert.equal(summary.byMarket.goalsPair.accuracy, 1);
    assert.equal(summary.byMarket.goalsPair.simulatedProfit, 1.6);
    assert.equal(summary.byMarket.goalsPair.roi, 0.8);
    assert.equal(summary.errorDiagnosis.confusion.goals.matrix[2][3], 1);
    assert.equal(summary.errorDiagnosis.confusion.goals.bias.predictedLow, 1);
    assert.equal(summary.errorDiagnosis.confusion.goals.bias.predictedHigh, 0);
    assert.equal(summary.errorDiagnosis.confusion.goals.bias.offByOne, 1);
    assert.deepEqual(summary.errorDiagnosis.confusion.goals.topErrors[0], {
      predicted: "2",
      actual: "3",
      count: 1,
    });
    assert.deepEqual(summary.rows[0].goalPair.labels, ["2", "3"]);
    assert.equal(summary.rows[0].goalPair.correct, true);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("0球倍数双选独立留档并只统计命中率", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-ledger-"));
  const ledger = createPredictionLedger(path.join(directory, "ledger.db"));
  try {
    ledger.record(
      snapshot({
        market: "goalMultiple",
        policyVersion: "historical-similarity-v2:goal-multiple-v1:all-leagues",
        predicted: "3 / 4",
        topLabels: ["3", "4"],
        selectedProbability: 0.63,
        selectedOdds: 18,
        probabilities: [0.38, 0.25],
        odds: [18, 6.75, 4.05, 3.6, 4.8, 7.5, 13, 17.5],
        samples: 81,
        settings: {
          sameLeague: false,
          goalMultipleCounts: [31, 20],
          goalMultipleProbabilities: [31 / 81, 20 / 81],
          goalMultipleCoverage: 51 / 81,
          goalMultipleZeroOdds: 18,
          goalMultipleRelations: [
            { index: 3, label: "3", multiple: 5 },
          ],
          goalMultipleSource: "倍数赔率历史比赛.html",
        },
      }),
    );
    const [pending] = ledger.pending();
    ledger.settle(pending.id, {
      actualResult: "4",
      score: "2:2",
      correct: true,
      selectedOdds: pending.selected_odds,
      metricsOnly: true,
      sourceFile: "历史进球数.xlsx",
      sourceRow: 101,
      settledAt: "2026-07-27T03:00:00.000Z",
    });

    const summary = ledger.summary();
    assert.equal(summary.byMarket.goalMultiple.total, 1);
    assert.equal(summary.byMarket.goalMultiple.correct, 1);
    assert.equal(summary.byMarket.goalMultiple.accuracy, 1);
    assert.equal(summary.byMarket.goalMultiple.stakeUnits, 0);
    assert.equal(summary.rows[0].simulatedProfit, null);
    assert.deepEqual(summary.rows[0].goalMultiple.labels, ["3", "4"]);
    assert.deepEqual(summary.rows[0].goalMultiple.counts, [31, 20]);
    assert.equal(summary.rows[0].goalMultiple.correct, true);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("并列方向按覆盖数量计成本，主命中率只统计严格单选", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-ledger-ties-"));
  const ledger = createPredictionLedger(path.join(directory, "ledger.db"));
  try {
    ledger.record(snapshot({ matchId: "single" }));
    ledger.record(
      snapshot({
        matchId: "double",
        predicted: "胜 / 平",
        topLabels: ["胜", "平"],
        selectedProbability: 0.4,
      }),
    );
    ledger.record(
      snapshot({
        matchId: "full-cover",
        predicted: "胜 / 平 / 负",
        topLabels: ["胜", "平", "负"],
        selectedProbability: 1 / 3,
      }),
    );

    for (const pending of ledger.pending()) {
      const actualResult =
        pending.match_id === "single"
          ? "胜"
          : pending.match_id === "double"
            ? "平"
            : "负";
      ledger.settle(pending.id, {
        actualResult,
        score: "1:0",
        sourceFile: "历史.xlsx",
        sourceRow: 101,
        settledAt: "2026-07-27T03:00:00.000Z",
      });
    }

    const summary = ledger.summary();
    assert.equal(summary.overall.recordedSettled, 3);
    assert.equal(summary.overall.settled, 1);
    assert.equal(summary.overall.correct, 1);
    assert.equal(summary.overall.accuracy, 1);
    assert.deepEqual(summary.overall.multiSelection, {
      settled: 1,
      correct: 1,
      coverageAccuracy: 1,
    });
    assert.equal(summary.overall.noPrediction, 1);
    assert.equal(summary.overall.stakeUnits, 3);
    assert.ok(Math.abs(summary.overall.simulatedProfit - 2.3) < 1e-12);
    assert.ok(Math.abs(summary.overall.roi - 2.3 / 3) < 1e-12);
    assert.equal(summary.calibration.settled, 1);
    assert.equal(summary.oddsBenchmark.overall.compared, 1);
    assert.equal(summary.errorDiagnosis.overall.settled, 1);

    const rows = new Map(summary.rows.map((row) => [row.matchId, row]));
    assert.equal(rows.get("single").strictSingle, true);
    assert.equal(rows.get("double").multiSelection, true);
    assert.equal(rows.get("double").stakeUnits, 2);
    assert.equal(rows.get("double").simulatedReturn, 3.2);
    assert.ok(
      Math.abs(rows.get("double").simulatedProfit - 1.2) < 1e-12,
    );
    assert.equal(rows.get("full-cover").noPrediction, true);
    assert.equal(rows.get("full-cover").correct, null);
    assert.equal(rows.get("full-cover").stakeUnits, 0);
    assert.equal(rows.get("full-cover").simulatedProfit, null);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("单场批量结算异常时事务整体回滚", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-ledger-tx-"));
  const ledger = createPredictionLedger(path.join(directory, "ledger.db"));
  try {
    ledger.record(snapshot());
    const [pending] = ledger.pending();
    assert.throws(
      () =>
        ledger.transaction(() => {
          ledger.settle(pending.id, {
            actualResult: "胜",
            score: "1:0",
            sourceFile: "历史.xlsx",
            sourceRow: 101,
            settledAt: "2026-07-27T03:00:00.000Z",
          });
          throw new Error("模拟批量结算失败");
        }),
      /模拟批量结算失败/,
    );
    assert.equal(ledger.pending().length, 1);
    assert.equal(ledger.summary().totals.settled, 0);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
