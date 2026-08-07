import test from "node:test";
import assert from "node:assert/strict";
import { evaluateReliability } from "../lib/reliability.mjs";

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
  empirical: [0.65, 0.2, 0.15],
  final: [0.65, 0.2, 0.15],
  stats: { total: 120 },
};

const stable = {
  status: "stable",
  points: [0.03, 0.05, 0.07, 0.1].map((threshold) => ({
    threshold,
    available: true,
    isTie: false,
    predicted: "胜",
  })),
};

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
