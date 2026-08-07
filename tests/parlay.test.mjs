import test from "node:test";
import assert from "node:assert/strict";
import {
  generateGoalPairParlays,
  generateParlayCombinations,
} from "../lib/parlay.mjs";

const candidates = [
  { id: "a", odds: 1.5, probability: 0.7 },
  { id: "b", odds: 1.8, probability: 0.58 },
  { id: "c", odds: 2.1, probability: 0.49 },
  { id: "d", odds: 2.4, probability: 0.42 },
];

test("parlay generator creates the expected number of unique combinations", () => {
  const result = generateParlayCombinations(candidates, {
    legs: 2,
    targetOdds: 1,
    limit: 20,
  });
  assert.equal(result.total, 6);
  assert.equal(result.eligible, 6);
  assert.equal(new Set(result.rows.map((row) => row.id)).size, 6);
});

test("parlay generator multiplies odds and estimated probabilities", () => {
  const result = generateParlayCombinations(candidates.slice(0, 2), {
    legs: 2,
    targetOdds: 1,
  });
  assert.equal(result.rows[0].combinedOdds, 2.7);
  assert.equal(result.rows[0].hitProbability, 0.406);
  assert.equal(result.rows[0].valueIndex, 1.096);
});

test("parlay generator filters target odds and supports probability sorting", () => {
  const result = generateParlayCombinations(candidates, {
    legs: 2,
    targetOdds: 3.5,
    sort: "probability",
  });
  assert.ok(result.rows.every((row) => row.combinedOdds >= 3.5));
  assert.ok(result.rows[0].hitProbability >= result.rows.at(-1).hitProbability);
});

test("常规串关不会让低于最低单场赔率的选项进入组合", () => {
  const result = generateParlayCombinations(candidates, {
    legs: 2,
    targetOdds: 1,
    minLegOdds: 1.7,
  });
  assert.equal(result.total, 3);
  assert.equal(result.settings.minLegOdds, 1.7);
  assert.ok(
    result.rows.every((row) =>
      row.legs.every((leg) => Number(leg.odds) >= 1.7),
    ),
  );
  assert.ok(result.rows.every((row) => !row.legs.some((leg) => leg.id === "a")));
});

test("goal-pair 2-leg parlay expands two selections per match into four tickets", () => {
  const result = generateGoalPairParlays(
    [
      {
        id: "a",
        eligible: true,
        probability: 0.55,
        selections: [
          { label: "2", probability: 0.28, odds: 3.2 },
          { label: "3", probability: 0.27, odds: 3.5 },
        ],
      },
      {
        id: "b",
        eligible: true,
        probability: 0.58,
        selections: [
          { label: "1", probability: 0.3, odds: 4.2 },
          { label: "2", probability: 0.28, odds: 3.1 },
        ],
      },
    ],
    { targetOdds: 999 },
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.eligible, 1);
  assert.equal(result.settings.oddsFilter, false);
  assert.equal("targetOdds" in result.settings, false);
  assert.equal(result.rows[0].tickets.length, 4);
  assert.equal(result.rows[0].totalStake, 4);
  assert.equal(result.rows[0].hitProbability, 0.319);
  assert.deepEqual(
    result.rows[0].tickets.map((ticket) => ticket.combinedOdds),
    [13.44, 9.92, 14.7, 10.85],
  );
});

test("goal-pair parlay keeps valid candidates even when legacy validation did not pass", () => {
  const result = generateGoalPairParlays(
    [
      {
        id: "a",
        eligible: false,
        selections: [
          { label: "2", probability: 0.28, odds: 3.2 },
          { label: "3", probability: 0.27, odds: 3.5 },
        ],
      },
      {
        id: "b",
        eligible: true,
        selections: [
          { label: "1", probability: 0.3, odds: 4.2 },
          { label: "2", probability: 0.28, odds: 3.1 },
        ],
      },
    ],
    { targetOdds: 1 },
  );
  assert.equal(result.total, 1);
  assert.equal(result.rows.length, 1);
});
