import test from "node:test";
import assert from "node:assert/strict";
import {
  blockBootstrapStrategyComparison,
  pairedStrategyCase,
  strategyOutcome,
  summarizeStrategy,
} from "../lib/strategy-evaluation.mjs";

test("strategy accounting charges one unit for every tied selection", () => {
  const won = strategyOutcome([0.45, 0.45, 0.1], [2.2, 3.2, 4.5], 1);
  assert.equal(won.stakeUnits, 2);
  assert.equal(won.returnUnits, 3.2);
  assert.ok(Math.abs(won.profitUnits - 1.2) < 1e-12);
  assert.equal(won.won, true);

  const noPrediction = strategyOutcome(
    [1 / 3, 1 / 3, 1 / 3],
    [2.2, 3.2, 4.5],
    1,
  );
  assert.equal(noPrediction.noPrediction, true);
  assert.equal(noPrediction.stakeUnits, 0);
});

test("strategy summary uses stake units rather than match count", () => {
  const cases = [
    pairedStrategyCase([0.6, 0.2, 0.2], [0.5, 0.5, 0], [2, 3, 5], 0),
    pairedStrategyCase([0.2, 0.6, 0.2], [0.2, 0.6, 0.2], [2, 3, 5], 2),
  ];
  const candidate = summarizeStrategy(cases, "candidate");
  const baseline = summarizeStrategy(cases, "baseline");

  assert.equal(candidate.stakeUnits, 2);
  assert.equal(candidate.returnUnits, 2);
  assert.equal(candidate.roi, 0);
  assert.equal(baseline.stakeUnits, 3);
  assert.equal(baseline.returnUnits, 2);
  assert.ok(Math.abs(baseline.roi + 1 / 3) < 1e-12);
});

test("strategy bootstrap reports stable paired ROI improvement", () => {
  const cases = Array.from({ length: 120 }, (_, index) => ({
    sourceFile: "history.xlsx",
    order: index + 1,
    candidate: {
      noPrediction: false,
      stakeUnits: 1,
      returnUnits: index % 2 === 0 ? 2.4 : 0,
      profitUnits: index % 2 === 0 ? 1.4 : -1,
      won: index % 2 === 0,
    },
    baseline: {
      noPrediction: false,
      stakeUnits: 1,
      returnUnits: index % 3 === 0 ? 2.1 : 0,
      profitUnits: index % 3 === 0 ? 1.1 : -1,
      won: index % 3 === 0,
    },
  }));
  const result = blockBootstrapStrategyComparison(cases, {
    iterations: 400,
    blockSize: 12,
    seed: 17,
  });

  assert.equal(result.status, "better");
  assert.equal(result.passed, true);
  assert.ok(result.intervals.delta.lower > 0);
  assert.ok(result.candidate.roi > result.baseline.roi);
});

test("strategy bootstrap flags real ROI degradation as worse", () => {
  // 与上一个测试完全对称：候选每 3 场中 1 场命中，基线每 2 场中 1 场命中。
  // 候选真实劣化，必须判为 worse 且 passed=false。
  const cases = Array.from({ length: 120 }, (_, index) => ({
    sourceFile: "history.xlsx",
    order: index + 1,
    candidate: {
      noPrediction: false,
      stakeUnits: 1,
      returnUnits: index % 3 === 0 ? 2.1 : 0,
      profitUnits: index % 3 === 0 ? 1.1 : -1,
      won: index % 3 === 0,
    },
    baseline: {
      noPrediction: false,
      stakeUnits: 1,
      returnUnits: index % 2 === 0 ? 2.4 : 0,
      profitUnits: index % 2 === 0 ? 1.4 : -1,
      won: index % 2 === 0,
    },
  }));
  const result = blockBootstrapStrategyComparison(cases, {
    iterations: 400,
    blockSize: 12,
    seed: 17,
  });

  assert.equal(result.status, "worse");
  assert.equal(result.passed, false);
  assert.ok(result.intervals.delta.upper < 0);
  assert.ok(result.candidate.roi < result.baseline.roi);
  assert.equal(result.positiveEdge, false);
});

test("strategy gate never passes when improvement interval spans zero", () => {
  // 候选与基线完全同分布 → 区间必然跨 0 → uncertain，绝不能 passed。
  const cases = Array.from({ length: 150 }, (_, index) => {
    const outcome = {
      noPrediction: false,
      stakeUnits: 1,
      returnUnits: index % 2 === 0 ? 2.2 : 0,
      profitUnits: index % 2 === 0 ? 1.2 : -1,
      won: index % 2 === 0,
    };
    return {
      sourceFile: "history.xlsx",
      order: index + 1,
      candidate: { ...outcome },
      baseline: { ...outcome },
    };
  });
  const result = blockBootstrapStrategyComparison(cases, {
    iterations: 400,
    blockSize: 10,
    seed: 5,
  });

  assert.equal(result.status, "uncertain");
  assert.equal(result.passed, false);
  assert.equal(result.roiDelta, 0);
});
