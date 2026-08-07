import test from "node:test";
import assert from "node:assert/strict";
import { tuneMarketThreshold } from "../lib/parameter-tuning.mjs";

function alternatingRows(length, { reverseValidation = false } = {}) {
  return Array.from({ length }, (_, index) => {
    const cluster = index % 2;
    const inValidation = index >= Math.floor(length * 0.75);
    const reversed = reverseValidation && inValidation;
    return {
      sourceFile: "history.xlsx",
      sourceRow: index + 1,
      value: cluster ? 0.08 : 0,
      result:
        cluster === Number(reversed)
          ? "主"
          : "客",
    };
  });
}

function tune(rows) {
  return tuneMarketThreshold(rows, {
    labels: ["主", "客"],
    outcomeField: "result",
    tolerances: [0.05, 0.1],
    currentTolerance: 0.1,
    warmup: 4,
    validationFraction: 0.25,
    distance: (left, right) => Math.abs(left.value - right.value),
  });
}

function noisyRows(length, seed) {
  let state = seed;
  return Array.from({ length }, (_, index) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    const cluster = index % 2;
    const noisy = state / 2 ** 32 < 0.35;
    return {
      sourceFile: "history.xlsx",
      sourceRow: index + 1,
      value: cluster ? 0.08 : 0,
      result: cluster ^ Number(noisy) ? "主" : "客",
    };
  });
}

test("threshold tuning selects earlier and changes only after latest validation passes", () => {
  const result = tune(alternatingRows(24));

  assert.equal(result.candidateThreshold, 0.05);
  assert.equal(result.threshold, 0.05);
  assert.equal(result.changed, true);
  assert.equal(result.gate.tuningPassed, true);
  assert.equal(result.gate.validationPassed, true);
  assert.equal(result.sources[0].tuningCases, 14);
  assert.equal(result.sources[0].validationCases, 6);
  assert.ok(result.selected.validationComparison.delta.logLoss < 0);
  assert.ok(result.selected.validationComparison.delta.brier < 0);
});

test("threshold tuning rejects an earlier winner when latest validation reverses", () => {
  const result = tune(
    alternatingRows(24, { reverseValidation: true }),
  );

  assert.equal(result.candidateThreshold, 0.05);
  assert.equal(result.threshold, 0.1);
  assert.equal(result.changed, false);
  assert.equal(result.gate.tuningPassed, true);
  assert.equal(result.gate.validationPassed, false);
  assert.match(result.gate.reason, /保留当前阈值/);
});

test("performance-first policy adopts a repeatable improvement as provisional", () => {
  const result = tune(noisyRows(100, 13));

  assert.equal(result.candidateThreshold, 0.05);
  assert.equal(result.threshold, 0.05);
  assert.equal(result.changed, true);
  assert.equal(result.gate.validationPassed, true);
  assert.equal(result.gate.significancePassed, false);
  assert.equal(result.gate.confidence, "provisional");
  assert.match(result.gate.reason, /表现优先策略采用/);
});

test("threshold candidates report integer samples and independent coverage", () => {
  const rows = alternatingRows(12);
  rows[5].value = 0.3;
  const result = tuneMarketThreshold(rows, {
    labels: ["主", "客"],
    outcomeField: "result",
    tolerances: [0.01, 0.1],
    currentTolerance: 0.1,
    warmup: 2,
    validationFraction: 0.25,
    distance: (left, right) => Math.abs(left.value - right.value),
  });

  for (const candidate of result.candidates) {
    assert.equal(
      Number.isInteger(candidate.validation.medianSamples),
      true,
    );
    assert.ok(candidate.validation.coverage >= 0);
    assert.ok(candidate.validation.coverage <= 1);
  }
});
