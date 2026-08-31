import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diagnosePendingTeamNames } from "../lib/team-name-diagnostics.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const jsonOutput = process.argv.includes("--json");
const db = new DatabaseSync(DATABASE_PATH, { readOnly: true });

try {
  const pendingFixtures = db.prepare(`
    SELECT DISTINCT match_id AS matchId, league,
           home_team AS home, away_team AS away
    FROM prediction_ledger
    WHERE valid = 1 AND status = 'pending'
    ORDER BY captured_at DESC
  `).all();
  const historicalTeams = db.prepare(`
    SELECT DISTINCT league, home_team AS name FROM historical_spf
    UNION SELECT DISTINCT league, away_team AS name FROM historical_spf
    UNION SELECT DISTINCT league, home_team AS name FROM historical_hhad
    UNION SELECT DISTINCT league, away_team AS name FROM historical_hhad
    UNION SELECT DISTINCT league, home_team AS name FROM historical_goals
    UNION SELECT DISTINCT league, away_team AS name FROM historical_goals
  `).all();
  const unresolved = diagnosePendingTeamNames(
    pendingFixtures,
    historicalTeams,
  );
  if (jsonOutput) {
    console.log(JSON.stringify({ pendingFixtures: pendingFixtures.length, unresolved }, null, 2));
  } else if (!unresolved.length) {
    console.log(
      `检查了 ${pendingFixtures.length} 场有效待结算比赛：所有球队名均可在历史库或 teamname.json 别名中找到。`,
    );
  } else {
    console.log(
      `检查了 ${pendingFixtures.length} 场有效待结算比赛，发现 ${unresolved.length} 个未映射球队名。`,
    );
    console.log("以下仅给出候选，不会自动修改 teamname.json：\n");
    for (const row of unresolved) {
      console.log(
        `${row.name}（${row.leagues.join("/") || "联赛未知"}，涉及 ${row.pendingMatches} 场）`,
      );
      for (const candidate of row.candidates) {
        console.log(
          `  - ${candidate.name}（${candidate.league || "联赛未知"}，相似 ${(candidate.similarity * 100).toFixed(1)}%${candidate.sameLeague ? "，同联赛" : ""}）`,
        );
      }
    }
  }
} finally {
  db.close();
}
