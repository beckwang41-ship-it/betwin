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
});

test("latest validation can reject a weighting selected on earlier rows", () => {
  const result = tune(rows({ reverseValidation: true }));
  assert.equal(result.gate.tuningPassed, true);
  assert.equal(result.gate.validationPassed, false);
  assert.equal(result.gate.passed, false);
  assert.equal(result.production.enabled, false);
  assert.equal(result.production.floor, 1);
});
