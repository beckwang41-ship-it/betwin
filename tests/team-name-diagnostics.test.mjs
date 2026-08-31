import test from "node:test";
import assert from "node:assert/strict";
import {
  diagnosePendingTeamNames,
  teamNameSimilarity,
} from "../lib/team-name-diagnostics.mjs";

test("team name diagnostics ignores exact historical names", () => {
  const result = diagnosePendingTeamNames(
    [{ matchId: "1", league: "英超", home: "曼联", away: "新球队" }],
    [
      { league: "英超", name: "曼联" },
      { league: "英超", name: "新城队" },
    ],
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "新球队");
  assert.equal(result[0].candidates[0].name, "新城队");
});

test("team name similarity is normalized and bounded", () => {
  assert.equal(teamNameSimilarity("A FC", "a fc"), 1);
  assert.ok(teamNameSimilarity("新球队", "新城队") > 0.5);
});
