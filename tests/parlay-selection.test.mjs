import assert from "node:assert/strict";
import test from "node:test";

import { recommendedParlaySelection, goalCoverageRanks, standardProbabilityRanks, parlaySelectionSummary } from "../public/parlay-selection.js";

test("常规排名按当前玩法计算，切换后重排，同显示值并列", () => {
  const candidates = [
    { id: "a", markets: { had: { market: "had", odds: 2, probability: 0.55 }, hhad: { market: "hhad", odds: 2, probability: 0.4 } } },
    { id: "b", markets: { had: { market: "had", odds: 2, probability: 0.4851 } } },
    { id: "c", markets: { hhad: { market: "hhad", odds: 2, probability: 0.4852 } } },
  ];
  const currentMarkets = new Map([["a", "had"]]);
  assert.deepEqual([...standardProbabilityRanks(candidates, { minLegOdds: 1.7, currentMarkets })], [["a", 1], ["b", 2], ["c", 2]]);
  currentMarkets.set("a", "hhad");
  assert.deepEqual([...standardProbabilityRanks(candidates, { minLegOdds: 1.7, currentMarkets })], [["b", 1], ["c", 1], ["a", 3]]);
});

test("常规排名排除不可串关比赛，并与页面相同地回退到有效玩法", () => {
  const candidates = [
    { id: "low", markets: { had: { market: "had", odds: 1.5, probability: 0.9 } } },
    { id: "fallback", markets: { had: { market: "had", odds: 1.5, probability: 0.8 }, hhad: { market: "hhad", odds: 2, probability: 0.5 } } },
    { id: "invalid", markets: { had: { market: "had", odds: 2, probability: NaN } } },
    { id: "empty", markets: {} },
  ];
  assert.deepEqual([...standardProbabilityRanks(candidates, { minLegOdds: 1.7, currentMarkets: new Map([["fallback", "had"]]) })], [["fallback", 1]]);
  assert.deepEqual([...standardProbabilityRanks(candidates, { minLegOdds: 2.1 })], []);
});

test("生成摘要准确说明目标数量、实际数量和不放宽限制", () => {
  assert.match(parlaySelectionSummary({ limit: 5, maxMatchUses: 2 }, 3), /目标 5 组.*生成 3 组.*最多2组.*未自动放宽/);
  assert.doesNotMatch(parlaySelectionSummary({ limit: 5, maxMatchUses: 0 }, 5), /凑满/);
});

test("双选覆盖率按显示精度排名，同值并列且无效候选不排名", () => {
  const rows = [0.4851, 0.4852, 0.45, 0.51, NaN].map((probability, i) => ({
    id: String(i), markets: { goalsPair: { probability, eligible: true } },
  }));
  rows.push({ id: "disabled", markets: { goalsPair: { probability: 0.9, eligible: false } } });
  assert.deepEqual([...goalCoverageRanks(rows)], [["3", 1], ["0", 2], ["1", 2], ["2", 4]]);
  assert.equal(goalCoverageRanks([]).size, 0);
});

function market(market, odds, level) {
  return {
    market,
    odds,
    reliability: { level },
  };
}

test("stable selection switches a match to its eligible recommended market", () => {
  const candidates = [
    {
      id: "match-1",
      markets: {
        had: market("had", 2.1, "cautious"),
        hhad: market("hhad", 1.9, "recommended"),
      },
    },
  ];
  const currentMarkets = new Map([["match-1", "had"]]);

  const result = recommendedParlaySelection(candidates, {
    minLegOdds: 1.7,
    currentMarkets,
  });

  assert.deepEqual([...result.selected], ["match-1"]);
  assert.equal(result.markets.get("match-1"), "hhad");
});

test("stable selection keeps the current market when it is recommended", () => {
  const candidates = [
    {
      id: "match-1",
      markets: {
        had: market("had", 2.1, "recommended"),
        hhad: market("hhad", 1.9, "recommended"),
      },
    },
  ];
  const currentMarkets = new Map([["match-1", "hhad"]]);

  const result = recommendedParlaySelection(candidates, {
    minLegOdds: 1.7,
    currentMarkets,
  });

  assert.deepEqual([...result.selected], ["match-1"]);
  assert.equal(result.markets.get("match-1"), "hhad");
});

test("stable selection ignores recommended markets below the odds floor", () => {
  const candidates = [
    {
      id: "match-1",
      markets: {
        had: market("had", 1.5, "recommended"),
        hhad: market("hhad", 2.0, "cautious"),
      },
    },
  ];

  const result = recommendedParlaySelection(candidates, {
    minLegOdds: 1.7,
  });

  assert.equal(result.selected.size, 0);
});

test("goal-pair stable selection requires eligibility and recommendation", () => {
  const candidates = [
    {
      id: "match-1",
      markets: {
        goalsPair: {
          eligible: true,
          reliability: { level: "recommended" },
        },
      },
    },
    {
      id: "match-2",
      markets: {
        goalsPair: {
          eligible: false,
          reliability: { level: "recommended" },
        },
      },
    },
  ];

  const result = recommendedParlaySelection(candidates, {
    mode: "goalsPair",
  });

  assert.deepEqual([...result.selected], ["match-1"]);
  assert.equal(result.markets.get("match-1"), "goalsPair");
});
