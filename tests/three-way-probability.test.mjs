import assert from "node:assert/strict";
import test from "node:test";
import {
  blendThreeWayProbabilities,
  compositeThreeWayDistance,
  impliedThreeWayProbabilities,
  uniformThreeWayProbabilities,
  weightedThreeWayProbabilities,
} from "../lib/three-way-probability.mjs";

test("终赔去水概率归一化为三项概率", () => {
  const probabilities = impliedThreeWayProbabilities([2, 3.2, 4]);
  assert.ok(Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  assert.ok(probabilities[0] > probabilities[1]);
  assert.ok(probabilities[1] > probabilities[2]);
});

test("等权历史概率只统计有效胜平负结果", () => {
  assert.deepEqual(
    uniformThreeWayProbabilities([
      { result: "胜" },
      { result: "胜" },
      { result: "平" },
      { result: "未知" },
    ]),
    [2 / 3, 1 / 3, 0],
  );
});

test("综合距离在缺少初赔时自动回到终赔距离", () => {
  const sample = { odds: [2.1, 3.2, 3.7], initialOdds: null };
  const target = { odds: [2, 3.2, 4], initialOdds: null };
  const finalOnly = compositeThreeWayDistance(sample, target, {
    finalWeight: 1,
    initialWeight: 0,
    movementWeight: 0,
  });
  const composite = compositeThreeWayDistance(sample, target, {
    finalWeight: 0.7,
    initialWeight: 0.15,
    movementWeight: 0.15,
  });
  assert.equal(composite, finalOnly);
});

test("指数距离加权让更接近当前赔率的历史结果占更高权重", () => {
  const prediction = weightedThreeWayProbabilities(
    [
      { result: "胜", odds: [2.01, 3.2, 3.99] },
      { result: "负", odds: [2.2, 3.4, 3.6] },
    ],
    { odds: [2, 3.2, 4] },
    {
      finalWeight: 1,
      initialWeight: 0,
      movementWeight: 0,
      finalScale: 0.1,
      decay: 1,
    },
  );
  assert.ok(prediction.probabilities[0] > prediction.probabilities[2]);
  assert.ok(prediction.effectiveSamples > 1);
  assert.ok(prediction.effectiveSamples < 2);
});

test("赔率与历史融合严格使用配置比例", () => {
  const probabilities = blendThreeWayProbabilities(
    [0.2, 0.5, 0.3],
    [0.6, 0.2, 0.2],
    0.75,
  );
  [0.5, 0.275, 0.225].forEach((expected, index) => {
    assert.ok(Math.abs(probabilities[index] - expected) < 1e-12);
  });
});
