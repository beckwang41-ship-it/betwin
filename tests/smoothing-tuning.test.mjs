import test from "node:test";
import assert from "node:assert/strict";
import { tuneHistoricalSmoothing } from "../lib/smoothing-tuning.mjs";
import { spfDistance } from "../lib/predictor.mjs";

test("smoothing tuning keeps the latest segment independent and reports a gate", () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    sourceFile: "history.xlsx",
    sourceRow: index + 1,
    league: index % 2 ? "英超" : "西甲",
    odds: [2, 3.2, 4],
    result: ["胜", "平", "负"][index % 3],
  }));
  const result = tuneHistoricalSmoothing(rows, {
    labels: ["胜", "平", "负"],
    outcomeField: "result",
    distance: (left, right) => spfDistance(left.odds, right.odds),
    threshold: 0.07,
    strengths: [2, 5],
    warmup: 10,
    validationFraction: 0.2,
    minLocalizedSamples: 3,
  });

  assert.equal(result.baseline.tuning.evaluated, 22);
  assert.equal(result.baseline.validation.evaluated, 8);
  assert.ok([2, 5].includes(result.candidateStrength));
  assert.equal(typeof result.gate.passed, "boolean");
  assert.equal(result.production.enabled, result.gate.passed);
});
