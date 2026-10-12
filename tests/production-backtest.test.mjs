import test from "node:test";
import assert from "node:assert/strict";
import { runProductionThreeWay } from "../lib/production-backtest.mjs";
import { buildThreeWayEvents } from "../lib/three-way-backtest.mjs";
import { selectThreeWaySimilarity } from "../lib/three-way-matching.mjs";
import { predictSpf } from "../lib/predictor.mjs";
import { summarize } from "../scripts/rolling_backtest.mjs";
import { ledgerCalendarDate } from "../public/ledger-date.js";
import { ledgerPerformanceMetrics } from "../public/ledger-metrics.js";

const pair = (sourceRow, result = "胜", hh = [3, 3, 2]) => {
  const common = { sourceFile: "history.xlsx", sourceRow, league: "英冠" };
  return { ...common, spf: { ...common, odds: [2, 3, 4], result },
    hhad: { ...common, odds: hh, result: "负", handicap: -1 } };
};

test("正式回测使用同批双盘口样本，并严格排除当前/后续行", () => {
  const pairs = [pair(4, "平"), pair(1), pair(2, "平", [8, 9, 10]), pair(3)];
  const events = buildThreeWayEvents({ pairedHistory: pairs });
  const run = runProductionThreeWay(events, { warmup: 2, includeSameLeague: true });
  const result = run.cases.find(x => x.sourceRow === 3 && x.market === "spf");
  const selection = selectThreeWaySimilarity(
    { league: "英冠", had: { h: 2, d: 3, a: 4 }, hhad: { h: 3, d: 3, a: 2, goalLine: -1 } },
    { pairedHistory: pairs.filter(p => p.sourceRow < 3) }, { spfTolerance: .07, hhadTolerance: .07 });
  const expected = predictSpf([2,3,4], selection.spf.similar, { empiricalOnly: true, requireSamples: true });
  assert.equal(result.sampleSize, 1);
  assert.deepEqual(result.modelProbabilities, expected.final);
  assert.equal(result.localSamples, 1);
  const changedFuture = runProductionThreeWay(buildThreeWayEvents({ pairedHistory: pairs.map(p => p.sourceRow === 4 ? pair(4, "负") : p) }), { warmup: 2 });
  assert.deepEqual(changedFuture.cases.find(x => x.sourceRow === 3 && x.market === "spf").modelProbabilities, result.modelProbabilities);
});

test("模型和市场汇总使用共同覆盖集合", () => {
  const run = runProductionThreeWay(buildThreeWayEvents({ pairedHistory: [pair(1), pair(2, "平", [9,9,9]), pair(3)] }), { warmup: 1 });
  const result = summarize(run);
  assert.equal(result.coverage, .5);
  assert.equal(result.market.evaluated, result.model.evaluated);
});

test("上海日期在UTC午夜两侧正确，并用于曲线分日", () => {
  assert.equal(ledgerCalendarDate("2026-09-04T15:59:59Z"), "2026-09-04");
  assert.equal(ledgerCalendarDate("2026-09-04T16:00:00Z"), "2026-09-05");
  const result = ledgerPerformanceMetrics([{ capturedAt: "2026-09-04T17:00:00Z", stakeUnits: 1, simulatedProfit: 2, correct: true }]);
  assert.equal(result.daily[0].date, "2026-09-05");
});
