import test from "node:test";
import assert from "node:assert/strict";
import { tuneSimilarityWeighting } from "../lib/weighting-tuning.mjs";

function rows({ reverseValidation = false } = {}) {
  const outcomes = ["A", "B", "A", "B", "A", "B", "A", "B"];
  return outcomes.map((outcome, index) => {
    const sourceRow = index + 1;
    const distanceByRow = {};
    for (let historyRow = 1; historyRow < sourceRow; historyRow += 1) {
      const historyOutcome = outcomes[historyRow - 1];
      const favorSame =
        !reverseValidation || sourceRow < 7;
      distanceByRow[historyRow] =
        historyOutcome === outcome
          ? favorSame
            ? 0
            : 1
          : favorSame
            ? 1
            : 0;
    }
    return {
      sourceFile: "history.xlsx",
      sourceRow,
      result: outcome,
      odds: outcome === "A" ? [2.2, 3.1] : [2.1, 2.4],
      distanceByRow,
    };
  });
}

function tune(input) {
  return tuneSimilarityWeighting(input, {
    labels: ["A", "B"],
    outcomeField: "result",
    tolerance: 1,
    candidates: [{ id: "strong", floor: 0.1, power: 1 }],
    distance: (history, target) =>
      target.distanceByRow[history.sourceRow],
    warmup: 2,
    validationFraction: 0.25,
  });
}

test("weighting is enabled only when earlier selection also passes latest validation", () => {
  const result = tune(rows());
  assert.equal(result.gate.tuningPassed, true);
  assert.equal(result.gate.validationPassed, true);
  assert.equal(result.gate.passed, true);
  assert.equal(result.production.enabled, true);
  assert.ok(result.selected.strategy);
  assert.equal(typeof result.selected.strategy.passed, "boolean");
});

test("latest validation can reject a weighting selected on earlier rows", () => {
  const result = tune(rows({ reverseValidation: true }));
  assert.equal(result.gate.tuningPassed, true);
  assert.equal(result.gate.validationPassed, false);
  assert.equal(result.gate.passed, false);
  assert.equal(result.production.enabled, false);
  assert.equal(result.production.floor, 1);
});

test("custom matcher receives only earlier rows and nested market accessors", () => {
  const events = rows().map((row) => ({
    sourceFile: row.sourceFile,
    sourceRow: row.sourceRow,
    spf: row,
  }));
  let resolverCalls = 0;

  const result = tuneSimilarityWeighting(events, {
    labels: ["A", "B"],
    outcomeField: "result",
    tolerance: 1,
    candidates: [{ id: "strong", floor: 0.1, power: 1 }],
    targetEligible: (target) => Boolean(target.spf),
    actualForTarget: (target) => target.spf.result,
    sampleResolver: (target, history) => {
      resolverCalls += 1;
      assert.ok(
        history.every((row) => row.sourceRow < target.sourceRow),
        "matcher must not see the target or future rows",
      );
      return history.map((row) => ({
        ...row.spf,
        distance: target.spf.distanceByRow[row.sourceRow],
      }));
    },
    warmup: 2,
    validationFraction: 0.25,
  });

  assert.equal(resolverCalls, 6);
  assert.ok(result.baseline.tuning.evaluated > 0);
  assert.ok(result.baseline.validation.evaluated > 0);
});

test("validated smoothing is applied to the uniform production baseline", () => {
  const raw = tune(rows());
  const smoothed = tuneSimilarityWeighting(rows(), {
    labels: ["A", "B"],
    outcomeField: "result",
    tolerance: 1,
    candidates: [{ id: "strong", floor: 0.1, power: 1 }],
    distance: (history, target) =>
      target.distanceByRow[history.sourceRow],
    predictionOptionsResolver: () => ({
      smoothing: {
        enabled: true,
        validated: true,
        strength: 10,
        prior: { probabilities: [0.9, 0.1] },
      },
    }),
    warmup: 2,
    validationFraction: 0.25,
  });

  assert.notEqual(
    smoothed.baseline.tuning.logLoss,
    raw.baseline.tuning.logLoss,
  );
});
