import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoalEqualityDistribution,
  buildGoalMultipleDistribution,
  exactGoalMultipleRelations,
  goalMultipleRelationsForMarket,
  exactGoalOddsEqualities,
  goalOddsEqualitiesForMarket,
  selectGoalEqualityPrediction,
  selectGoalMultiplePrediction,
} from "../public/goal-multiples.js";

test("0球赔率按两位小数严格识别整数倍关系", () => {
  assert.deepEqual(
    exactGoalMultipleRelations([12, 4.9, 3, 3.4, 4.2, 7, 11, 18]),
    [{ index: 2, label: "2", multiple: 4 }],
  );
  assert.deepEqual(
    exactGoalMultipleRelations([23, 7.4, 4.2, 3.3, 4.4, 6.7, 11.5, 14]),
    [{ index: 6, label: "6", multiple: 2 }],
  );
});

test("近似倍数和小于2倍的关系不标记", () => {
  assert.deepEqual(
    exactGoalMultipleRelations([12, 4.01, 3.01, 3.4, 4.2, 7, 11, 18]),
    [],
  );
  assert.deepEqual(exactGoalMultipleRelations([4, 5, 6, 7, 8, 9, 10, 11]), []);
});

test("比赛最新总进球市场可直接复用整数倍筛选口径", () => {
  assert.deepEqual(
    goalMultipleRelationsForMarket({
      g0: 18,
      g1: 7.2,
      g2: 4.5,
      g3: 3.6,
      g4: 4.2,
      g5: 7.5,
      g6: 13,
      g7plus: 18,
    }).map(({ label, multiple }) => ({ label, multiple })),
    [
      { label: "2", multiple: 4 },
      { label: "3", multiple: 5 },
    ],
  );
  assert.deepEqual(goalMultipleRelationsForMarket(null), []);
});

test("指定进球赔率按数据库两位小数精度识别相同关系", () => {
  const relations = exactGoalOddsEqualities([
    18,
    9,
    3.5,
    3.5000001,
    4.5,
    8,
    9,
    18,
  ]);
  assert.deepEqual(
    relations.map(({ id, equalOdds }) => ({ id, equalOdds })),
    [
      { id: "g2-g3", equalOdds: 3.5 },
      { id: "g1-g6", equalOdds: 9 },
      { id: "g0-g7", equalOdds: 18 },
    ],
  );
});

test("相差一分的赔率不属于相同赔率", () => {
  assert.deepEqual(
    exactGoalOddsEqualities([18, 9, 3.5, 3.51, 4.5, 8, 9.01, 18.01]),
    [],
  );
});

test("比赛最新总进球市场可直接复用同赔筛选口径", () => {
  assert.deepEqual(
    goalOddsEqualitiesForMarket({
      g0: 21,
      g1: 7.5,
      g2: 4.4,
      g3: 3.85,
      g4: 4.1,
      g5: 8,
      g6: 15,
      g7plus: 3.85,
    }).map(({ label, equalOdds }) => ({ label, equalOdds })),
    [{ label: "3球＝7+球", equalOdds: 3.85 }],
  );
  assert.deepEqual(goalOddsEqualitiesForMarket(null), []);
});

test("任意两个进球档赔率相同都能识别，不限于预设组合", () => {
  const relations = exactGoalOddsEqualities([
    21,
    7.5,
    4.4,
    3.25,
    4.1,
    4.1,
    15,
    19,
  ]);
  assert.deepEqual(
    relations.map(({ label, equalOdds }) => ({ label, equalOdds })),
    [{ label: "4球＝5球", equalOdds: 4.1 }],
  );
});

