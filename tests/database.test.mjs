import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  assembleCurrentMatches,
  createDataStore,
} from "../lib/database.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function expectedActiveMatchIds() {
  const files = [
    ["realtime_matches_had_hhad_history.json", "match_id"],
    ["realtime_matches_history.json", "match_id"],
  ];
  const realtimeIds = new Set(
    files.flatMap(([fileName, field]) =>
      JSON.parse(readFileSync(path.join(ROOT, fileName), "utf8"))
        .map((row) => String(row[field])),
    ),
  );
  const detailIds = new Set(
    JSON.parse(readFileSync(path.join(ROOT, "match_data1.json"), "utf8"))
      .map((row) => String(row.matchId)),
  );
  return detailIds.size
    ? new Set([...realtimeIds].filter((id) => detailIds.has(id)))
    : realtimeIds;
}

test("SQLite data store exposes imported matches and historical samples", () => {
  const store = createDataStore(path.join(ROOT, "betwin.db"));
  try {
    const counts = store.getCounts();
    assert.ok(counts.currentMatches > 0);
    assert.ok(counts.spfHistory > 8000);
    assert.ok(counts.hhadHistory > 8000);
    assert.ok(counts.goalHistory > 8000);
    assert.ok(counts.unifiedHistory >= counts.verifiedHistory);
    assert.ok(counts.verifiedHistory > 7000);

    const matches = store.getMatches();
    assert.equal(matches.length, counts.currentMatches);
    assert.ok(counts.storedCurrentMatches >= counts.currentMatches);
    assert.deepEqual(
      new Set(matches.map((match) => match.id)),
      expectedActiveMatchIds(),
    );
    assert.ok(matches.every((match) => match.had || match.hhad || match.goals));
    assert.ok(
      matches.every(
        (match) =>
          (!match.had || match.hadTimeline.length >= 1) &&
          (!match.hhad || match.hhadTimeline.length >= 1) &&
          (!match.goals || match.goalTimeline.length >= 1),
      ),
    );
    const first = matches.find(
      (match) => match.had && match.hhad && match.goals,
    );
    assert.ok(first);
    const spf = store.getHistoricalSpf(
      [first.had.h, first.had.d, first.had.a],
      { tolerance: 0.1, league: first.league, sameLeague: false },
    );
    const goals = store.getHistoricalGoals({
      league: first.league,
      sameLeague: false,
    });
    const hhad = store.getHistoricalHhad(
      [first.hhad.h, first.hhad.d, first.hhad.a],
      {
        tolerance: 0.1,
        league: first.league,
        sameLeague: false,
        handicap: Number(first.hhad.goalLine),
      },
    );
    assert.ok(spf.length > 0);
    assert.ok(spf.every((row) => row.matchKey));
    assert.ok(spf.some((row) => row.initialOdds?.length === 3));
    assert.ok(hhad.every((row) => row.matchKey));
    assert.ok(hhad.some((row) => row.initialOdds?.length === 3));
    assert.ok(goals.every((row) => row.matchKey));
    assert.ok(goals.some((row) => row.initialOdds?.length === 8));
    assert.equal(goals.length, counts.goalHistory);
    assert.equal(store.getSpfHistory().length, counts.spfHistory);
    const goalIds = new Set(store.getGoalHistory().map(row => row.historyId));
    const linkedGoals = store.getVerifiedHistory().filter(row => row.goals != null);
    assert.ok(linkedGoals.length > 0);
    assert.ok(linkedGoals.every(row => Number.isInteger(row.goalHistoryId) && goalIds.has(row.goalHistoryId)));
    assert.equal(store.getHhadHistory().length, counts.hhadHistory);
    assert.ok(
      store.getPairedSpfHhadHistory().length < store.getHhadHistory().length,
    );
  } finally {
    store.close();
  }
});

