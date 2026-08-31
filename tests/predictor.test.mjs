import test from "node:test";
import assert from "node:assert/strict";
import {
  distribution,
  distanceWeight,
  findSimilarGoalMovements,
  findSimilarSpfMovements,
  findSimilarGoals,
  findSimilarSpf,
  normalizeOdds,
  paginate,
  predictGoals,
  predictGoalsWithMovement,
  selectTopGoalPair,
  predictSpf,
  predictSpfWithMovement,
  probabilityMovement,
  spfDistance,
  summarizeStability,
  weightedDistribution,
} from "../lib/predictor.mjs";

test("goal pair selects the two outcomes with the highest historical probabilities", () => {
  const pair = selectTopGoalPair(
    [0.04, 0.28, 0.12, 0.24, 0.16, 0.1, 0.03, 0.03],
    [12, 5, 3.2, 3.4, 5.2, 9, 15, 25],
  );
  assert.equal(pair.available, true);
  assert.deepEqual(pair.indices, [1, 3]);
  assert.deepEqual(pair.labels, ["1", "3"]);
  assert.equal(pair.probability, 0.52);
  assert.deepEqual(pair.odds, [5, 3.4]);
  assert.equal(pair.stakeUnits, 2);
});

test("goal prediction exposes the top two outcomes without replacing exact pick", () => {
  const rows = [
    ...Array.from({ length: 6 }, () => ({ goals: "1" })),
    ...Array.from({ length: 4 }, () => ({ goals: "2" })),
    ...Array.from({ length: 5 }, () => ({ goals: "3" })),
  ];
  const prediction = predictGoals(
    [12, 5, 3.2, 3.4, 5.2, 9, 15, 25],
    rows,
    { empiricalOnly: true },
  );
  assert.equal(prediction.predicted, "1");
  assert.deepEqual(prediction.goalPair.labels, ["1", "3"]);
  // 防零层把 15 样本收缩为 (c+0.1875)/(15+1.5)，
  // 「1」+「3」= (6+0.1875+5+0.1875)/16.5 ≈ 0.6932，低于裸占比 11/15。
  // argmax 与配对选择均不变。
  assert.ok(
    Math.abs(prediction.goalPair.probability - 11.375 / 16.5) < 1e-9,
    `实际配对概率 ${prediction.goalPair.probability}`,
  );
});
import {
  selectHistoricalPrior,
  smoothHistoricalDistribution,
} from "../lib/smoothing.mjs";

test("normalizeOdds returns a valid probability distribution", () => {
  const probabilities = normalizeOdds([2, 3.2, 4.1]);
  assert.ok(Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.equal(probabilities.indexOf(Math.max(...probabilities)), 0);
});

test("SPF similarity requires every odd to stay within tolerance", () => {
  const history = [
    { league: "英超", odds: [2.05, 3.25, 3.9], result: "胜" },
    { league: "英超", odds: [2.05, 3.25, 5.2], result: "负" },
  ];
  const similar = findSimilarSpf(history, [2, 3.2, 4], { tolerance: 0.1 });
  assert.equal(similar.length, 1);
  assert.equal(similar[0].result, "胜");
});

test("goal similarity compares normalized eight-outcome probabilities", () => {
  const target = [12, 4.8, 3.5, 3.7, 5.8, 10.5, 19, 29];
  const history = [
    { league: "韩职", odds: [...target], goals: "2" },
    { league: "韩职", odds: [3, 3, 3, 3, 3, 3, 3, 3], goals: "4" },
  ];
  const similar = findSimilarGoals(history, target, { tolerance: 0.001 });
  assert.equal(similar.length, 1);
  assert.equal(similar[0].goals, "2");
});

test("goal similarity requires every normalized probability band to pass", () => {
  const target = Array.from({ length: 8 }, () => 8);
  const oneBandTooFar = [6.25, ...Array.from({ length: 7 }, () => 25 / 3)];
  const similar = findSimilarGoals(
    [{ league: "测试", odds: oneBandTooFar, goals: "3" }],
    target,
    { tolerance: 0.03 },
  );
  assert.equal(similar.length, 0);
});

test("prediction blends market and empirical history", () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    result: index < 60 ? "胜" : index < 80 ? "平" : "负",
  }));
  const prediction = predictSpf([2.2, 3.2, 3.4], rows);
  assert.equal(prediction.stats.total, 100);
  assert.equal(prediction.predicted, "胜");
  assert.ok(prediction.empiricalWeight > 0);
});

