import test from "node:test";
import assert from "node:assert/strict";
import {
  GOAL_ZERO_BANDS,
  compositeGoalDistance,
  findSimilarByGoalBand,
  findSimilarByZeroOdds,
  findZeroOddsInterval,
  learnZeroOddsIntervals,
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

test("全部联赛先按0球赔率±2.00筛选，再按综合距离排序全部样本", () => {
  const target = [12, 6, 4, 3.2, 4.1, 6.5, 11, 15];
  const close = [13, 6.1, 4.05, 3.25, 4.05, 6.6, 11.2, 15.2];
  const far = [13, 15, 10, 7, 4, 3, 2.5, 2.2];
  const zeroOddsTooFar = [14.01, ...close.slice(1)];
  const result = findSimilarByGoalBand(
    [
      { odds: close, goals: "2" },
      { odds: far, goals: "5" },
      { odds: zeroOddsTooFar, goals: "4" },
    ],
    target,
    { intervals: GOAL_ZERO_BANDS },
  );
  assert.equal(result.interval.id, "g0-2");
  assert.deepEqual(result.zeroOddsWindow, {
    target: 12,
    tolerance: 2,
    lower: 10,
    upper: 14,
    label: "10.00～14.00",
  });
  assert.deepEqual(result.similar.map((row) => row.goals), ["2", "5"]);
  assert.ok(result.similar[0].distance < result.similar[1].distance);
  assert.ok(result.similar.every((row) => row.similarityWeight > 0));
  assert.equal(result.weighting.usesAllSamples, true);
  assert.equal(result.weighting.sampleLimit, null);
});

test("全部联赛0球21.00只匹配19.00至23.00", () => {
  const target = [21, 7.5, 4.4, 3.25, 4.1, 8, 15, 19];
  const odds = (zero) => [zero, 7.5, 4.4, 3.25, 4.1, 8, 15, 19];
  const result = findSimilarByGoalBand(
    [
      { odds: odds(10.25), goals: "1" },
      { odds: odds(18), goals: "2" },
      { odds: odds(19), goals: "2" },
      { odds: odds(22.5), goals: "3" },
      { odds: odds(23), goals: "3" },
      { odds: odds(24), goals: "4" },
      { odds: odds(25), goals: "5" },
    ],
    target,
    { intervals: GOAL_ZERO_BANDS },
  );
  assert.equal(result.interval.id, "g0-2");
  assert.equal(result.zeroOddsWindow.label, "19.00～23.00");
  assert.deepEqual(
    result.similar.map((row) => row.odds[0]).sort((left, right) => left - right),
    [19, 22.5, 23],
  );
});

test("同联赛统一使用0球赔率±2.50且不会混入其他联赛", () => {
  const target = [21, 7.5, 4.4, 3.25, 4.1, 8, 15, 19];
  const odds = (zero) => [zero, 7.5, 4.4, 3.25, 4.1, 8, 15, 19];
  const result = findSimilarByGoalBand(
    [
      { league: "荷乙", odds: odds(18.5), goals: "2" },
      { league: "荷乙", odds: odds(23.5), goals: "3" },
      { league: "荷乙", odds: odds(24), goals: "4" },
      { league: "英超", odds: odds(21), goals: "5" },
    ],
    target,
    {
      intervals: GOAL_ZERO_BANDS,
      sameLeague: true,
      league: "荷乙",
    },
  );
  assert.equal(result.zeroOddsWindow.tolerance, 2.5);
  assert.equal(result.zeroOddsWindow.label, "18.50～23.50");
  assert.deepEqual(
    result.similar.map((row) => [row.league, row.odds[0]]),
    [["荷乙", 23.5], ["荷乙", 18.5]],
  );
});

test("综合距离同时包含终赔、初赔、走势和隐含进球", () => {
  const target = [21, 7.5, 4.4, 3.25, 4.1, 8, 15, 19];
  const history = [21.5, 7.2, 4.5, 3.3, 4.2, 7.8, 14.5, 19.5];
  const result = compositeGoalDistance(history, target, {
    historyInitialOdds: [22, 7, 4.5, 3.4, 4.1, 7.5, 14, 19],
    targetInitialOdds: [21, 7.2, 4.5, 3.3, 4.2, 7.7, 15, 19],
  });
  assert.ok(result.distance > 0);
  assert.deepEqual(Object.keys(result.components), [
    "final",
    "initial",
    "movement",
    "expectedGoals",
  ]);
  assert.deepEqual(result.weights, {
    final: 0.6,
    initial: 0.15,
    movement: 0.15,
    expectedGoals: 0.1,
  });
});
