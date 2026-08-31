import assert from "node:assert/strict";
import test from "node:test";
import {
  capitalLedgerMetrics,
  calculateDoubleChance,
  crossValidateScoreAndGoals,
  formatOddsWithMovement,
  settledLedgerCounts,
  timelineHasOddsMovement,
} from "../public/ledger-metrics.js";

test("实战汇总只统计已结算比赛和预测", () => {
  assert.deepEqual(
    settledLedgerCounts({
      fixtures: 42,
      settledFixtures: 15,
      coreSettledFixtures: 11,
    }, {
      all: { settled: 32 },
      sameLeague: { settled: 31 },
    }),
    { fixtures: 11, allPredictions: 32, sameLeaguePredictions: 31 },
  );
});

test("只有待结算记录时实战汇总为零", () => {
  assert.deepEqual(
    settledLedgerCounts({
      fixtures: 27,
      snapshots: 81,
      pendingFixtures: 27,
      pending: 81,
    }, {
      all: { pending: 40 },
      sameLeague: { pending: 41 },
    }),
    { fixtures: 0, allPredictions: 0, sameLeaguePredictions: 0 },
  );
});

test("资金看板按单场与串关的真实记录和注数合并", () => {
  assert.deepEqual(
    capitalLedgerMetrics(
      {
        total: 978,
        settled: 903,
        correct: 365,
        stakeUnits: 866,
        simulatedProfit: -70.35,
      },
      {
        total: 2,
        settled: 0,
        correct: 0,
        stakeUnits: 0,
        simulatedProfit: 0,
      },
    ),
    {
      total: 980,
      settled: 903,
      correct: 365,
      accuracy: 365 / 903,
      stakeUnits: 866,
      simulatedProfit: -70.35,
      simulatedReturn: 795.65,
      roi: -70.35 / 866,
    },
  );
});

test("资金看板没有已结算注数时不伪造收益率", () => {
  assert.deepEqual(
    capitalLedgerMetrics(
      { total: 12, pending: 12 },
      { total: 1, pending: 1 },
    ),
    {
      total: 13,
      settled: 0,
      correct: 0,
      accuracy: null,
      stakeUnits: 0,
      simulatedProfit: 0,
      simulatedReturn: 0,
      roi: null,
    },
  );
});

test("概率前两项选取最高两项并计算分配后等效返还", () => {
  const result = calculateDoubleChance(
    {
      available: true,
      final: [0.48, 0.32, 0.20],
    },
    { h: 1.85, d: 3.40, a: 4.10 },
    false,
  );
  assert.equal("isSolidSingle" in result, false);
  assert.equal(result.pairLabel, "主胜 / 平局");
  assert.equal(result.combinedCover, 0.80);
  assert.ok(Math.abs(result.combinedOdds - (1.85 * 3.40) / (1.85 + 3.40)) < 1e-6);
});

test("概率前两项只返回描述性数据，不硬编码单选优势结论", () => {
  const result = calculateDoubleChance(
    {
      available: true,
      final: [0.65, 0.22, 0.13],
    },
    { h: 1.40, d: 4.50, a: 7.00 },
    false,
  );
  assert.equal("isSolidSingle" in result, false);
  assert.equal(result.pairLabel, "主胜 / 平局");
  assert.equal(result.combinedCover, 0.87);
});

test("比分分布与总进球档位观察：两项皆吻合时标记为双项一致", () => {
  const result = crossValidateScoreAndGoals(
    [
      { score: "2-1", probability: 0.25 },
      { score: "1-1", probability: 0.20 },
      { score: "3-1", probability: 0.15 },
    ],
    ["2", "3"],
  );
  assert.equal(result.status, "verified");
  assert.equal(result.matchedCount, 2);
  assert.equal(result.chips[0].isGoalMatch, true); // 2-1 = 3球
  assert.equal(result.chips[1].isGoalMatch, true); // 1-1 = 2球
  assert.equal(result.chips[2].isGoalMatch, false); // 3-1 = 4球
});

test("波胆比分与总进球数联动校验：部分吻合时判定为 partial", () => {
  const result = crossValidateScoreAndGoals(
    [
      { score: "1-0", probability: 0.30 },
      { score: "2-0", probability: 0.25 },
    ],
    ["2", "3"],
  );
  assert.equal(result.status, "partial");
  assert.equal(result.matchedCount, 1); // 2-0 = 2球
});

test("7球及以上比分正确匹配7+球档位", () => {
  const result = crossValidateScoreAndGoals(
    [
      { score: "4-3", probability: 0.12 },
      { score: "5-3", probability: 0.08 },
      { score: "3-3", probability: 0.07 },
    ],
    ["7+"],
  );
  assert.equal(result.status, "verified");
  assert.equal(result.matchedCount, 2);
  assert.equal(result.chips[0].isGoalMatch, true);
  assert.equal(result.chips[1].isGoalMatch, true);
  assert.equal(result.chips[2].isGoalMatch, false);
});

test("变盘判断比较实际赔率，不把重复快照误标为变盘", () => {
  const unchanged = [
    { h: 2.05, d: 3.2, a: 3.4, time: "09:00" },
    { h: 2.05, d: 3.2, a: 3.4, time: "10:00" },
  ];
  const changed = [
    ...unchanged,
    { h: 1.98, d: 3.25, a: 3.55, time: "11:00" },
  ];
  assert.equal(timelineHasOddsMovement(unchanged, ["h", "d", "a"]), false);
  assert.equal(timelineHasOddsMovement(changed, ["h", "d", "a"]), true);
});

test("赔率降水时返回下箭头及初赔回溯标记", () => {
  const result = formatOddsWithMovement(1.85, 1.95);
  assert.equal(result.trend, "down");
  assert.equal(result.badgeText, "↓ (初 1.95)");
  assert.equal(result.text, "赔率 1.85 ↓ (初 1.95)");
  assert.ok(result.html.includes("odds-trend down"));
  assert.ok(Math.abs(result.diff - -0.10) < 1e-6);
});

test("赔率升水时返回上箭头及初赔回溯标记", () => {
  const result = formatOddsWithMovement(3.40, 3.20);
  assert.equal(result.trend, "up");
  assert.equal(result.badgeText, "↑ (初 3.20)");
  assert.equal(result.text, "赔率 3.40 ↑ (初 3.20)");
  assert.ok(result.html.includes("odds-trend up"));
  assert.ok(Math.abs(result.diff - 0.20) < 1e-6);
});

test("赔率平水或初赔缺失时平稳显示", () => {
  const flat = formatOddsWithMovement(2.05, 2.05);
  assert.equal(flat.trend, "flat");
  assert.equal(flat.badgeText, "");
  assert.equal(flat.text, "赔率 2.05");

  const missing = formatOddsWithMovement(2.05, null);
  assert.equal(missing.trend, "flat");
  assert.equal(missing.badgeText, "");
  assert.equal(missing.text, "赔率 2.05");
});
