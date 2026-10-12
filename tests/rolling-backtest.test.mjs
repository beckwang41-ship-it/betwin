import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeCases,
  summarizeGoalPairs,
  walkForward,
} from "../lib/rolling-backtest.mjs";

test("walk-forward prediction only receives earlier rows from the same source", () => {
  const rows = [
    { sourceFile: "b.xlsx", sourceRow: 3, value: "b3" },
    { sourceFile: "a.xlsx", sourceRow: 2, value: "a2" },
    { sourceFile: "a.xlsx", sourceRow: 1, value: "a1" },
    { sourceFile: "b.xlsx", sourceRow: 1, value: "b1" },
    { sourceFile: "b.xlsx", sourceRow: 2, value: "b2" },
  ];
  const seen = [];
  const run = walkForward(rows, {
    warmup: 1,
    predict(target, history) {
      seen.push({
        target: target.value,
        history: history.map((row) => row.value),
      });
      return { target: target.value };
    },
  });

  assert.equal(run.cases.length, 3);
  assert.deepEqual(seen, [
    { target: "b2", history: ["b1"] },
    { target: "b3", history: ["b1", "b2"] },
    { target: "a2", history: ["a1"] },
  ]);
});

test("classification summary calculates accuracy, loss and flat-bet return", () => {
  const cases = [
    {
      actualIndex: 0,
      odds: [2, 3, 4],
      probabilities: [0.6, 0.3, 0.1],
      prediction: 0,
    },
    {
      actualIndex: 2,
      odds: [1.5, 3, 6],
      probabilities: [0.7, 0.2, 0.1],
      prediction: 0,
    },
  ];
  const summary = summarizeCases(cases, "probabilities", "prediction");
  assert.equal(summary.evaluated, 2);
  assert.equal(summary.accuracy, 0.5);
  assert.equal(summary.flatBetRoi, 0);
  assert.ok(summary.logLoss > 1);
  assert.ok(summary.brier > 0);
});

test("goal-pair summary counts top-two coverage and charges two stakes", () => {
  const cases = [
    {
      actualIndex: 3,
      odds: [12, 5, 3.2, 3.5, 6, 10, 18, 28],
      modelProbabilities: [0.03, 0.12, 0.25, 0.24, 0.16, 0.1, 0.06, 0.04],
    },
    {
      actualIndex: 5,
      odds: [12, 5, 3.2, 3.5, 6, 10, 18, 28],
      modelProbabilities: [0.03, 0.12, 0.25, 0.24, 0.16, 0.1, 0.06, 0.04],
    },
  ];
  const summary = summarizeGoalPairs(cases);
  assert.equal(summary.evaluated, 2);
  assert.equal(summary.correct, 1);
  assert.equal(summary.accuracy, 0.5);
  assert.equal(summary.flatBetProfit, -0.5);
  assert.equal(summary.flatBetRoi, -0.125);
  assert.equal(summary.stakePerMatch, 2);
});

test("并列最高按覆盖成本结算，三项全覆盖不下注", () => {
  const result = summarizeCases([
    { probabilities: [.45, .45, .1], odds: [2, 3, 4], actualIndex: 1, prediction: 0 },
    { probabilities: [1/3, 1/3, 1/3], odds: [2, 3, 4], actualIndex: 0, prediction: 0 },
  ], "probabilities", "prediction");
  assert.equal(result.flatBetProfit, 1);
  assert.equal(result.stakeUnits, 2);
  assert.equal(result.flatBetRoi, .5);
  assert.equal(result.noPrediction, 1);
  assert.equal(result.accuracy, null);
  assert.equal(result.multiSelectionCoverage, 1);
});
