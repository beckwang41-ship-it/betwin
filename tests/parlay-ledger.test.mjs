import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createParlayLedger,
  parlaySettlementDecision,
  settlementRowEligible,
} from "../lib/parlay-ledger.mjs";

function snapshot(mode = "standard") {
  const goalsPair = mode === "goalsPair";
  return {
    combinationId: "a__b",
    mode,
    selectionSource: "user_saved",
    policyVersion: "test-v1",
    capturedAt: "2026-07-30T10:00:00.000Z",
    sourceUpdatedAt: "2026-07-30T09:00:00.000Z",
    historySourceFile: "history.xlsx",
    historyRowWatermark: 100,
    legs: [
      {
        matchId: "a",
        league: "测试联赛",
        home: "主队A",
        away: "客队A",
        market: goalsPair ? "goalsPair" : "had",
        marketLabel: goalsPair ? "总进球双选" : "胜平负",
        handicap: null,
        predicted: goalsPair ? "2 / 3" : "胜",
        selections: goalsPair
          ? [
              { label: "2", odds: 3.2, probability: 0.28 },
              { label: "3", odds: 3.5, probability: 0.27 },
            ]
          : [{ label: "胜", odds: 1.8, probability: 0.6 }],
        probability: goalsPair ? 0.55 : 0.6,
        samples: 50,
      },
      {
        matchId: "b",
        league: "测试联赛",
        home: "主队B",
        away: "客队B",
        market: goalsPair ? "goalsPair" : "hhad",
        marketLabel: goalsPair ? "总进球双选" : "让球胜平负 (+1)",
        handicap: goalsPair ? null : 1,
        predicted: goalsPair ? "1 / 2" : "让胜",
        selections: goalsPair
          ? [
              { label: "1", odds: 4.1, probability: 0.3 },
              { label: "2", odds: 3.2, probability: 0.25 },
            ]
          : [{ label: "让胜", odds: 1.6, probability: 0.7 }],
        probability: goalsPair ? 0.55 : 0.7,
        samples: 60,
      },
    ],
    settings: { legs: 2, sort: "probability" },
    totalStake: goalsPair ? 4 : 1,
    hitProbability: goalsPair ? 0.3025 : 0.42,
    valueIndex: 0.9,
  };
}

