import test from "node:test";
import assert from "node:assert/strict";
import { walkForward } from "../lib/rolling-backtest.mjs";
import { buildThreeWayEvents } from "../lib/three-way-backtest.mjs";
import { runProductionThreeWay } from "../lib/production-backtest.mjs";
import { batchBoundary } from "../lib/history-timeline.mjs";

const row = (name, batch, sourceRow = 2) => ({
  home: name, away: "乙", league: "测试", score: "1:0", result: "胜",
  sourceFile: "history.xlsx", sourceRow, historyBatchId: batch,
  odds: [2, 3, 4], handicap: 0,
});

test("每日复用行号不会合并不同批次比赛，同批次不互相训练", () => {
  const rows = [row("后日", 3), row("甲", 2), row("丙", 2, 3), row("前日", 1, 99)];
  const events = buildThreeWayEvents({ spfHistory: rows });
  assert.equal(events.length, 4);
  const run = walkForward(rows, { warmup: 1, predict: (target, history) => ({
    name: target.home, seen: history.map(r => r.home),
  }) });
  assert.deepEqual(run.cases.map(r => [r.name, r.seen]), [
    ["甲", ["前日"]], ["丙", ["前日"]], ["后日", ["前日", "甲", "丙"]],
  ]);
  const production = runProductionThreeWay(events, { warmup: 1 });
  assert.deepEqual(production.cases.map(r => r.sampleSize), [1, 1, 3]);
  const changed = buildThreeWayEvents({ spfHistory: rows.map(r => r.home === "丙" ? { ...r, result: "负" } : r) });
  assert.deepEqual(runProductionThreeWay(changed, { warmup: 1 }).cases[0].modelProbabilities, production.cases[0].modelProbabilities);
});

test("新批次使用累积的旧库，无需对每天重新预热", () => {
  const legacy = { ...row("旧库", 0), sourceFile: "old.xlsx" };
  const run = walkForward([row("今日", 1), legacy], { warmup: 1,
    predict: (target, history) => ({ name: target.home, seen: history.map(r => r.home) }),
  });
  assert.deepEqual(run.cases.map(r => [r.name, r.seen]), [["今日", ["旧库"]]]);
});

test("数据库记录 ID 区分同批次同队同比分，配对记录按 ID 关联", () => {
  const first = { ...row("甲", 1), historyId: 1 };
  const second = { ...row("甲", 1), historyId: 2, odds: [2.1, 3, 4] };
  const hhad = { ...row("甲", 1, 99), historyId: 20, handicap: -1, result: "平" };
  const events = buildThreeWayEvents({ spfHistory: [first, second], hhadHistory: [hhad],
    pairedHistory: [{ ...first, spf: first, hhad }],
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].hhad.historyId, 20);
  assert.equal(events[1].hhad, null);
  assert.notEqual(events[0].fixtureId, events[1].fixtureId);
});

test("可靠性时间切分不拆开一个入库批次", () => {
  const rows = [row("甲", 1), row("乙", 2), row("丙", 2), row("丁", 2), row("戊", 3)];
  assert.equal(batchBoundary(rows, 3), 1);
  assert.equal(batchBoundary(rows, 4), 4);
});
