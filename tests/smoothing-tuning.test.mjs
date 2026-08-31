import test from "node:test";
import assert from "node:assert/strict";
import {
  assessHighConfidenceCalibration,
  floorEmpiricalDistribution,
  tuneHistoricalSmoothing,
} from "../lib/smoothing-tuning.mjs";
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
  // 调参层不再具备上线权限：无论门禁是否通过，生产强度恒为关闭态，
  // 只有 data/smoothing-production.json 的人工批准才能启用。
  assert.equal(result.production.enabled, false);
  assert.equal(result.production.strength, 0);
  assert.equal(result.strength, 0);
  assert.equal(result.changed, false);
  assert.equal(result.production.candidatePassed, result.gate.passed);
  assert.equal(result.candidateChanged, result.gate.passed);
  assert.ok(
    Number.isFinite(
      result.baseline.validation.calibration.expectedCalibrationError,
    ),
  );
  assert.ok(
    Object.hasOwn(
      result.selected.validationComparison.delta,
      "maximumCalibrationError",
    ),
  );
});

test("smoothing tuning accepts a production sample and empirical resolver", () => {
  const rows = Array.from({ length: 24 }, (_, index) => ({
    sourceFile: "goals.xlsx",
    sourceRow: index + 1,
    league: "测试联赛",
    odds: [20, 7, 4.2, 3.2, 4.4, 7.5, 12, 16],
    goals: String(index % 4),
    similarityWeight: 1,
  }));
  let resolutions = 0;
  const result = tuneHistoricalSmoothing(rows, {
    labels: ["0", "1", "2", "3"],
    outcomeField: "goals",
    distance: () => {
      throw new Error("custom sample resolver should bypass legacy distance");
    },
    threshold: 0.015,
    strengths: [1, 2],
    warmup: 8,
    validationFraction: 0.25,
    sampleResolver: (_target, history) => {
      resolutions += 1;
      return history.slice(-4);
    },
    empiricalResolver: (similar) => {
      const counts = [0, 0, 0, 0];
      for (const row of similar) counts[Number(row.goals)] += 1;
      return counts.map((count) => count / similar.length);
    },
    priorResolver: () => ({
      source: "test",
      probabilities: [0.25, 0.25, 0.25, 0.25],
    }),
  });
  assert.equal(resolutions, 16);
  assert.equal(result.baseline.tuning.evaluated, 10);
  assert.equal(result.baseline.validation.evaluated, 6);
});

test("高概率候选样本不足时不能把更差的校准偏差当作未退步", () => {
  const result = assessHighConfidenceCalibration(
    {
      count: 11,
      observedAbsoluteGap: 0.1449,
      absoluteGap: null,
    },
    {
      count: 31,
      observedAbsoluteGap: 0.1132,
      absoluteGap: 0.1132,
    },
  );

  assert.equal(result.passed, false);
  assert.equal(result.status, "candidate-insufficient");
  assert.equal(result.delta, null);
});

test("候选不再产生高概率声明时通过高概率档保护", () => {
  const result = assessHighConfidenceCalibration(
    {
      count: 0,
      observedAbsoluteGap: null,
      absoluteGap: null,
    },
    {
      count: 31,
      observedAbsoluteGap: 0.1132,
      absoluteGap: 0.1132,
    },
  );

  assert.equal(result.passed, true);
  assert.equal(result.status, "no-candidate-claims");
  assert.equal(result.delta, -0.1132);
});

test("加权经验分布使用生产权重计数执行防零", () => {
  const result = floorEmpiricalDistribution(
    {
      probabilities: [0.8, 0.2],
      counts: [1, 0.25],
    },
    4,
    { priorMass: 1.5 },
  );

  assert.deepEqual(
    result.map((value) => Number(value.toFixed(6))),
    [0.636364, 0.363636],
  );
});
