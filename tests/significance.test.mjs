import test from "node:test";
import assert from "node:assert/strict";
import {
  blockBootstrapMean,
  blockBootstrapComparison,
  classificationDelta,
} from "../lib/significance.mjs";

test("scalar block bootstrap preserves chronological clusters", () => {
  const cases = Array.from({ length: 120 }, (_, index) => ({
    sourceFile: "spf:all",
    order: index + 1,
    value: Math.floor(index / 12) % 2 === 0 ? 0.2 : 0.1,
  }));
  const result = blockBootstrapMean(cases, {
    iterations: 400,
    blockSize: 12,
    seed: 17,
  });

  assert.equal(result.status, "better");
  assert.ok(result.lower > 0);
  assert.equal(result.evaluated, 120);
  assert.equal(result.improvementProbability, 1);
});

test("scalar block bootstrap reports an unstable lift as uncertain", () => {
  const cases = Array.from({ length: 120 }, (_, index) => ({
    sourceFile: "goals:all",
    order: index + 1,
    value: Math.floor(index / 10) % 2 === 0 ? -1 : 1,
  }));
  const result = blockBootstrapMean(cases, {
    iterations: 500,
    blockSize: 10,
    seed: 19,
  });

  assert.equal(result.status, "uncertain");
  assert.ok(result.lower < 0);
  assert.ok(result.upper > 0);
});

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

test("accuracy margin turns the gate into a non-inferiority test", () => {
  // 构造一批 LogLoss/Brier 稳定改善、但命中率区间下界略低于 0 的案例，
  // 模拟真实数据里「校准明显改善、命中率下界落在噪声带」的情形。
  const cases = Array.from({ length: 200 }, (_, index) => ({
    sourceFile: "history.xlsx",
    order: index + 1,
    accuracy: index % 9 === 0 ? -0.1 : index % 7 === 0 ? 0.1 : 0,
    logLoss: -0.05,
    brier: -0.02,
  }));

  const strict = blockBootstrapComparison(cases, {
    iterations: 600,
    blockSize: 10,
    seed: 11,
  });
  const lenient = blockBootstrapComparison(cases, {
    iterations: 600,
    blockSize: 10,
    seed: 11,
    accuracyMargin: -0.005,
  });

  // 两次运行的区间完全相同，只有判定阈值不同。
  assert.equal(strict.metrics.accuracy.lower, lenient.metrics.accuracy.lower);
  assert.equal(strict.accuracyMargin, 0);
  assert.equal(lenient.accuracyMargin, -0.005);
  // 命中率点估计为正、下界为小负值：正是真实数据里的形态。
  assert.ok(strict.metrics.accuracy.delta > 0);
  assert.ok(strict.metrics.accuracy.lower < 0);
  assert.ok(lenient.metrics.accuracy.lower >= -0.005);
  assert.equal(strict.passed, false);
  assert.equal(lenient.passed, true);
  assert.match(lenient.reason, /非劣界限/);
});

test("accuracy margin still rejects a real accuracy drop", () => {
  // 命中率整体真下降 5pp，远超非劣界限，必须拒绝。
  const cases = Array.from({ length: 200 }, (_, index) => ({
    sourceFile: "history.xlsx",
    order: index + 1,
    accuracy: -0.05,
    logLoss: -0.05,
    brier: -0.02,
  }));
  const result = blockBootstrapComparison(cases, {
    iterations: 400,
    blockSize: 10,
    seed: 11,
    accuracyMargin: -0.005,
  });

  assert.equal(result.passed, false);
  assert.equal(result.accuracyPassed, false);
});

test("positive accuracy margin is clamped to zero", () => {
  // 防误用：正 margin 会放进命中率下降的候选，必须夹回 0。
  const cases = Array.from({ length: 120 }, (_, index) => ({
    sourceFile: "history.xlsx",
    order: index + 1,
    accuracy: -0.02,
    logLoss: -0.05,
    brier: -0.02,
  }));
  const result = blockBootstrapComparison(cases, {
    iterations: 300,
    blockSize: 10,
    seed: 3,
    accuracyMargin: 0.5,
  });

  assert.equal(result.accuracyMargin, 0);
  assert.equal(result.passed, false);
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