test("SQL赔率预筛与原全量历史过滤返回相同比赛", () => {
  const store = createDataStore(path.join(ROOT, "betwin.db"));
  try {
    const match = store.getMatches().find(
      (row) => row.had && row.hhad && row.goals,
    );
    assert.ok(match);
    const spfOdds = [match.had.h, match.had.d, match.had.a];
    const hhadOdds = [match.hhad.h, match.hhad.d, match.hhad.a];
    const handicap = Number(match.hhad.goalLine);
    const tolerance = 0.1;
    const within = (odds, target) =>
      odds.every(
        (value, index) =>
          value >= target[index] * (1 - tolerance) &&
          value <= target[index] * (1 + tolerance),
      );
    const identity = (row) => `${row.sourceFile}:${row.sourceRow}`;

    for (const sameLeague of [false, true]) {
      const options = { league: match.league, sameLeague };
      const fullSpf = store.getSpfHistory(options);
      const expectedSpf = fullSpf.filter((row) => within(row.odds, spfOdds));
      const actualSpf = store.getHistoricalSpf(spfOdds, {
        ...options,
        tolerance,
      });
      assert.deepEqual(actualSpf.map(identity), expectedSpf.map(identity));

      const fullHhad = store.getHhadHistory(options);
      const expectedHhad = fullHhad.filter(
        (row) => row.handicap === handicap && within(row.odds, hhadOdds),
      );
      const actualHhad = store.getHistoricalHhad(hhadOdds, {
        ...options,
        tolerance,
        handicap,
      });
      assert.deepEqual(actualHhad.map(identity), expectedHhad.map(identity));

      const zeroTolerance = sameLeague ? 2.5 : 2;
      const fullGoals = store.getGoalHistory(options);
      const expectedGoals = fullGoals.filter(
        (row) => Math.abs(Number(row.odds[0]) - Number(match.goals.g0)) <= zeroTolerance,
      );
      const actualGoals = store.getGoalHistoryNearZeroOdds(match.goals.g0, {
        ...options,
        tolerance: zeroTolerance,
      });
      assert.deepEqual(actualGoals.map(identity), expectedGoals.map(identity));

      const fullPaired = store.getPairedSpfHhadHistory(options);
      const expectedPaired = fullPaired.filter(
        (row) =>
          row.hhad.handicap === handicap &&
          within(row.spf.odds, spfOdds) &&
          within(row.hhad.odds, hhadOdds),
      );
      const actualPaired = store.getPairedSpfHhadHistoryNear(
        spfOdds,
        hhadOdds,
        {
          ...options,
          spfTolerance: tolerance,
          hhadTolerance: tolerance,
          handicap,
        },
      );
      assert.deepEqual(actualPaired.map(identity), expectedPaired.map(identity));
    }
  } finally {
    store.close();
  }
});

test("历史模型更新时间只跟随Excel历史源，不受realtime JSON导入影响", () => {
  const databasePath = path.join(ROOT, "betwin.db");
  const store = createDataStore(databasePath);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const historical = db.prepare(`
      SELECT MAX(imported_at) AS value
      FROM source_files
      WHERE file_type = 'xlsx'
    `).get().value;
    const allSources = db.prepare(`
      SELECT MAX(imported_at) AS value
      FROM source_files
    `).get().value;
    assert.equal(store.getHistoricalSourceUpdatedAt(), historical);
    assert.equal(store.getSourceUpdatedAt(), allSources);
    assert.ok(historical <= allSources);
  } finally {
    db.close();
    store.close();
  }
});

test("只开让球胜平负和进球盘的比赛也能载入", () => {
  const [match] = assembleCurrentMatches(
    [
      {
        match_id: 1001,
        display_name: "测试联赛: 主队 vs 客队",
        league: "测试联赛",
        home_team: "主队",
        away_team: "客队",
      },
    ],
    [
      {
        id: 1,
        match_id: 1001,
        market: "hhad",
        goal_line: -2,
        captured_at: "2026-07-31T01:00:00Z",
        home_odds: 2.1,
        draw_odds: 3.6,
        away_odds: 2.7,
      },
    ],
    [
      {
        id: 1,
        match_id: 1001,
        captured_at: "2026-07-31T01:00:00Z",
        g0: 20,
        g1: 8,
        g2: 4.5,
        g3: 3.4,
        g4: 4.2,
        g5: 7,
        g6: 12,
        g7plus: 18,
      },
    ],
  );
  assert.equal(match.had, null);
  assert.equal(match.hhad.goalLine, -2);
  assert.equal(match.goals.g3, 3.4);
});

test("没有普通胜平负时让球赔率使用独立历史池", () => {
  const store = createDataStore(path.join(ROOT, "betwin.db"));
  try {
    const rows = store.getHistoricalHhad([1.81, 4.1, 3], {
      tolerance: 0.07,
      league: "欧罗巴",
      sameLeague: false,
      handicap: -2,
    });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.handicap === -2));
  } finally {
    store.close();
  }
});

test("verified prediction pool contains all three markets from the same match", () => {
  const store = createDataStore(path.join(ROOT, "betwin.db"));
  try {
    const rows = store.getVerifiedHistory();
    assert.equal(rows.length, store.getCounts().verifiedHistory);
    assert.ok(
      rows.every(
        (row) =>
          row.matchKey &&
          row.spf.odds.length === 3 &&
          row.hhad.odds.length === 3 &&
          row.goalMarket.odds.length === 8,
      ),
    );
    // 缺少总进球盘口的比赛（match_status='spf_hhad_only'）仍进入胜平负/让球
    // 预测池，此时 goals 为空；只有配有进球数据的行才校验总进球一致性。
    const withGoals = rows.filter((row) => row.goals !== null);
    assert.ok(withGoals.length > 0);
    assert.ok(
      withGoals.every(
        (row) =>
          (row.totalGoals >= 7 ? "7+" : String(row.totalGoals)) === row.goals,
      ),
    );

    const sameLeague = store.getVerifiedHistory({
      league: "韩职",
      sameLeague: true,
    });
    assert.ok(sameLeague.length > 0);
    assert.ok(sameLeague.every((row) => row.league === "韩职"));
  } finally {
    store.close();
  }
});

