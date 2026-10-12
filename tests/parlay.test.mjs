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

test("常规与双选按原排名筛选，遵守每场使用上限且不足时不放宽", () => {
  const goals = candidates.map(c => ({ ...c, selections: [
    { label: "2", odds: 3, probability: c.probability / 2 },
    { label: "3", odds: 4, probability: c.probability / 2 },
  ] }));
  for (const [generate, pool] of [[generateParlayCombinations, candidates], [generateGoalPairParlays, goals]]) {
    const base = generate(pool, { limit: 20, targetOdds: 1 });
    const once = generate(pool, { limit: 5, maxMatchUses: 1, targetOdds: 1 });
    assert.equal(once.rows.length, 2);
    assert.equal(once.rows[0].id, base.rows[0].id);
    assert.equal(new Set(once.rows.flatMap(r => r.legs.map(l => l.id))).size, 4);
    const twice = generate(pool, { limit: 5, maxMatchUses: 2, targetOdds: 1 });
    const uses = new Map();
    twice.rows.flatMap(r => r.legs).forEach(l => uses.set(l.id, (uses.get(l.id) || 0) + 1));
    assert.ok([...uses.values()].every(n => n <= 2));
    assert.equal(twice.settings.maxMatchUses, 2);
    assert.deepEqual(generate(pool, { limit: 2, maxMatchUses: 0, targetOdds: 1 }).rows, base.rows.slice(0, 2));
    assert.equal(generate(pool.slice(0, 1), { maxMatchUses: 1 }).rows.length, 0);
    for (const legs of [3, 4, 5]) {
      const result = generate(pool, { legs, limit: 5, maxMatchUses: 1, targetOdds: 1 });
      assert.equal(result.rows.length, legs > pool.length ? 0 : 1);
    }
    assert.throws(() => generate(pool, { maxMatchUses: 3 }), /使用次数/);
  }
});

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

test("parlay output reports market alignment without claiming validated advantage", () => {
  const result = generateParlayCombinations(
    [
      {
        id: "a",
        odds: 1.8,
        probability: 0.6,
        marketComparison: {
          status: "market-aligned",
          actionable: false,
        },
      },
      {
        id: "b",
        odds: 2.2,
        probability: 0.45,
        marketComparison: {
          status: "historical-divergence",
          actionable: false,
        },
      },
    ],
    { legs: 2, targetOdds: 1 },
  );
  assert.deepEqual(result.rows[0].marketAssessment, {
    marketAlignedLegs: 1,
    historicalDivergenceLegs: 1,
    unknownLegs: 0,
    validatedAdvantageLegs: 0,
    hasValidatedAdvantage: false,
    presentation: "calculator-only",
  });
});

