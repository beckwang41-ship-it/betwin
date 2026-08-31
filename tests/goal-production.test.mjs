import test from "node:test";
import assert from "node:assert/strict";
import {
  predictProductionGoals,
  productionGoalFeaturePools,
  selectProductionGoalSimilarity,
} from "../lib/goal-production.mjs";
import { runGoals } from "../scripts/rolling_backtest.mjs";
import { buildGoalProductionEvents } from "../scripts/export_goal_production_events.mjs";

const target = {
  league: "测试联赛",
  odds: [20, 7, 4.2, 3.2, 4.4, 7.5, 12, 16],
  initialOdds: [21, 7.2, 4.3, 3.3, 4.3, 7.2, 11.5, 15],
};

test("production goal selector applies the zero-odds window and composite ordering", () => {
  const history = [
    { matchKey: "far-zero", league: "测试联赛", goals: "4", odds: [23, 7, 4.2, 3.2, 4.4, 7.5, 12, 16] },
    { matchKey: "near-two", league: "测试联赛", goals: "2", odds: [20, 7, 4.2, 3.2, 4.4, 7.5, 12, 16] },
    { matchKey: "near-three", league: "其他联赛", goals: "3", odds: [21, 7.1, 4.3, 3.3, 4.5, 7.6, 12.2, 16.2] },
  ];
  const resolved = selectProductionGoalSimilarity(history, target);
  assert.deepEqual(
    resolved.similar.map((row) => row.matchKey),
    ["near-two", "near-three"],
  );
  assert.ok(resolved.similar[0].similarityWeight > resolved.similar[1].similarityWeight);
});

test("production goal prediction consumes the precomputed exponential weights", () => {
  const resolved = {
    similar: [
      { goals: "2", distance: 0, similarityWeight: 1 },
      { goals: "3", distance: 0.1, similarityWeight: 0.25 },
    ],
    weighting: {
      method: "exponential-composite-distance",
      bandwidth: 0.1,
    },
  };
  const prediction = predictProductionGoals(target.odds, resolved, {
    blendOptions: { empiricalOnly: true, requireSamples: true },
  });
  assert.equal(prediction.predicted, "2");
  // 权重仍按指数距离计算：1 与 0.25，裸占比 0.8 / 0.2。
  assert.equal(prediction.rawWeightedEmpirical[2], 0.8);
  assert.equal(prediction.rawWeightedEmpirical[3], 0.2);
  // 防零层随后生效。这里有效样本只有 1.25，八分类下先验占 54.5%，
  // 收缩很强属于预期——1.25 个样本本就不该报 80%。
  // 真实场景 goals 的样本量中位数是 2040，先验占比不足 0.1%。
  assert.equal(Number(prediction.weightedEmpirical[2].toFixed(4)), 0.4318);
  assert.ok(prediction.weightedEmpirical.every((value) => value > 0));
  assert.ok(
    prediction.weightedEmpirical[2] > prediction.weightedEmpirical[3],
    "防零层必须保序",
  );
});

test("rolling goal backtest uses the production selector and weights", () => {
  const rows = [
    { sourceFile: "goals.xlsx", sourceRow: 1, goals: "2", ...target },
    {
      sourceFile: "goals.xlsx",
      sourceRow: 2,
      goals: "3",
      ...target,
      odds: [21, 7.1, 4.3, 3.3, 4.5, 7.6, 12.2, 16.2],
    },
    { sourceFile: "goals.xlsx", sourceRow: 3, goals: "2", ...target },
  ];
  const expected = selectProductionGoalSimilarity(rows.slice(0, 2), rows[2]);
  const prediction = predictProductionGoals(rows[2].odds, expected, {
    blendOptions: { empiricalOnly: true, requireSamples: true },
  });
  const run = runGoals(rows, 2);
  assert.equal(run.cases.length, 1);
  assert.equal(run.cases[0].sampleSize, expected.similar.length);
  assert.deepEqual(run.cases[0].modelProbabilities, prediction.final);
});

test("challenger goal events reuse production pools and only earlier source rows", () => {
  const rows = [
    { sourceFile: "goals.xlsx", sourceRow: 3, goals: "2", ...target },
    { sourceFile: "goals.xlsx", sourceRow: 1, goals: "2", ...target },
    {
      sourceFile: "goals.xlsx",
      sourceRow: 2,
      goals: "3",
      ...target,
      odds: [21, 7.1, 4.3, 3.3, 4.5, 7.6, 12.2, 16.2],
    },
  ];
  const events = buildGoalProductionEvents(rows);
  const targetEvent = events.find((event) => event.sourceRow === 3);
  const expected = productionGoalFeaturePools(
    rows.filter((row) => row.sourceRow < 3).sort((left, right) => left.sourceRow - right.sourceRow),
    rows.find((row) => row.sourceRow === 3),
  );
  assert.deepEqual(targetEvent.pools, expected.pools);
  assert.equal(events.find((event) => event.sourceRow === 1).pools[3].sampleCount, 0);
});