test("final-odds policy uses history as a gate without changing market direction", () => {
  const odds = [1.8, 3.5, 4.5];
  const smallHistory = Array.from({ length: 10 }, () => ({ result: "负" }));
  const calibrated = predictSpf(odds, smallHistory, {
    enabled: false,
    requireSamples: true,
  });

  assert.equal(calibrated.predicted, "胜");
  assert.equal(calibrated.empiricalWeight, 0);
  assert.deepEqual(calibrated.final, calibrated.market);

  const noHistory = predictSpf(odds, [], {
    enabled: true,
    requireSamples: true,
  });
  assert.equal(noHistory.available, false);
  assert.equal(noHistory.predicted, null);
  assert.deepEqual(noHistory.final, [0, 0, 0]);
});

test("final-odds goal prediction keeps the normalized market distribution", () => {
  const prediction = predictGoals(
    [12, 5, 3.2, 3.4, 5.2, 9, 15, 25],
    Array.from({ length: 10 }, () => ({ goals: "7+" })),
    {
      enabled: false,
      requireSamples: true,
    },
  );

  assert.equal(prediction.predicted, "2");
  assert.equal(prediction.empiricalWeight, 0);
  assert.deepEqual(prediction.final, prediction.market);
});

test("validated fixed blend weight respects the minimum sample gate", () => {
  const rows = Array.from({ length: 40 }, () => ({ result: "负" }));
  const gated = predictSpf([2.2, 3.2, 3.4], rows, {
    enabled: true,
    fixedWeight: 0.2,
    minSamples: 50,
  });
  assert.equal(gated.empiricalWeight, 0);
  assert.deepEqual(gated.final, gated.market);

  const enabled = predictSpf([2.2, 3.2, 3.4], rows, {
    enabled: true,
    fixedWeight: 0.2,
    minSamples: 20,
  });
  assert.equal(enabled.empiricalWeight, 0.2);
  assert.ok(enabled.final[2] > enabled.market[2]);
});

test("historical-only SPF follows the similar result distribution", () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({
    result: index < 20 ? "胜" : index < 45 ? "平" : "负",
  }));
  const prediction = predictSpf([2, 3.2, 4], rows, {
    enabled: true,
    fixedWeight: 1,
    minSamples: 50,
  });

  assert.equal(prediction.empiricalWeight, 1);
  // 防零层把 20/25/5 收缩为 (c+0.5)/(50+1.5)，保序但不再是裸占比。
  assert.deepEqual(prediction.rawWeightedEmpirical, [0.4, 0.5, 0.1]);
  assert.deepEqual(
    prediction.final.map((value) => Number(value.toFixed(4))),
    [0.3981, 0.4951, 0.1068],
  );
  assert.equal(prediction.predicted, "平");
});

test("SPF prediction exposes every outcome tied for the highest probability", () => {
  const rows = [
    ...Array.from({ length: 6 }, () => ({ result: "胜" })),
    ...Array.from({ length: 2 }, () => ({ result: "平" })),
    ...Array.from({ length: 6 }, () => ({ result: "负" })),
  ];
  const prediction = predictSpf([2.85, 3.05, 2.22], rows, {
    empiricalOnly: true,
  });

  assert.equal(prediction.available, true);
  assert.equal(prediction.isTie, true);
  assert.deepEqual(prediction.topLabels, ["胜", "负"]);
});

test("empirical-only prediction accepts one or ten historical samples", () => {
  const spfRows = Array.from({ length: 10 }, (_, index) => ({
    result: index < 2 ? "胜" : index < 8 ? "平" : "负",
  }));
  const spf = predictSpf([2, 3.2, 4], spfRows, {
    empiricalOnly: true,
  });
  assert.equal(spf.available, true);
  assert.deepEqual(spf.rawWeightedEmpirical, [0.2, 0.6, 0.2]);
  // 10 样本、总先验质量 1.5：先验占 13.0%，argmax 不变。
  assert.deepEqual(
    spf.final.map((value) => Number(value.toFixed(4))),
    [0.2174, 0.5652, 0.2174],
  );
  assert.equal(spf.predicted, "平");

  const goals = predictGoals(
    [12, 4.8, 3.5, 3.7, 5.8, 10.5, 19, 29],
    [{ goals: "4" }],
    { empiricalOnly: true },
  );
  assert.equal(goals.available, true);
  // 单样本不再报 100%：防零层把它压到 (1+0.1875)/(1+1.5)=47.5%，
  // 其余 7 格各得 0.1875/2.5=7.5%。argmax 仍是「4」。
  assert.equal(goals.rawWeightedEmpirical[4], 1);
  assert.equal(Number(goals.final[4].toFixed(4)), 0.475);
  assert.ok(goals.final.every((value) => value > 0));
  assert.equal(goals.predicted, "4");
});