test("常规串关默认按估算命中率排序", () => {
  const result = generateParlayCombinations(candidates, {
    legs: 2,
    targetOdds: 1,
  });
  assert.equal(result.settings.sort, "probability");
  assert.ok(result.rows[0].hitProbability >= result.rows.at(-1).hitProbability);
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

test("进球双选支持3串1并展开为8注", () => {
  const goalCandidates = ["a", "b", "c"].map((id) => ({
    id,
    probability: 0.7,
    selections: [
      { label: "2", probability: 0.4, odds: 2 },
      { label: "3", probability: 0.3, odds: 3 },
    ],
  }));
  const result = generateGoalPairParlays(goalCandidates, { legs: 3 });
  const row = result.rows[0];

  assert.equal(result.settings.legs, 3);
  assert.equal(result.settings.stakePerCombination, 8);
  assert.equal(row.ticketCount, 8);
  assert.equal(row.totalStake, 8);
  assert.equal(row.tickets.length, 8);
  assert.ok(row.tickets.every((ticket) => ticket.selections.length === 3));
  assert.equal(row.minimumTicketOdds, 8);
  assert.equal(row.maximumTicketOdds, 27);
  assert.equal(row.hitProbability, 0.343);
  assert.equal(row.expectedReturn, 4.913);
});

test("进球双选支持5串1并按32注计成本", () => {
  const goalCandidates = ["a", "b", "c", "d", "e"].map((id) => ({
    id,
    probability: 0.6,
    selections: [
      { label: "1", probability: 0.32, odds: 3.1 },
      { label: "2", probability: 0.28, odds: 3.5 },
    ],
  }));
  const result = generateGoalPairParlays(goalCandidates, { legs: 5 });

  assert.equal(result.total, 1);
  assert.equal(result.settings.legs, 5);
  assert.equal(result.settings.stakePerCombination, 32);
  assert.equal(result.rows[0].tickets.length, 32);
  assert.equal(result.rows[0].totalStake, 32);
  assert.ok(
    result.rows[0].tickets.every((ticket) => ticket.selections.length === 5),
  );
});

test("进球双选候选少于所选关数时返回空组合", () => {
  const result = generateGoalPairParlays(
    ["a", "b"].map((id) => ({
      id,
      probability: 0.6,
      selections: [
        { label: "1", probability: 0.32, odds: 3.1 },
        { label: "2", probability: 0.28, odds: 3.5 },
      ],
    })),
    { legs: 3 },
  );

  assert.equal(result.total, 0);
  assert.equal(result.rows.length, 0);
  assert.equal(result.settings.legs, 3);
  assert.equal(result.settings.stakePerCombination, 8);
});

test("进球双选默认严格按联合命中率排序", () => {
  const candidate = (id, probability, odds) => ({
    id,
    probability,
    selections: [
      { label: "2", probability: probability / 2, odds },
      { label: "3", probability: probability / 2, odds },
    ],
  });
  const result = generateGoalPairParlays(
    [
      candidate("a", 0.9, 10),
      candidate("b", 0.8, 2),
      candidate("c", 0.7, 2),
      candidate("d", 0.6, 10),
      candidate("e", 0.5, 10),
    ],
    { legs: 3, sort: "probability", limit: 100 },
  );

  for (let index = 1; index < result.rows.length; index += 1) {
    assert.ok(
      result.rows[index - 1].hitProbability >=
        result.rows[index].hitProbability,
      "联合命中率不得因最低覆盖率或赔率更高而逆序",
    );
  }
  assert.ok(
    result.rows.findIndex((row) => row.id === "b__c__e") <
      result.rows.findIndex((row) => row.id === "a__d__e"),
    "最低覆盖率和平均覆盖率相同时，联合命中率更高的组合必须在前",
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

test("每个组合都带上市场无优势假设下的基准返还率", () => {
  // 基准返还率只取决于关数（0.886^n），用于提示水钱复合；它不是收益上限。
  for (const [legs, expected] of [
    [2, 0.785],
    [3, 0.6955],
    [4, 0.6162],
  ]) {
    const result = generateParlayCombinations(candidates, {
      legs,
      targetOdds: 1,
      limit: 50,
    });
    assert.ok(result.rows.length > 0, "该关数应能生成组合");
    for (const row of result.rows) {
      assert.ok(
        Math.abs(row.marketBaselineRtp - expected) < 1e-3,
        "市场基准返还率应等于 0.886 的关数次方",
      );
      assert.ok(row.marketBaselineRtp < 1);
    }
  }
});

test("关数越多市场无优势基准返还率越低", () => {
  const ceilings = [2, 3, 4].map((legs) => {
    const result = generateParlayCombinations(candidates, {
      legs,
      targetOdds: 1,
      limit: 1,
    });
    return result.rows[0]?.marketBaselineRtp ?? null;
  });
  for (let index = 1; index < ceilings.length; index += 1) {
    if (ceilings[index] === null) continue;
    assert.ok(
      ceilings[index] < ceilings[index - 1],
      "关数增加时市场无优势基准返还率必须下降",
    );
  }
});

// 带稳定性字段的候选，用于验证「稳定优先」排序。
// stabilityTopProbability / stabilityMargin 来自 reliability.observed，
// reliabilityLevel 为 "recommended" 表示通过了该玩法的已验证筛选规则。
const stabilityCandidates = [
  {
    id: "s1",
    odds: 1.75,
    probability: 0.7,
    stabilityTopProbability: 0.71,
    stabilityMargin: 0.54,
    stabilityConsensus: 1,
    reliabilityLevel: "recommended",
  },
  {
    id: "s2",
    odds: 1.8,
    probability: 0.68,
    stabilityTopProbability: 0.7,
    stabilityMargin: 0.5,
    stabilityConsensus: 1,
    reliabilityLevel: "recommended",
  },
  {
    id: "s3",
    odds: 4.5,
    probability: 0.99,
    stabilityTopProbability: 0.62,
    stabilityMargin: 0.3,
    stabilityConsensus: 0.75,
    reliabilityLevel: "cautious",
  },
];

test("最弱一环取组合内历史占比最低的那关", () => {
  const result = generateParlayCombinations(stabilityCandidates, {
    legs: 2,
    targetOdds: 1,
    sort: "stability",
    limit: 10,
  });
  for (const row of result.rows) {
    const lowest = Math.min(
      ...row.legs.map((leg) => leg.stabilityTopProbability),
    );
    assert.equal(row.weakestTopProbability, lowest);
    const weakLeg = row.legs.find((leg) => leg.id === row.weakestLegId);
    assert.equal(weakLeg.stabilityTopProbability, lowest);
  }
});

test("稳定优先排序不能退化成乘积口径", () => {
  // s1+s2 弱环 0.70；s1+s3 弱环 0.62 但赔率与概率乘积都更高。
  // 稳定口径必须让 s1+s2 排第一，否则就是退回了有选择偏差的乘积排序。
  const result = generateParlayCombinations(stabilityCandidates, {
    legs: 2,
    targetOdds: 1,
    sort: "stability",
    limit: 10,
  });
  const first = result.rows[0];
  assert.deepEqual([...first.legs.map((leg) => leg.id)].sort(), ["s1", "s2"]);

  // 对照：按 value 排序时，弱环差但乘积高的组合会冒到前面
  const byValue = generateParlayCombinations(stabilityCandidates, {
    legs: 2,
    targetOdds: 1,
    sort: "value",
    limit: 10,
  });
  assert.ok(
    byValue.rows[0].weakestTopProbability < first.weakestTopProbability,
    "value 排序的首位弱环应当劣于 stability 排序的首位",
  );
});

test("信心等级按通过已验证规则的关数保守统计", () => {
  const allVerified = generateParlayCombinations(
    stabilityCandidates.filter((item) => item.id !== "s3"),
    { legs: 2, targetOdds: 1, sort: "stability", limit: 5 },
  );
  assert.equal(allVerified.rows[0].confidenceLevel, "高");
  assert.equal(allVerified.rows[0].recommendedLegs, 2);

  const mixed = generateParlayCombinations(
    [stabilityCandidates[0], stabilityCandidates[2]],
    { legs: 2, targetOdds: 1, sort: "stability", limit: 5 },
  );
  assert.equal(mixed.rows[0].confidenceLevel, "中");
  assert.equal(mixed.rows[0].recommendedLegs, 1);
});

test("组合含建议跳过关时信心等级必须降为低", () => {
  const withSkipped = generateParlayCombinations(
    [stabilityCandidates[0], { ...stabilityCandidates[2], reliabilityLevel: "skip" }],
    { legs: 2, targetOdds: 1, sort: "stability", limit: 5 },
  );
  assert.equal(withSkipped.rows[0].confidenceLevel, "低");
  assert.equal(withSkipped.rows[0].skippedLegs, 1);
});

test("缺少稳定性字段时不抛错且降级为最低信心", () => {
  const result = generateParlayCombinations(candidates, {
    legs: 2,
    targetOdds: 1,
    sort: "stability",
    limit: 3,
  });
  assert.ok(result.rows.length > 0);
  assert.equal(result.rows[0].weakestTopProbability, 0);
  assert.equal(result.rows[0].confidenceLevel, "低");
});