test("串关快照不可重复，并保留完整的自选规则", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "betwin-parlay-"));
  const ledger = createParlayLedger(path.join(directory, "ledger.db"));
  try {
    const first = ledger.record(snapshot());
    const duplicate = ledger.record(snapshot());
    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(first.row.selectionSource, "user_saved");
    assert.equal(first.row.settings.sort, "probability");
    assert.equal(first.row.legs.length, 2);
    assert.equal(ledger.summary().totals.total, 1);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("进球双选串关按四注成本结算整组盈亏", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "betwin-parlay-"));
  const ledger = createParlayLedger(path.join(directory, "ledger.db"));
  try {
    const recorded = ledger.record(snapshot("goalsPair"));
    ledger.settle(recorded.row.id, {
      correct: true,
      simulatedReturn: 3.5 * 3.2,
      totalStake: 4,
      actualResults: [
        { matchId: "a", actualResult: "3", correct: true },
        { matchId: "b", actualResult: "2", correct: true },
      ],
      settledAt: "2026-07-31T10:00:00.000Z",
    });
    const summary = ledger.summary();
    assert.equal(summary.totals.settled, 1);
    assert.equal(summary.totals.correct, 1);
    assert.equal(summary.rows[0].simulatedReturn, 11.2);
    assert.equal(summary.rows[0].simulatedProfit, 7.2);
    assert.equal(summary.totals.roi, 1.8);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("串关一腿未中即可结算，部分命中则继续等待", () => {
  assert.deepEqual(
    parlaySettlementDecision(2, [{ correct: true }]),
    { ready: false, correct: null },
  );
  assert.deepEqual(
    parlaySettlementDecision(2, [{ correct: false }]),
    { ready: true, correct: false },
  );
  assert.deepEqual(
    parlaySettlementDecision(2, [{ correct: true }, { correct: true }]),
    { ready: true, correct: true },
  );
});

test("历史文件更新后允许结算水位行被替换的新赛果", () => {
  assert.equal(settlementRowEligible(101, 100, false), true);
  assert.equal(settlementRowEligible(100, 100, false), false);
  assert.equal(settlementRowEligible(100, 100, true), true);
  assert.equal(settlementRowEligible(99, 100, true), false);
});

test("待结算串关会保存已经到达的单腿赛果", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "betwin-parlay-progress-"));
  const ledger = createParlayLedger(path.join(directory, "ledger.db"));
  try {
    const recorded = ledger.record(snapshot());
    assert.equal(
      ledger.updateProgress(recorded.row.id, [
        {
          matchId: "a",
          actualResult: "胜",
          score: "2:0",
          correct: true,
          selectedOdds: 1.8,
          sourceFile: "history.xlsx",
          sourceRow: 101,
        },
      ]),
      true,
    );
    const summary = ledger.summary();
    assert.equal(summary.rows[0].status, "pending");
    assert.equal(summary.rows[0].actualResults.length, 1);
    assert.equal(summary.rows[0].actualResults[0].score, "2:0");
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("提前判负的已结算串关仍会补齐迟到赛果且不改盈亏", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "betwin-parlay-backfill-"));
  const ledger = createParlayLedger(path.join(directory, "ledger.db"));
  try {
    const recorded = ledger.record(snapshot("goalsPair"));
    ledger.settle(recorded.row.id, {
      correct: false,
      simulatedReturn: 0,
      totalStake: 4,
      actualResults: [
        {
          matchId: "b",
          actualResult: "3",
          score: "1:2",
          correct: false,
          selectedOdds: null,
          sourceFile: "history.xlsx",
          sourceRow: 101,
        },
      ],
      settledAt: "2026-07-31T10:00:00.000Z",
    });

    assert.equal(ledger.incompleteSettled().length, 1);
    assert.equal(
      ledger.updateProgress(recorded.row.id, [
        {
          matchId: "a",
          actualResult: "3",
          score: "2:1",
          correct: true,
          selectedOdds: 3.5,
          sourceFile: "history.xlsx",
          sourceRow: 102,
        },
        {
          matchId: "b",
          actualResult: "3",
          score: "1:2",
          correct: false,
          selectedOdds: null,
          sourceFile: "history.xlsx",
          sourceRow: 101,
        },
      ]),
      true,
    );

    const row = ledger.summary().rows[0];
    assert.equal(row.status, "settled");
    assert.equal(row.correct, false);
    assert.equal(row.simulatedProfit, -4);
    assert.equal(row.actualResults.length, 2);
    assert.equal(ledger.incompleteSettled().length, 0);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("串关账本支持玩法、球队筛选和分页", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "betwin-parlay-page-"));
  const ledger = createParlayLedger(path.join(directory, "ledger.db"));
  try {
    for (let index = 1; index <= 3; index += 1) {
      const row = snapshot(index === 3 ? "goalsPair" : "standard");
      row.combinationId = `combo-${index}`;
      row.capturedAt = `2026-08-0${index}T10:00:00.000Z`;
      row.legs = row.legs.map((leg, legIndex) => ({
        ...leg,
        matchId: `${leg.matchId}-${index}`,
        home: `主队${index}-${legIndex + 1}`,
      }));
      ledger.record(row);
    }
    const standard = ledger.summary({ mode: "standard", pageSize: 1, page: 2 });
    assert.equal(standard.totals.total, 3);
    assert.equal(standard.filtered.total, 2);
    assert.equal(standard.page.totalPages, 2);
    assert.equal(standard.rows.length, 1);

    const searched = ledger.summary({ query: "主队3", pageSize: 20 });
    assert.equal(searched.filtered.total, 1);
    assert.equal(searched.rows[0].mode, "goalsPair");
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("串关账本可按当前预测模型版本统计", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "betwin-parlay-version-"));
  const ledger = createParlayLedger(path.join(directory, "ledger.db"));
  try {
    ledger.record(snapshot());
    const currentSnapshot = snapshot();
    currentSnapshot.combinationId = "current-combo";
    currentSnapshot.policyVersion =
      "historical-similarity-v2:selection-v3@test:all-leagues";
    ledger.record(currentSnapshot);
    const oldSameFamily = snapshot();
    oldSameFamily.combinationId = "old-same-family-combo";
    oldSameFamily.policyVersion =
      "historical-similarity-v2:selection-v3@old:all-leagues";
    ledger.record(oldSameFamily);

    const current = ledger.summary({
      policyVersion: "current",
      currentPolicyPrefix: "historical-similarity-v2:",
      currentPolicyVersions: [currentSnapshot.policyVersion],
    });
    assert.equal(current.totals.total, 1);
    assert.equal(current.rows[0].policyVersion, currentSnapshot.policyVersion);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("串关批量结算异常时事务整体回滚", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "betwin-parlay-tx-"));
  const ledger = createParlayLedger(path.join(directory, "ledger.db"));
  try {
    const recorded = ledger.record(snapshot());
    assert.throws(
      () =>
        ledger.transaction(() => {
          ledger.settle(recorded.row.id, {
            correct: true,
            simulatedReturn: 2.88,
            totalStake: 1,
            actualResults: [],
            settledAt: "2026-07-31T10:00:00.000Z",
          });
          throw new Error("模拟串关结算失败");
        }),
      /模拟串关结算失败/,
    );
    assert.equal(ledger.pending().length, 1);
    assert.equal(ledger.summary().totals.settled, 0);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
