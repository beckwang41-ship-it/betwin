import test from "node:test";
import assert from "node:assert/strict";
import {
  selectAdaptiveSimilarity,
  tuneAdaptiveMinimumSamples,
} from "../lib/adaptive-threshold.mjs";

function finder(history, _target, { tolerance }) {
  return history.filter((row) => row.distance <= tolerance);
}

test("adaptive similarity stops at the smallest range meeting the sample floor", () => {
  const history = [
    { distance: 0.01 },
    { distance: 0.04 },
    { distance: 0.05 },
    { distance: 0.08 },
  ];
  const result = selectAdaptiveSimilarity(history, [], {
    thresholds: [0.03, 0.05, 0.1],
    minSamples: 3,
    finder,
  });

  assert.equal(result.threshold, 0.05);
  assert.equal(result.samples, 3);
  assert.equal(result.reachedMinSamples, true);
  assert.deepEqual(result.attempts, [
    { threshold: 0.03, samples: 1 },
    { threshold: 0.05, samples: 3 },
  ]);
});

test("adaptive similarity falls back to the maximum range when still short", () => {
  const result = selectAdaptiveSimilarity(
    [{ distance: 0.04 }, { distance: 0.08 }],
    [],
    {
      thresholds: [0.03, 0.05, 0.1],
      minSamples: 5,
      finder,
    },
  );

  assert.equal(result.threshold, 0.1);
  assert.equal(result.samples, 2);
  assert.equal(result.reachedMinSamples, false);
});

test("adaptive minimum sample tuning validates against a fixed baseline", () => {
  const rows = Array.from({ length: 24 }, (_, index) => ({
    sourceFile: "history.xlsx",
    sourceRow: index + 1,
    value: index % 2 ? 0.08 : 0,
    result: index % 2 ? "主" : "客",
  }));
  const result = tuneAdaptiveMinimumSamples(rows, {
    labels: ["主", "客"],
    outcomeField: "result",
    thresholds: [0.05, 0.1],
    minSampleCandidates: [1, 2, 3, 5],
    baselineThreshold: 0.1,
    warmup: 4,
    validationFraction: 0.25,
    distance: (left, right) => Math.abs(left.value - right.value),
  });

  assert.equal(result.enabled, true);
  assert.equal(result.minSamples, 2);
  assert.equal(result.gate.tuningPassed, true);
  assert.equal(result.gate.validationPassed, true);
  assert.ok(result.selected.validationComparison.delta.logLoss < 0);
});
