import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGoalReliabilityObservation,
  buildThreeWayReliabilityObservations,
  reliabilityRuleMatches,
  tuneReliabilityPolicy,
} from "../lib/reliability-tuning.mjs";

test("three-way reliability builder preserves unavailable targets before time splitting", () => {
  const odds = [2, 3, 4];
  const events = [
    { sourceRow: 1, result: "胜", odds },
    { sourceRow: 2, result: "平", odds },
    { sourceRow: 3, result: "胜", odds },
    { sourceRow: 4, result: "负", odds: [9, 9, 9] },
    { sourceRow: 5, result: "负", odds },
  ].map((row) => ({
    sourceFile: "history.xlsx",
    sourceRow: row.sourceRow,
    league: "测试联赛",
    spf: {
      sourceFile: "history.xlsx",
      sourceRow: row.sourceRow,
      league: "测试联赛",
      result: row.result,
      odds: row.odds,
    },
    hhad: null,
    pair: null,
  }));
  const built = buildThreeWayReliabilityObservations(
    events,
    "spf",
    { spf: 0.07, hhad: 0.07 },
    { warmup: 2 },
  );

  assert.equal(built.observations.length, 3);
  assert.equal(built.observations[0].available, true);
  assert.equal(built.observations[1].available, false);
  assert.equal(built.observations[2].available, true);
  assert.deepEqual(built.observations[0].odds, odds);
});

test("reliability tuning enables a rule that repeats across later segments", () => {
  const observations = Array.from({ length: 2000 }, (_, index) => {
    const strong = index % 5 < 2;
    return {
      available: true,
      samples: strong ? 120 : 35,
      topProbability: strong ? 0.72 : 0.43,
      margin: strong ? 0.35 : 0.08,
      consensus: strong ? 1 : 0.5,
      stable: strong,
      correct: strong ? 1 : index % 4 === 0 ? 1 : 0,
    };
  });
  const result = tuneReliabilityPolicy(observations, { threshold: 0.1 });
  assert.equal(result.enabled, true);
  assert.equal(result.gate.passed, true);
  assert.ok(result.test.selected >= 100);
  assert.ok(result.test.accuracyLift >= 0.02);
});

test("reliability rule checks samples, probability, margin and stability", () => {
  const rule = {
    minSamples: 30,
    minTopProbability: 0.55,
    minMargin: 0.15,
    minConsensus: 0.75,
    requireStable: true,
  };
  assert.equal(
    reliabilityRuleMatches(
      {
        available: true,
        samples: 40,
        topProbability: 0.6,
        margin: 0.2,
        consensus: 1,
        stable: true,
      },
      rule,
    ),
    true,
  );
  assert.equal(
    reliabilityRuleMatches(
      {
        available: true,
        samples: 40,
        topProbability: 0.6,
        margin: 0.2,
        consensus: 1,
        stable: false,
      },
      rule,
    ),
    false,
  );
});

test("goal reliability observation uses production similarity weights and four pool sizes", () => {
  const target = { goals: "3", odds: [20, 8, 4.5, 3.3, 4.2, 7, 12, 16] };
  const similar = [
    { goals: "2", similarityWeight: 1 },
    { goals: "3", similarityWeight: 1 },
    { goals: "3", similarityWeight: 1 },
    { goals: "3", similarityWeight: 1 },
  ];
  const observation = buildGoalReliabilityObservation(target, similar, {
    bandwidth: 0.02,
  });
  assert.equal(observation.available, true);
  assert.equal(observation.samples, 4);
  // 防零层生效：4 样本、八分类，(3+0.1875)/(4+1.5)=0.5795，
  // 裸占比 0.75 被收缩。consensus 与 correct 不受影响。
  assert.equal(Number(observation.topProbability.toFixed(4)), 0.5795);
  assert.equal(Number(observation.margin.toFixed(4)), 0.3636);
  assert.equal(observation.consensus, 0.5);
  assert.equal(observation.stable, false);
  assert.equal(observation.correct, 1);
});

test("goal reliability observation is unavailable without historical samples", () => {
  const observation = buildGoalReliabilityObservation(
    { goals: "2", odds: [20, 8, 4.5, 3.3, 4.2, 7, 12, 16] },
    [],
  );
  assert.deepEqual(observation, {
    available: false,
    samples: 0,
    topProbability: 0,
    margin: 0,
    stable: false,
    consensus: 0,
    correct: 0,
  });
});
