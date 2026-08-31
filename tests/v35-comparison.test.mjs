import assert from "node:assert/strict";
import test from "node:test";
import {
  plainProbabilities,
  selectV35Samples,
  v35Prediction,
  v35SmoothedSamples,
  v35TrueProbabilities,
} from "../lib/v35-comparison.mjs";

function row(index, overrides = {}) {
  return {
    sourceFile: "history.xlsx",
    sourceRow: index,
    league: "英超",
    handicap: -1,
    odds: [2, 3.2, 3.6],
    initialOdds: [2.1, 3.2, 3.4],
    result: ["胜", "平", "负"][index % 3],
    ...overrides,
  };
}

test("V35 原版概率口径会让相同 SPF 赔率产生非零结构差", () => {
  const odds = [2, 3.2, 3.6];
  assert.notDeepEqual(plainProbabilities(odds), v35TrueProbabilities(odds, "spf"));
});

test("V35 匹配要求同盘口和至少16个预筛样本，并只取前20个", () => {
  const target = row(100);
  assert.equal(selectV35Samples(Array.from({ length: 15 }, (_, i) => row(i)), target, "spf"), null);
  const history = Array.from({ length: 24 }, (_, i) => row(i));
  history.push(row(25, { handicap: 1 }));
  const selected = selectV35Samples(history, target, "spf");
  assert.equal(selected.candidateSamples, 24);
  assert.equal(selected.samples.length, 20);
  assert.ok(selected.samples.every((sample) => sample.handicap === -1));
});

test("V35 动态平滑输出有效三项概率", () => {
  const history = Array.from({ length: 24 }, (_, i) => row(i));
  const prediction = v35Prediction(history, row(100), "spf");
  assert.equal(prediction.sampleSize, 20);
  assert.ok(prediction.effectiveSamples > 0);
  assert.ok(
    Math.abs(prediction.probabilities.reduce((sum, value) => sum + value, 0) - 1) <
      1e-12,
  );
  assert.ok(prediction.probabilities.every((value) => value > 0 && value < 1));
});

test("V35 平滑可独立应用于当前等权匹配池", () => {
  const samples = Array.from({ length: 24 }, (_, i) => row(i));
  const smoothed = v35SmoothedSamples(samples, row(100), "spf", {
    weighted: false,
  });
  assert.equal(smoothed.effectiveSamples, 24);
  assert.equal(smoothed.smoothingStrength, 1);
  assert.ok(
    Math.abs(smoothed.probabilities.reduce((sum, value) => sum + value, 0) - 1) <
      1e-12,
  );
});
