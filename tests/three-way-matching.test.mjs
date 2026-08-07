import assert from "node:assert/strict";
import test from "node:test";
import {
  buildThreeWayEvents,
  threeWaySamplesForThreshold,
} from "../lib/three-way-backtest.mjs";
import { selectThreeWaySimilarity } from "../lib/three-way-matching.mjs";

function row(overrides = {}) {
  return {
    matchKey: "fixture",
    sourceFile: "history.xlsx",
    sourceRow: 1,
    league: "测试联赛",
    home: "主队",
    away: "客队",
    result: "胜",
    handicap: 0,
    odds: [2, 3, 4],
    ...overrides,
  };
}

function match({ had = [2, 3, 4], hhad = [2.1, 3.1, 3.8], line = -1 } = {}) {
  return {
    had: had ? { h: had[0], d: had[1], a: had[2] } : null,
    hhad: hhad
      ? { h: hhad[0], d: hhad[1], a: hhad[2], goalLine: line }
      : null,
  };
}

test("共享三项匹配器联合命中，并在联合为零时回退独立池", () => {
  const spf = row();
  const hhad = row({ handicap: -1, odds: [2.1, 3.1, 3.8] });
  const histories = {
    spfHistory: [spf],
    hhadHistory: [hhad],
    pairedHistory: [{ spf, hhad }],
  };
  const joint = selectThreeWaySimilarity(match(), histories, {
    spfTolerance: 0.07,
    hhadTolerance: 0.07,
  });
  assert.equal(joint.spf.mode, "joint");
  assert.equal(joint.hhad.mode, "joint");
  assert.equal(joint.spf.jointSamples, 1);
  assert.equal(joint.hhad.similar.length, 1);

  const fallback = selectThreeWaySimilarity(
    match({ hhad: [9, 9, 9] }),
    histories,
    { spfTolerance: 0.07, hhadTolerance: 0.07 },
  );
  assert.equal(fallback.spf.mode, "standalone-fallback");
  assert.equal(fallback.hhad.mode, "standalone-fallback");
  assert.equal(fallback.spf.similar.length, 1);
  assert.equal(fallback.hhad.similar.length, 0);
});

test("离线事件按来源行组装，并且目标只能读取更早的生产匹配池", () => {
  const earlierSpf = row({ matchKey: "earlier", sourceRow: 1 });
  const earlierHhad = row({
    matchKey: "earlier",
    sourceRow: 1,
    handicap: -1,
    odds: [2.1, 3.1, 3.8],
  });
  const futureSpf = row({ matchKey: "future", sourceRow: 3 });
  const futureHhad = row({
    matchKey: "future",
    sourceRow: 3,
    handicap: -1,
    odds: [2.1, 3.1, 3.8],
  });
  const events = buildThreeWayEvents({
    spfHistory: [futureSpf, earlierSpf],
    hhadHistory: [futureHhad, earlierHhad],
    pairedHistory: [
      {
        ...earlierSpf,
        spf: earlierSpf,
        hhad: earlierHhad,
      },
      {
        ...futureSpf,
        spf: futureSpf,
        hhad: futureHhad,
      },
    ],
  });
  const target = {
    ...events[0],
    sourceRow: 2,
    spf: row({ sourceRow: 2 }),
    hhad: row({
      sourceRow: 2,
      handicap: -1,
      odds: [2.1, 3.1, 3.8],
    }),
  };
  const samples = threeWaySamplesForThreshold(
    target,
    [events[0]],
    "spf",
    0.07,
    0.07,
  );
  assert.equal(samples.length, 1);
  assert.equal(samples[0].matchKey, "earlier");
  assert.ok(events[1].sourceRow > target.sourceRow);
});
