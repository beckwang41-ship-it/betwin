import test from "node:test";
import assert from "node:assert/strict";
import {
  GOAL_ZERO_BANDS,
  findSimilarByGoalBand,
  findSimilarByZeroOdds,
  findZeroOddsInterval,
  learnZeroOddsIntervals,
  remainingGoalDistance,
} from "../lib/goal-zero-odds.mjs";

function rows() {
  return [
    ...Array.from({ length: 40 }, (_, index) => ({
      sourceRow: index + 1,
      odds: [6 + (index % 4) * 0.1],
      goals: index % 3 ? "1" : "2",
    })),
    ...Array.from({ length: 40 }, (_, index) => ({
      sourceRow: index + 41,
      odds: [18 + (index % 4) * 0.1],
      goals: index % 3 ? "4" : "3",
    })),
  ];
}

test("0-goal odds intervals are learned from outcome changes", () => {
  const learned = learnZeroOddsIntervals(rows(), {
    minLeaf: 20,
    maxLeaves: 3,
  });
  assert.ok(learned.intervals.length >= 2);
  const low = findZeroOddsInterval(learned.intervals, 6.1);
  const high = findZeroOddsInterval(learned.intervals, 18.1);
  assert.notEqual(low.id, high.id);
  assert.ok(low.probabilities["1"] > low.probabilities["4"]);
  assert.ok(high.probabilities["4"] > high.probabilities["1"]);
});

test("interval eligibility is applied before local distance", () => {
  const intervals = [
    {
      id: "low",
      lower: null,
      upper: 10,
      observedMin: 5,
      observedMax: 9,
      scale: 4,
    },
    {
      id: "high",
      lower: 10,
      upper: null,
      observedMin: 11,
      observedMax: 19,
      scale: 8,
    },
  ];
  const history = [
    { odds: [9.9], goals: "2" },
    { odds: [11.2], goals: "3" },
    { odds: [14], goals: "4" },
  ];
  const result = findSimilarByZeroOdds(history, [11], {
    intervals,
    radius: 0.1,
  });
  assert.equal(result.interval.id, "high");
  assert.deepEqual(result.similar.map((row) => row.goals), ["3"]);
});

test("five goal bands are continuous at the configured market boundaries", () => {
  assert.equal(findZeroOddsInterval(GOAL_ZERO_BANDS, 10).id, "g0-1");
  assert.equal(findZeroOddsInterval(GOAL_ZERO_BANDS, 10.5).id, "g0-2");
  assert.equal(findZeroOddsInterval(GOAL_ZERO_BANDS, 23).id, "g0-3");
  assert.equal(findZeroOddsInterval(GOAL_ZERO_BANDS, 26).id, "g0-4");
  assert.equal(findZeroOddsInterval(GOAL_ZERO_BANDS, 33).id, "g0-5");
});

test("goal band matching gates on zero odds before comparing the other seven prices", () => {
  const target = [12, 6, 4, 3.2, 4.1, 6.5, 11, 15];
  const close = [13, 6.1, 4.05, 3.25, 4.05, 6.6, 11.2, 15.2];
  const far = [13, 15, 10, 7, 4, 3, 2.5, 2.2];
  const otherBand = [24, ...close.slice(1)];
  const closeDistance = remainingGoalDistance(close, target);
  const farDistance = remainingGoalDistance(far, target);
  const result = findSimilarByGoalBand(
    [
      { odds: close, goals: "2" },
      { odds: far, goals: "5" },
      { odds: otherBand, goals: "4" },
    ],
    target,
    {
      intervals: GOAL_ZERO_BANDS,
      policies: {
        "g0-2": {
          enabled: true,
          threshold: (closeDistance + farDistance) / 2,
        },
      },
    },
  );
  assert.equal(result.interval.id, "g0-2");
  assert.deepEqual(result.similar.map((row) => row.goals), ["2"]);
});