test("empirical-only prediction does not fall back to odds with zero samples", () => {
  const spf = predictSpf([2, 3.2, 4], [], {
    empiricalOnly: true,
  });
  assert.equal(spf.available, false);
  assert.equal(spf.predicted, null);
  assert.deepEqual(spf.final, [0, 0, 0]);
  assert.notDeepEqual(spf.final, spf.market);

  const goals = predictGoals(
    [12, 4.8, 3.5, 3.7, 5.8, 10.5, 19, 29],
    [],
    { empiricalOnly: true },
  );
  assert.equal(goals.available, false);
  assert.equal(goals.predicted, null);
  assert.ok(Number.isFinite(goals.expected));
  assert.equal(goals.historicalExpected, null);
});

test("historical prior prefers a sufficiently large same-league nearby pool", () => {
  const target = { league: "英超", odds: [2, 3.2, 4] };
  const history = [
    ...Array.from({ length: 3 }, () => ({
      league: "英超",
      odds: [2.05, 3.15, 4.1],
      result: "胜",
    })),
    ...Array.from({ length: 5 }, () => ({
      league: "西甲",
      odds: [2.03, 3.18, 4.05],
      result: "负",
    })),
  ];
  const prior = selectHistoricalPrior(history, target, {
    labels: ["胜", "平", "负"],
    outcomeField: "result",
    distance: (left, right) => spfDistance(left.odds, right.odds),
    relaxedTolerance: 0.15,
    minLocalizedSamples: 3,
  });

  assert.equal(prior.source, "same-league-nearby");
  assert.equal(prior.sampleSize, 3);
  assert.deepEqual(prior.probabilities, [1, 0, 0]);
});

test("historical smoothing exposes a stable reference without changing production", () => {
  const smoothing = smoothHistoricalDistribution([0.75, 0, 0.25], 4, {
    enabled: false,
    strength: 4,
    prior: {
      source: "all-history",
      sourceLabel: "全部历史基础分布",
      sampleSize: 100,
      probabilities: [0.4, 0.3, 0.3],
    },
  });

  assert.equal(smoothing.applied, false);
  assert.equal(smoothing.referenceOnly, true);
  assert.deepEqual(smoothing.probabilities, [0.575, 0.15, 0.275]);
});

test("validated historical smoothing changes final prediction but retains raw counts", () => {
  const rows = [
    { result: "胜" },
    { result: "胜" },
    { result: "负" },
  ];
  const prediction = predictSpf([2, 3.2, 4], rows, {
    empiricalOnly: true,
    smoothing: {
      enabled: true,
      validated: true,
      strength: 6,
      prior: {
        source: "all-history",
        sourceLabel: "全部历史基础分布",
        sampleSize: 100,
        probabilities: [0.2, 0.6, 0.2],
      },
    },
  });

  assert.deepEqual(prediction.stats.counts, { 胜: 2, 平: 0, 负: 1 });
  assert.deepEqual(prediction.empirical, [2 / 3, 0, 1 / 3]);
  assert.equal(prediction.smoothing.applied, true);
  assert.deepEqual(prediction.final, prediction.stableEmpirical);
  assert.equal(prediction.predicted, "平");
});

test("dynamic historical smoothing uses inverse sample strength", () => {
  const smoothing = smoothHistoricalDistribution([1, 0, 0], 10, {
    enabled: true,
    validated: true,
    strengthMode: "inverse-samples",
    dynamicNumerator: 20,
    minStrength: 1,
    maxStrength: 20,
    prior: {
      source: "adjusted-market",
      probabilities: [0.4, 0.3, 0.3],
    },
  });

  assert.equal(smoothing.strength, 2);
  assert.equal(smoothing.strengthMode, "inverse-samples");
  assert.ok(Math.abs(smoothing.probabilities[0] - 0.9) < 1e-12);
  assert.ok(Math.abs(smoothing.probabilities[1] - 0.05) < 1e-12);
  assert.ok(Math.abs(smoothing.probabilities[2] - 0.05) < 1e-12);
});

