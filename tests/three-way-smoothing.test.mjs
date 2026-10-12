import assert from "node:assert/strict";
import test from "node:test";
import {
  buildThreeWaySmoothingRows,
  createThreeWaySmoothingResolvers,
  selectThreeWayHistoricalPrior,
} from "../lib/three-way-smoothing.mjs";

function historyRow(sourceRow, spfOdds, hhadOdds) {
  return {
    league: "英超",
    spfSourceFile: "history.xlsx",
    spfSourceRow: sourceRow,
    hhadSourceFile: "history.xlsx",
    hhadSourceRow: sourceRow,
    score: "2-0",
    spf: { result: "胜", handicap: -1, odds: spfOdds },
    hhad: { result: "负", handicap: -1, odds: hhadOdds },
  };
}

test("平滑训练复用双盘口联合样本口径且不做独立回退", () => {
  const rows = buildThreeWaySmoothingRows(
    [
      historyRow(1, [2, 3.2, 3.8], [2.5, 3.2, 2.2]),
      historyRow(2, [2.02, 3.18, 3.75], [5, 5, 1.2]),
      historyRow(3, [2.01, 3.2, 3.8], [2.52, 3.2, 2.18]),
    ],
    "spf",
  );
  const resolver = createThreeWaySmoothingResolvers("spf");
  const target = rows[2];

  const joint = resolver.sampleResolver(target, rows.slice(0, 2));
  assert.equal(joint.length, 1);
  assert.equal(joint[0].sourceRow, 1);

  const noJointTarget = {
    ...target,
    hhad: { ...target.hhad, odds: [8, 8, 8] },
  };
  const fallback = resolver.sampleResolver(noJointTarget, rows.slice(0, 2));
  assert.equal(fallback.length, 0);
});

test("未配对让球记录进入先验池，回测与正式先验一致，但不冒充联合样本", () => {
  const row = buildThreeWaySmoothingRows([historyRow(1, [2, 3.2, 3.8], [2.5, 3.2, 2.2])], "hhad")[0];
  const single = { ...row.hhad, sourceFile: "hhad-only.xlsx", sourceRow: 2, result: "胜" };
  const rows = buildThreeWaySmoothingRows({
    spfHistory: [row.spf], hhadHistory: [row.hhad, single], pairedHistory: [row],
  }, "hhad");
  assert.equal(rows.length, 2);
  const resolver = createThreeWaySmoothingResolvers("hhad");
  assert.equal(resolver.sampleResolver(row, rows).length, 1);
  const options = { threshold: 0.07, relaxedMultiplier: 2, minLocalizedSamples: 1 };
  const prior = resolver.priorResolver(rows, row, options);
  assert.equal(prior.sampleSize, 2);
  assert.deepEqual(prior.probabilities, [0.5, 0, 0.5]);
  assert.deepEqual(prior, selectThreeWayHistoricalPrior([row.hhad, single], row.hhad, "hhad", options));
  const oneMarketTarget = rows.find(r => !r.spf);
  assert.equal(resolver.sampleResolver(oneMarketTarget, rows).length, 2);
  // historySteps 的历史数组原地增长，缓存也必须增长。
  rows.push({ hhad: { ...single, result: "平", sourceRow: 3 } });
  assert.equal(resolver.priorResolver(rows, row, options).sampleSize, 3);
});
