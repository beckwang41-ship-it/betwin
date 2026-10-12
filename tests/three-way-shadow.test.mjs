import assert from "node:assert/strict";
import test from "node:test";
import {
  SPF_SHADOW_MODEL_VERSION,
  buildSpfShadowComparison,
} from "../lib/three-way-shadow.mjs";

function row({ odds, result = "胜", handicap = 0 } = {}) {
  return {
    league: "测试联赛",
    odds: odds || [2, 3.2, 4],
    result,
    handicap,
  };
}

test("SPF影子模型只改变距离方法并保留联合直接赛果统计", () => {
  const spf = row({ odds: [2.2, 3.52, 4.4], result: "负" });
  const hhad = row({
    odds: [2.31, 3.41, 4.18],
    result: "平",
    handicap: -1,
  });
  const result = buildSpfShadowComparison(
    {
      had: { h: 2, d: 3.2, a: 4 },
      hhad: { h: 2.1, d: 3.1, a: 3.8, goalLine: -1 },
    },
    {
      spfHistory: [spf],
      hhadHistory: [hhad],
      pairedHistory: [{ spf, hhad }],
    },
  );

  assert.match(SPF_SHADOW_MODEL_VERSION, /hellinger-0.04/);
  assert.equal(result.baseline.available, false);
  assert.equal(result.baseline.matchingMode, "joint-unavailable");
  assert.equal(result.candidate.available, true);
  assert.equal(result.candidate.matchingMode, "joint");
  assert.equal(result.candidate.samples, 1);
  assert.deepEqual(result.candidate.topLabels, ["负"]);
});

test("有让球盘时影子候选联合样本为零不会回退到SPF独立池", () => {
  const standalone = row({ result: "胜" });
  const result = buildSpfShadowComparison(
    {
      had: { h: 2, d: 3.2, a: 4 },
      hhad: { h: 9, d: 8, a: 7, goalLine: -1 },
    },
    {
      spfHistory: [standalone],
      hhadHistory: [],
      pairedHistory: [],
    },
  );
  assert.equal(result.candidate.available, false);
  assert.equal(result.candidate.matchingMode, "joint-unavailable");
  assert.equal(result.candidate.samples, 0);
});
