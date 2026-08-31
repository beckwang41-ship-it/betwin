import test from "node:test";
import assert from "node:assert/strict";
import { tuneMovementCorrection } from "../lib/movement-tuning.mjs";

function rows(length, { reverseValidation = false } = {}) {
  return Array.from({ length }, (_, index) => {
    const cluster = index % 2;
    const inValidation = index >= Math.floor(length * 0.75);
    const reversed = reverseValidation && inValidation;
    return {
      sourceFile: "history.xlsx",
      sourceRow: index + 1,
      initialOdds: cluster
        ? [1.7, 3.2, 4]
        : [2.4, 3.2, 4],
      odds: [2, 3.2, 4],
      result:
        cluster === Number(reversed)
          ? "胜"
          : "负",
    };
  });
}

function tune(input) {
  return tuneMovementCorrection(input, {
    market: "spf",
    labels: ["胜", "平", "负"],
    outcomeField: "result",
    tolerance: 0.1,
    weights: [0.05, 0.1, 0.2],
    warmup: 4,
    validationFraction: 0.25,
  });
}

test("movement correction is enabled only after earlier and latest segments pass", () => {
  const result = tune(rows(24));

  assert.equal(result.gate.tuningPassed, true);
  assert.equal(result.gate.validationPassed, true);
  assert.equal(result.production.enabled, true);
  assert.equal(result.production.fixedWeight, 0.2);
  assert.ok(result.selected.validation.logLoss < result.baseline.validation.logLoss);
  assert.ok(result.selected.validation.brier < result.baseline.validation.brier);
  assert.ok(result.selected.strategy);
  assert.equal(result.selected.strategy.evaluated, 6);
});

test("latest segment can reject a movement correction selected earlier", () => {
  const result = tune(rows(24, { reverseValidation: true }));

  assert.equal(result.gate.tuningPassed, true);
  assert.equal(result.gate.validationPassed, false);
  assert.equal(result.production.enabled, false);
  assert.equal(result.production.fixedWeight, 0);
  assert.match(result.gate.reason, /仅展示走势参考/);
});

test("custom matcher receives only earlier rows and nested market accessors", () => {
  const events = rows(24).map((row) => ({
    sourceFile: row.sourceFile,
    sourceRow: row.sourceRow,
    spf: row,
  }));
  let resolverCalls = 0;

  const result = tuneMovementCorrection(events, {
    market: "spf",
    labels: ["胜", "平", "负"],
    outcomeField: "result",
    tolerance: 0.1,
    weights: [0.05],
    warmup: 4,
    validationFraction: 0.25,
    targetEligible: (target) => Boolean(target.spf),
    actualForTarget: (target) => target.spf.result,
    oddsForTarget: (target) => target.spf.odds,
    initialOddsForTarget: (target) => target.spf.initialOdds,
    sampleResolver: (target, history) => {
      resolverCalls += 1;
      assert.ok(
        history.every((row) => row.sourceRow < target.sourceRow),
        "matcher must not see the target or future rows",
      );
      return history.map((row) => row.spf);
    },
  });

  assert.equal(resolverCalls, 20);
  assert.ok(result.baseline.tuning.evaluated > 0);
  assert.ok(result.baseline.validation.evaluated > 0);
});
