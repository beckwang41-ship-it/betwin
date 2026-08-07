import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyGoalOdds,
  classifyThreeWayOdds,
  tuneSegmentThresholds,
} from "../lib/odds-segments.mjs";

test("three-way odds are assigned to stable market-shape segments", () => {
  assert.equal(classifyThreeWayOdds([1.35, 4.8, 8]), "home-strong");
  assert.equal(classifyThreeWayOdds([2.05, 3.2, 3.7]), "home-edge");
  assert.equal(classifyThreeWayOdds([2.65, 3.1, 2.7]), "balanced");
  assert.equal(classifyThreeWayOdds([5.5, 4.2, 1.55]), "away-strong");
});

test("goal odds are assigned by market expected-goal bands", () => {
  assert.equal(
    classifyGoalOdds([12, 5, 3, 2.4, 4, 8, 15, 25]),
    "mid-high",
  );
  assert.equal(
    classifyGoalOdds([30, 15, 8, 5, 3.5, 3, 4, 6]),
    "high",
  );
});

test("segment tuning keeps an unverified segment on the global baseline", () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    sourceFile: "history.xlsx",
    sourceRow: index + 1,
    segment: index % 2 ? "a" : "b",
    value: index % 3 ? 0.02 : 0.08,
    result: index % 2 ? "胜" : "负",
  }));
  const result = tuneSegmentThresholds(rows, {
    segments: ["a", "b"],
    labels: ["胜", "负"],
    outcomeField: "result",
    thresholds: [0.03, 0.1],
    baselineThreshold: 0.1,
    segmenter: (row) => row.segment,
    distance: (left, right) => Math.abs(left.value - right.value),
    warmup: 4,
    validationFraction: 0.25,
    minimumTuningCases: 100,
    minimumValidationCases: 2,
  });

  assert.equal(result.enabledSegments, 0);
  assert.equal(result.policies.a.enabled, false);
  assert.equal(result.policies.a.threshold, 0.1);
});