test("distribution and pagination retain all records", () => {
  const rows = [
    { result: "胜" },
    { result: "胜" },
    { result: "平" },
    { result: "负" },
  ];
  assert.deepEqual(distribution(rows, "result", ["胜", "平", "负"]).counts, {
    胜: 2,
    平: 1,
    负: 1,
  });
  const page = paginate(rows, 2, 3);
  assert.equal(page.rows.length, 1);
  assert.equal(page.total, 4);
  assert.equal(page.totalPages, 2);
});

test("distance weighting keeps every threshold match but favors closer samples", () => {
  const rows = [
    { result: "胜", distance: 0 },
    { result: "负", distance: 0.07 },
  ];
  const weighted = weightedDistribution(rows, "result", ["胜", "平", "负"], {
    enabled: true,
    tolerance: 0.07,
    floor: 0.2,
    power: 2,
  });

  assert.deepEqual(weighted.raw.counts, { 胜: 1, 平: 0, 负: 1 });
  assert.equal(weighted.raw.total, 2);
  assert.equal(weighted.coreSamples, 1);
  assert.ok(Math.abs(weighted.probabilities["胜"] - 5 / 6) < 1e-12);
  assert.ok(Math.abs(weighted.probabilities["负"] - 1 / 6) < 1e-12);
  assert.ok(weighted.effectiveSamples > 1);
  assert.ok(weighted.effectiveSamples < 2);
  assert.ok(weighted.minimumWeight > 0);
});

test("precomputed composite weights are used for goal similarity", () => {
  const weighted = weightedDistribution(
    [
      { goals: "2", distance: 0.01, similarityWeight: 1 },
      { goals: "3", distance: 0.02, similarityWeight: 0.25 },
    ],
    "goals",
    ["0", "1", "2", "3", "4", "5", "6", "7+"],
    {
      enabled: true,
      weightField: "similarityWeight",
      method: "exponential-composite-distance",
    },
  );
  assert.equal(weighted.method, "exponential-composite-distance");
  assert.equal(weighted.raw.total, 2);
  assert.ok(Math.abs(weighted.probabilities["2"] - 0.8) < 1e-12);
  assert.ok(Math.abs(weighted.probabilities["3"] - 0.2) < 1e-12);
});

test("historical-only prediction uses weighted similarity while retaining raw counts", () => {
  const prediction = predictSpf(
    [2, 3.2, 4],
    [
      { result: "胜", distance: 0 },
      { result: "负", distance: 0.07 },
    ],
    {
      empiricalOnly: true,
      weighting: {
        enabled: true,
        tolerance: 0.07,
        floor: 0.2,
        power: 2,
      },
    },
  );

  assert.equal(prediction.stats.total, 2);
  assert.deepEqual(prediction.empirical, [0.5, 0, 0.5]);
  assert.ok(prediction.final[0] > prediction.empirical[0]);
  assert.deepEqual(prediction.final, prediction.weightedEmpirical);
  assert.equal(prediction.predicted, "胜");
});

test("stability requires every threshold to have one identical unique direction", () => {
  const stable = summarizeStability([
    { threshold: 0.03, available: true, isTie: false, predicted: "负" },
    { threshold: 0.05, available: true, isTie: false, predicted: "负" },
    { threshold: 0.07, available: true, isTie: false, predicted: "负" },
    { threshold: 0.1, available: true, isTie: false, predicted: "负" },
  ]);
  assert.equal(stable.status, "stable");
  assert.equal(stable.direction, "负");

  const unstable = summarizeStability([
    { threshold: 0.03, available: true, isTie: false, predicted: "胜" },
    { threshold: 0.05, available: true, isTie: false, predicted: "负" },
  ]);
  assert.equal(unstable.status, "unstable");
  assert.equal(unstable.direction, null);

  const insufficient = summarizeStability([
    { threshold: 0.03, available: false, isTie: false, predicted: null },
    { threshold: 0.05, available: true, isTie: false, predicted: "负" },
  ]);
  assert.equal(insufficient.status, "insufficient");
});

test("single-match contribution uses the same positive distance weight as prediction", () => {
  const options = { enabled: true, tolerance: 0.07, floor: 0.2, power: 2 };
  assert.equal(distanceWeight(0, options), 1);
  assert.ok(Math.abs(distanceWeight(0.07, options) - 0.2) < 1e-12);
  assert.ok(distanceWeight(0.035, options) > 0.2);
});