test("同赔预测按组合与完全相同的赔率值统计实际进球前两名", () => {
  const history = [
    ["3", [20, 7, 3.6, 3.6, 4.8, 8, 15, 22]],
    ["3", [21, 7.5, 3.6, 3.6, 4.9, 8.2, 15.5, 23]],
    ["2", [19, 6.8, 3.6, 3.6, 4.7, 7.8, 14.5, 21]],
    ["4", [18, 6.5, 3.6, 3.6, 4.6, 7.6, 14, 20]],
    ["1", [20, 7, 3.5, 3.5, 4.8, 8, 15, 22]],
  ].map(([goals, odds]) => ({ goals, odds }));
  const distribution = buildGoalEqualityDistribution(history);
  const prediction = selectGoalEqualityPrediction(
    [22, 7.8, 3.6, 3.6, 5, 8.5, 16, 24],
    distribution,
  );

  assert.equal(prediction.available, true);
  assert.equal(prediction.predictions.length, 1);
  assert.equal(prediction.predictions[0].label, "2球＝3球");
  assert.equal(prediction.predictions[0].equalOdds, 3.6);
  assert.equal(prediction.predictions[0].samples, 4);
  assert.deepEqual(prediction.predictions[0].labels, ["3", "2"]);
  assert.deepEqual(prediction.predictions[0].counts, [2, 1]);
  assert.deepEqual(prediction.predictions[0].probabilities, [0.5, 0.25]);
  assert.equal(prediction.predictions[0].coverageProbability, 0.75);
});

test("同赔组合相同但赔率值不同，不能混为同一个历史档位", () => {
  const distribution = buildGoalEqualityDistribution([
    { goals: "2", odds: [20, 7, 3.6, 3.6, 4.8, 8, 15, 22] },
    { goals: "3", odds: [20, 7, 3.6, 3.6, 4.8, 8, 15, 22] },
  ]);
  assert.equal(
    selectGoalEqualityPrediction(
      [20, 7, 3.5, 3.5, 4.8, 8, 15, 22],
      distribution,
    ).available,
    false,
  );
});

test("倍数预测按完全相同的0球终赔统计实际2球至7+球前两名", () => {
  const history = [
    ["3", [18, 6, 4.5, 3.6, 5, 9, 14, 20]],
    ["3", [18, 6, 4.5, 3.6, 5, 9, 14, 20]],
    ["4", [18, 6, 4.5, 3.6, 5, 9, 14, 20]],
    ["2", [18, 6, 4.5, 3.6, 5, 9, 14, 20]],
    ["5", [17, 5, 4.25, 3.4, 5, 8.5, 14, 20]],
    ["1", [18, 6, 4.5, 3.6, 5, 9, 14, 20]],
  ].map(([goals, odds], index) => ({
    sourceFile: "历史进球数.xlsx",
    sourceRow: index + 1,
    goals,
    odds,
  }));
  history.push({
    sourceFile: "lottery_goals_data_df1cda93.xlsx",
    sourceRow: 99,
    goals: "7+",
    odds: [18, 6, 4.5, 3.6, 5, 9, 14, 20],
  });

  const distribution = buildGoalMultipleDistribution(history, {
    sourceFile: "历史进球数.xlsx",
  });
  const prediction = selectGoalMultiplePrediction(
    [18, 6.75, 4.05, 3.6, 4.8, 7.5, 13, 17.5],
    distribution,
  );

  assert.equal(prediction.available, true);
  assert.equal(prediction.zeroOdds, 18);
  assert.equal(prediction.samples, 4);
  assert.deepEqual(prediction.labels, ["3", "2"]);
  assert.deepEqual(prediction.counts, [2, 1]);
  assert.deepEqual(prediction.probabilities, [0.5, 0.25]);
  assert.equal(prediction.coverageProbability, 0.75);
  assert.deepEqual(prediction.relations, [
    { index: 3, label: "3", multiple: 5 },
  ]);
});

test("没有整数倍关系或没有同档历史时不生成倍数预测", () => {
  const distribution = buildGoalMultipleDistribution([
    {
      sourceFile: "历史进球数.xlsx",
      goals: "3",
      odds: [18, 6, 4.5, 3.6, 5, 9, 14, 20],
    },
  ]);
  assert.equal(
    selectGoalMultiplePrediction(
      [18, 6.7, 4.1, 3.7, 5.1, 9.1, 14.1, 20.1],
      distribution,
    ).available,
    false,
  );
  assert.equal(
    selectGoalMultiplePrediction(
      [20, 8, 5, 4, 6, 10, 15, 25],
      distribution,
    ).available,
    false,
  );
});
