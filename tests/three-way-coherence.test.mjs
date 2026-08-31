import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCoherentThreeWayDistribution,
  parseScoreMargin,
  settleMargin,
} from "../lib/three-way-coherence.mjs";

function pair(score, handicap = -1) {
  return {
    score,
    spf: { score, result: "负", odds: [2, 3, 4] },
    hhad: { score, result: "胜", handicap, odds: [3, 3.2, 2] },
  };
}

test("比分净胜球解析兼容横线和冒号", () => {
  assert.equal(parseScoreMargin("2-1"), 1);
  assert.equal(parseScoreMargin("0:3"), -3);
  assert.equal(parseScoreMargin("未赛"), null);
});

test("净胜球统一结算胜平负和让球胜平负", () => {
  assert.equal(settleMargin(1, 0), "胜");
  assert.equal(settleMargin(1, -1), "平");
  assert.equal(settleMargin(0, -1), "负");
  assert.equal(settleMargin(-1, 1), "平");
});

test("主队负一球时两套概率由同一联合分布派生", () => {
  const result = buildCoherentThreeWayDistribution(
    [pair("2-0"), pair("1-0"), pair("0-0"), pair("0-1")],
    { handicap: -1, priorMass: 0 },
  );

  assert.equal(result.available, true);
  assert.deepEqual(result.spf.probabilities, [0.5, 0.25, 0.25]);
  assert.deepEqual(result.hhad.probabilities, [0.25, 0.25, 0.5]);
  assert.equal(
    result.spf.probabilities[0],
    result.hhad.probabilities[0] + result.hhad.probabilities[1],
  );
  assert.equal(
    result.spf.probabilities[1] + result.spf.probabilities[2],
    result.hhad.probabilities[2],
  );
  assert.equal(result.consistency.maxResidual, 0);
  assert.equal(
    result.display.spf[0],
    result.display.hhad[0] + result.display.hhad[1],
  );
  assert.equal(
    result.display.spf[1] + result.display.spf[2],
    result.display.hhad[2],
  );
});

test("联合先验只施加一次且不破坏跨市场恒等式", () => {
  const result = buildCoherentThreeWayDistribution(
    [pair("2-0"), pair("1-0"), pair("0-0")],
    { handicap: -1, priorMass: 1.5 },
  );

  assert.equal(result.cells.length, 4);
  assert.equal(result.prior.applied, true);
  assert.ok(
    Math.abs(
      result.spf.probabilities[0] -
        result.hhad.probabilities[0] -
        result.hhad.probabilities[1],
    ) < 1e-12,
  );
  assert.ok(
    Math.abs(
      result.spf.probabilities[1] +
        result.spf.probabilities[2] -
        result.hhad.probabilities[2],
    ) < 1e-12,
  );
});

test("无有效比分时不生成两套独立概率", () => {
  const result = buildCoherentThreeWayDistribution(
    [pair("未赛"), pair("")],
    { handicap: -1 },
  );
  assert.equal(result.available, false);
  assert.equal(result.sampleSize, 0);
  assert.equal(result.invalidScoreSamples, 2);
});