test("probability movement is calculated after removing the bookmaker margin", () => {
  const movement = probabilityMovement(
    [2.5, 3.2, 2.8],
    [2.2, 3.3, 3.2],
  );
  assert.equal(movement.applied, true);
  assert.ok(movement.delta[0] > 0);
  assert.ok(movement.delta[2] < 0);
  assert.ok(Math.abs(movement.delta.reduce((sum, value) => sum + value, 0)) < 1e-12);
});

test("movement similarity requires compatible opening odds and probability shifts", () => {
  const targetInitial = [2.5, 3.2, 2.8];
  const targetFinal = [2.2, 3.3, 3.2];
  const history = [
    {
      league: "英超",
      initialOdds: [2.48, 3.18, 2.82],
      odds: [2.21, 3.28, 3.18],
      result: "胜",
    },
    {
      league: "英超",
      initialOdds: [2.48, 3.18, 2.82],
      odds: [2.8, 3.2, 2.5],
      result: "负",
    },
  ];
  const similar = findSimilarSpfMovements(
    history,
    targetInitial,
    targetFinal,
    {
      finalTolerance: 0.3,
      initialTolerance: 0.1,
      movementTolerance: 0.02,
    },
  );
  assert.equal(similar.length, 1);
  assert.equal(similar[0].result, "胜");
});

test("SPF movement prediction falls back without a real odds change", () => {
  const odds = [2.2, 3.2, 3.4];
  const baseRows = Array.from({ length: 80 }, (_, index) => ({
    result: index < 40 ? "胜" : index < 60 ? "平" : "负",
  }));
  const prediction = predictSpfWithMovement(
    odds,
    baseRows,
    baseRows,
    odds,
  );
  assert.equal(prediction.movement.applied, false);
  assert.equal(prediction.movement.reason, "no-change");
  assert.deepEqual(prediction.final, prediction.baseline);
});

test("SPF movement prediction applies a bounded trend correction", () => {
  const finalOdds = [2.2, 3.2, 3.4];
  const initialOdds = [2.5, 3.2, 2.9];
  const baseRows = Array.from({ length: 100 }, (_, index) => ({
    result: index < 40 ? "胜" : index < 70 ? "平" : "负",
  }));
  const movementRows = Array.from({ length: 120 }, (_, index) => ({
    result: index < 84 ? "胜" : index < 102 ? "平" : "负",
  }));
  const prediction = predictSpfWithMovement(
    finalOdds,
    baseRows,
    movementRows,
    initialOdds,
  );
  assert.equal(prediction.movement.applied, true);
  assert.ok(prediction.final[0] > prediction.baseline[0]);
  assert.ok(prediction.movement.weight > 0);
  assert.ok(prediction.movement.weight <= 0.15);
  assert.ok(Math.abs(prediction.final.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
});

test("reference-only movement never changes the final probabilities", () => {
  const finalOdds = [2.2, 3.2, 3.4];
  const initialOdds = [2.5, 3.2, 2.9];
  const baseRows = Array.from({ length: 100 }, (_, index) => ({
    result: index < 40 ? "胜" : index < 70 ? "平" : "负",
  }));
  const movementRows = Array.from({ length: 120 }, (_, index) => ({
    result: index < 84 ? "胜" : index < 102 ? "平" : "负",
  }));

  const prediction = predictSpfWithMovement(
    finalOdds,
    baseRows,
    movementRows,
    initialOdds,
    { applyCorrection: false },
  );

  assert.equal(prediction.movement.applied, false);
  assert.equal(prediction.movement.referenceOnly, true);
  assert.equal(prediction.movement.reason, "reference-only");
  assert.equal(prediction.movement.weight, 0);
  assert.deepEqual(prediction.final, prediction.baseline);
});

test("goal movement matching and prediction support eight probability bands", () => {
  const initial = [12, 4.8, 3.5, 3.7, 5.8, 10.5, 19, 29];
  const final = [13, 5, 3.6, 3.5, 5.5, 10, 18, 28];
  const rows = Array.from({ length: 40 }, (_, index) => ({
    initialOdds: initial.map((value) => value * (1 + (index % 2) * 0.001)),
    odds: [...final],
    goals: index < 20 ? "3" : "2",
  }));
  const similar = findSimilarGoalMovements(rows, initial, final, {
    finalTolerance: 0.005,
    initialTolerance: 0.01,
    movementTolerance: 0.005,
  });
  const prediction = predictGoalsWithMovement(
    final,
    rows,
    similar,
    initial,
  );
  assert.equal(similar.length, 40);
  assert.equal(prediction.movement.applied, true);
  assert.equal(prediction.final.length, 8);
  assert.ok(Number.isFinite(prediction.expected));
});
