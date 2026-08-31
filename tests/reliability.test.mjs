import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateReliability,
  summarizeHistoricalSupport,
} from "../lib/reliability.mjs";

const policy = {
  enabled: true,
  rule: {
    threshold: 0.07,
    minSamples: 20,
    minTopProbability: 0.6,
    minMargin: 0.3,
    requireStable: true,
    minConsensus: 1,
  },
  test: {
    selected: 300,
    selectedAccuracy: 0.7,
    coverage: 0.2,
  },
  gate: { passed: true, reason: "验证通过" },
};

const prediction = {
  available: true,
  isTie: false,
  labels: ["胜", "平", "负"],
  predicted: "胜",
  empirical: [0.65, 0.2, 0.15],
  final: [0.5, 0.3, 0.2],
  stats: { total: 120 },
};

const stable = {
  status: "supported",
  supportCount: 4,
  supportRate: 1,
  points: [0.03, 0.05, 0.07, 0.1].map((threshold) => ({
    threshold,
    available: true,
    historicalIsTie: false,
    historicalPredicted: "胜",
    supportsFinal: true,
    supportProbability: 0.65,
  })),
};

test("historical support summarizes agreement with the precomputed prediction direction", () => {
  const result = summarizeHistoricalSupport([
    ...stable.points.slice(0, 3),
    {
      threshold: 0.1,
      available: true,
      historicalIsTie: false,
      historicalPredicted: "负",
      supportsFinal: false,
      supportProbability: 0.25,
    },
  ]);
  assert.equal(result.status, "mixed");
  assert.equal(result.supportCount, 3);
  assert.equal(result.supportRate, 0.75);
});

test("selected threshold determines the historical direction used by every stability point", () => {
  const points = [
    { threshold: 0.03, probabilities: [0.5, 0.3, 0.2], predicted: "胜" },
    { threshold: 0.05, probabilities: [0.4, 0.35, 0.25], predicted: "胜" },
    { threshold: 0.07, probabilities: [0.3, 0.4, 0.3], predicted: "平" },
    { threshold: 0.1, probabilities: [0.25, 0.5, 0.25], predicted: "平" },
  ].map((point) => ({
    ...point,
    labels: ["胜", "平", "负"],
    available: true,
    historicalIsTie: false,
    historicalPredicted: point.predicted,
    historicalProbabilities: point.probabilities,
    supportsFinal: false,
    supportProbability: 0,
  }));

  const result = summarizeHistoricalSupport(points, 0.1);
  assert.equal(result.direction, "平");
  assert.equal(result.status, "mixed");
  assert.equal(result.supportCount, 2);
  assert.deepEqual(
    result.points.map((point) => point.supportsFinal),
    [false, false, true, true],
  );
  assert.equal(result.points[0].supportProbability, 0.3);
});

test("validated selection rule marks a matching prediction as recommended", () => {
  const result = evaluateReliability({
    prediction,
    stability: stable,
    policy,
    threshold: 0.07,
  });
  assert.equal(result.level, "recommended");
  assert.equal(result.observed.samples, 120);
  assert.equal(result.observed.stable, true);
  assert.equal(result.observed.consensus, 1);
  assert.equal(result.observed.marketTopProbability, 0.5);
  assert.equal(result.observed.historicalSupportProbability, 0.65);
});

test("manual threshold changes make a validated rule cautious", () => {
  const result = evaluateReliability({
    prediction,
    stability: stable,
    policy,
    threshold: 0.1,
  });
  assert.equal(result.level, "cautious");
  assert.match(result.reason, /阈值/);
});

test("missing history or tied directions are skipped", () => {
  const noHistory = evaluateReliability({
    prediction: {
      ...prediction,
      available: false,
      stats: { total: 0 },
    },
    stability: stable,
    policy,
    threshold: 0.07,
  });
  assert.equal(noHistory.level, "skip");

  const tied = evaluateReliability({
    prediction: { ...prediction, isTie: true },
    stability: stable,
    policy,
    threshold: 0.07,
  });
  assert.equal(tied.level, "skip");
});

test("history opposing the prediction direction cannot be recommended", () => {
  const opposed = summarizeHistoricalSupport(
    stable.points.map((point) => ({
      ...point,
      historicalPredicted: "负",
      supportsFinal: false,
      supportProbability: 0.15,
    })),
  );
  const result = evaluateReliability({
    prediction,
    stability: opposed,
    policy,
    threshold: 0.07,
  });
  assert.equal(result.level, "cautious");
  assert.equal(result.observed.consensus, 0);
  assert.match(result.reason, /历史/);
});
