import assert from "node:assert/strict";
import test from "node:test";
import {
  buildThreeWaySmoothingRows,
  createThreeWaySmoothingResolvers,
} from "../lib/three-way-smoothing.mjs";

function historyRow(sourceRow, spfOdds, hhadOdds) {
  return {
    league: "英超",
    spfSourceFile: "history.xlsx",
    spfSourceRow: sourceRow,
    hhadSourceFile: "history.xlsx",
    hhadSourceRow: sourceRow,
    spf: { result: "胜", handicap: -1, odds: spfOdds },
    hhad: { result: "负", handicap: -1, odds: hhadOdds },
  };
}

test("平滑训练复用生产联合优先与零样本独立回退", () => {
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
  assert.equal(fallback.length, 2);
  assert.deepEqual(
    fallback.map((row) => row.sourceRow),
    [1, 2],
  );
});
