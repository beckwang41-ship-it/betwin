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
    settings: { spfTolerance: 0.07, sameLeague: false },
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
    assert.equal(summary.rows[0].correct, true);
    assert.equal(summary.rows[0].score, "2:0");
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
    assert.deepEqual(
      summary.rows.map((row) => row.sampleScope).sort(),
      ["全部联赛", "同联赛"],
    );
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
    assert.deepEqual(summary.rows[0].goalPair.labels, ["2", "3"]);
    assert.equal(summary.rows[0].goalPair.correct, true);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