test("settlement pool keeps market-only results and their own source rows", () => {
  const store = createDataStore(path.join(ROOT, "betwin.db"));
  try {
    const rows = store.getSettlementHistory();
    assert.equal(rows.length, store.getCounts().unifiedHistory);

    const hhadOnly = rows.find(
      (row) =>
        row.home === "本菲卡" &&
        row.away === "圣加仑" &&
        row.hhadSourceRow === 9195,
    );
    assert.ok(hhadOnly, "只开让球盘的赛果也必须进入结算池");
    assert.equal(hhadOnly.spfSourceFile, null);
    assert.equal(hhadOnly.hhadSourceFile, "lsspfpl.xlsx");
    assert.equal(hhadOnly.hhad.result, "胜");
    assert.equal(hhadOnly.hhad.handicap, -2);

    const goalsOnly = rows.find(
      (row) =>
        row.home === "本菲卡" &&
        row.away === "圣加仑" &&
        row.goalSourceRow === 8445,
    );
    assert.ok(goalsOnly, "只有进球数的赛果也必须进入结算池");
    assert.equal(goalsOnly.goalSourceFile, "历史进球数.xlsx");
    assert.equal(goalsOnly.goals, "5");
  } finally {
    store.close();
  }
});

test("unified history links every source record once without collapsing seasons", () => {
  const db = new DatabaseSync(path.join(ROOT, "betwin.db"), { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 7);

    const links = db
      .prepare(`
        SELECT COUNT(*) AS unified_rows,
               COUNT(spf_id) AS spf_links,
               COUNT(DISTINCT spf_id) AS unique_spf_links,
               COUNT(hhad_id) AS hhad_links,
               COUNT(DISTINCT hhad_id) AS unique_hhad_links,
               COUNT(goals_id) AS goal_links,
               COUNT(DISTINCT goals_id) AS unique_goal_links
        FROM historical_matches
      `)
      .get();
    const sourceCounts = db
      .prepare(`
        SELECT (SELECT COUNT(*) FROM historical_spf) AS spf,
               (SELECT COUNT(*) FROM historical_hhad) AS hhad,
               (SELECT COUNT(*) FROM historical_goals) AS goals
      `)
      .get();
    assert.ok(links.unified_rows >= links.spf_links);
    assert.ok(links.unified_rows >= links.hhad_links);
    assert.ok(links.unified_rows >= links.goal_links);
    assert.equal(links.spf_links, sourceCounts.spf);
    assert.equal(links.spf_links, links.unique_spf_links);
    assert.equal(links.hhad_links, sourceCounts.hhad);
    assert.equal(links.hhad_links, links.unique_hhad_links);
    assert.equal(links.goal_links, sourceCounts.goals);
    assert.equal(links.goal_links, links.unique_goal_links);

    const inconsistentGoals = db
      .prepare(`
        SELECT COUNT(*) AS total
        FROM historical_matches
        WHERE total_goals IS NOT NULL
          AND actual_goal_label IS NOT NULL
          AND CASE
                WHEN total_goals >= 7 THEN '7+'
                ELSE CAST(total_goals AS TEXT)
              END <> actual_goal_label
      `)
      .get().total;
    assert.equal(inconsistentGoals, 0);

    const repeatedFixture = db
      .prepare(`
        SELECT COUNT(*) AS match_count,
               MIN(fixture_occurrence_from_latest) AS newest_rank,
               MAX(fixture_occurrence_from_latest) AS oldest_rank
        FROM historical_matches
        WHERE spf_id IS NOT NULL
        GROUP BY league, home_team, away_team
        HAVING COUNT(*) >= 3
        ORDER BY match_count DESC
        LIMIT 1
      `)
      .get();
    assert.ok(repeatedFixture.match_count >= 3);
    assert.equal(repeatedFixture.newest_rank, 1);
    assert.equal(
      repeatedFixture.oldest_rank,
      repeatedFixture.match_count,
    );
  } finally {
    db.close();
  }
});

test("same-league query only returns the requested league", () => {
  const store = createDataStore(path.join(ROOT, "betwin.db"));
  try {
    const rows = store.getHistoricalGoals({ league: "韩职", sameLeague: true });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.league === "韩职"));
  } finally {
    store.close();
  }
});

test("historical records preserve their Excel source row for time-safe backtests", () => {
  const db = new DatabaseSync(path.join(ROOT, "betwin.db"), { readOnly: true });
  try {
    for (const table of [
      "historical_spf",
      "historical_hhad",
      "historical_goals",
    ]) {
      const summary = db
        .prepare(`
          SELECT COUNT(*) AS total,
                 SUM(source_file = '') AS missing_file,
                 SUM(source_row <= 0) AS missing_row
          FROM ${table}
        `)
        .get();
      assert.ok(summary.total > 8000);
      assert.equal(summary.missing_file, 0);
      assert.equal(summary.missing_row, 0);
    }
  } finally {
    db.close();
  }
});
