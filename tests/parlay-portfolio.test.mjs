import assert from "node:assert/strict";
import test from "node:test";
import { summarizeParlayPortfolio } from "../public/parlay-portfolio.js";

const leg = (id, market = "had", predicted = "胜", handicap = null) => ({ id, market, predicted, handicap, home: `主${id}`, away: `客${id}`, league: "测试" });
test("portfolio totals only checked combinations, one standard ticket costs two yuan", () => {
  const rows = [
    { legs: [leg("a"), leg("b")], recorded: { id: 7 } },
    { legs: [leg("a"), leg("c")] },
    { legs: [leg("d"), leg("e")] },
  ];
  const result = summarizeParlayPortfolio(rows, new Set([0, 1]), "standard");
  assert.equal(result.groups, 2);
  assert.equal(result.ticketCount, 2);
  assert.equal(result.costYuan, 4);
  assert.equal(result.recordedGroups, 1);
  assert.equal(result.fixtures.length, 3);
  assert.equal(result.repeatedFixtures, 1);
  assert.deepEqual(result.fixtures[0].conditions[0].combinations, [0, 1]);
  assert.equal(result.fixtures[0].conditions[0].costYuan, 4);
  assert.equal(summarizeParlayPortfolio(rows, new Set(), "standard").costYuan, 0);
});
test("same match with different markets, handicaps or selections has separate failure conditions", () => {
  const rows = [
    { legs: [leg("a"), leg("b")] },
    { legs: [leg("a", "hhad", "让负", -1), leg("c")] },
    { legs: [leg("a", "hhad", "让负", -2), leg("d")] },
  ];
  const result = summarizeParlayPortfolio(rows, new Set([0, 1, 2]), "standard");
  assert.equal(result.fixtures[0].conditions.length, 3);
  assert.deepEqual(result.fixtures[0].conditions.map(c => c.combinations), [[0], [1], [2]]);
  assert.ok(result.fixtures[0].conditions.every(c => c.costYuan === 2));
});
test("two goal-double 2-leg combinations cost eight tickets/sixteen yuan, not four yuan", () => {
  const goalLeg = id => ({ ...leg(id, "goalsPair", "2 / 3"), selections: [{label: "2"}, {label: "3"}] });
  const rows = [{ legs: [goalLeg("a"), goalLeg("b")] }, { legs: [goalLeg("a"), goalLeg("c")] }];
  const result = summarizeParlayPortfolio(rows, new Set([0, 1]), "goalsPair");
  assert.equal(result.ticketCount, 8);
  assert.equal(result.costYuan, 16);
  assert.equal(result.fixtures[0].conditions[0].costYuan, 16);
  assert.deepEqual(result.fixtures[0].conditions[0].labels, ["2", "3"]);
  for (let n = 2; n <= 5; n++) {
    assert.equal(summarizeParlayPortfolio([{ legs: Array.from({length:n}, (_,i) => goalLeg(String(i))) }], new Set([0]), "goalsPair").costYuan, 2 ** n * 2);
  }
});
test("match IDs distinguish identically named fixtures; invalid indices cannot create phantom costs", () => {
  const a = leg("a"), b = {...a, id:"b"};
  const result = summarizeParlayPortfolio([{legs:[a,b]}], new Set([0, 9]), "standard");
  assert.equal(result.fixtures.length, 2);
  assert.equal(result.repeatedFixtures, 0);
  assert.equal(result.groups, 1);
});
