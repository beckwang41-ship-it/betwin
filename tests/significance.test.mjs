import test from "node:test";
import assert from "node:assert/strict";
import {
  blockBootstrapComparison,
  classificationDelta,
} from "../lib/significance.mjs";

test("block bootstrap passes improvements that hold in every chronological block", () => {
  const cases = Array.from({ length: 120 }, (_, index) => ({
    sourceFile: "history.xlsx",
    order: index + 1,
    accuracy: index % 3 === 0 ? 0 : 0.1,
    logLoss: -0.05 - (index % 4) * 0.001,
    brier: -0.02 - (index % 5) * 0.001,
  }));
  const result = blockBootstrapComparison(cases, {
    iterations: 400,
    blockSize: 12,
    seed: 7,
  });

  assert.equal(result.passed, true);
  assert.ok(result.metrics.logLoss.upper < 0);
  assert.ok(result.metrics.brier.upper < 0);
  assert.ok(result.metrics.accuracy.lower >= 0);
});

test("block bootstrap rejects a tiny improvement with unstable blocks", () => {
  const cases = Array.from({ length: 120 }, (_, index) => {
    const weakBlock = Math.floor(index / 10) % 2 === 0;
    return {
      sourceFile: "history.xlsx",
      order: index + 1,
      accuracy: weakBlock ? -0.1 : 0.11,
      logLoss: weakBlock ? 0.04 : -0.042,
      brier: weakBlock ? 0.02 : -0.021,
    };
  });
  const result = blockBootstrapComparison(cases, {
    iterations: 600,
    blockSize: 10,
    seed: 9,
  });

  assert.equal(result.passed, false);
  assert.equal(result.status, "uncertain");
});

test("classification deltas use candidate minus baseline convention", () => {
  const value = classificationDelta(
    [0.7, 0.2, 0.1],
    [0.5, 0.3, 0.2],
    0,
  );

  assert.ok(value.logLoss < 0);
  assert.ok(value.brier < 0);
  assert.equal(value.accuracy, 0);
});
