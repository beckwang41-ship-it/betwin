import { DatabaseSync } from "node:sqlite";
import { buildRecentForm } from "./recent-form.mjs";

function groupBy(rows, keyBuilder) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyBuilder(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function marketPoint(row, includeGoalLine = false) {
  const point = {
    h: row.home_odds,
    d: row.draw_odds,
    a: row.away_odds,
    time: row.captured_at,
  };
  if (includeGoalLine) point.goalLine = row.goal_line;
  return point;
}

function buildThreeWayMarket(rows, includeGoalLine = false) {
  if (!rows.length) return null;
  const timeline = rows.map((row) => marketPoint(row, includeGoalLine));
  const initial = timeline[0];
  const final = timeline.at(-1);
  return {
    ...(includeGoalLine ? { goalLine: final.goalLine } : {}),
    h: final.h,
    d: final.d,
    a: final.a,
    history: { initial, final, timeline },
  };
}

function goalPoint(row) {
  return {
    g0: row.g0,
    g1: row.g1,
    g2: row.g2,
    g3: row.g3,
    g4: row.g4,
    g5: row.g5,
    g6: row.g6,
    g7plus: row.g7plus,
    time: row.captured_at,
  };
}

function buildGoalMarket(rows) {
  if (!rows.length) return null;
  const timeline = rows.map(goalPoint);
  const initial = timeline[0];
  const final = timeline.at(-1);
  return {
    ...final,
    history: { initial, final, timeline },
  };
}

function optionalOdds(values) {
  return values.every((value) => Number(value) > 1)
    ? values.map(Number)
    : null;
}

function mapVerifiedHistoryRow(row) {
  return {
    matchKey: row.match_key,
    league: row.league,
    home: row.home_team,
    away: row.away_team,
    score: row.score,
    totalGoals: row.total_goals,
    goals: row.actual_goals,
    occurrenceFromLatest: row.fixture_occurrence_from_latest,
    spfSourceFile: row.spf_source_file,
    spfSourceRow: row.spf_source_row,
    spfImportedAt: row.spf_imported_at,
    hhadSourceFile: row.hhad_source_file,
    hhadSourceRow: row.hhad_source_row,
    hhadImportedAt: row.hhad_imported_at,
    goalSourceFile: row.goals_source_file,
    goalHistoryId: row.goal_history_id ?? null,
    goalSourceRow: row.goals_source_row,
    goalImportedAt: row.goal_imported_at,
    spf: {
      result: row.spf_result,
      handicap: row.spf_handicap,
      initialOdds: optionalOdds([
        row.spf_initial_home,
        row.spf_initial_draw,
        row.spf_initial_away,
      ]),
      odds: [
        row.spf_final_home,
        row.spf_final_draw,
        row.spf_final_away,
      ],
    },
    hhad: {
      result: row.hhad_result,
      handicap: row.hhad_handicap,
      initialOdds: optionalOdds([
        row.hhad_initial_home,
        row.hhad_initial_draw,
        row.hhad_initial_away,
      ]),
      odds: [
        row.hhad_final_home,
        row.hhad_final_draw,
        row.hhad_final_away,
      ],
    },
    goalMarket: {
      initialOdds: optionalOdds([
        row.goal_initial_g0,
        row.goal_initial_g1,
        row.goal_initial_g2,
        row.goal_initial_g3,
        row.goal_initial_g4,
        row.goal_initial_g5,
        row.goal_initial_g6,
        row.goal_initial_g7plus,
      ]),
      odds: [
        row.goal_final_g0,
        row.goal_final_g1,
        row.goal_final_g2,
        row.goal_final_g3,
        row.goal_final_g4,
        row.goal_final_g5,
        row.goal_final_g6,
        row.goal_final_g7plus,
      ],
    },
  };
}

function spfHistoryRow(row) {
  return {
    matchKey: row.matchKey,
    league: row.league,
    home: row.home,
    away: row.away,
    score: row.score,
    result: row.spf.result,
    handicap: row.spf.handicap,
    totalGoals: row.totalGoals,
    initialOdds: row.spf.initialOdds,
    odds: row.spf.odds,
  };
}

function hhadHistoryRow(row) {
  return {
    matchKey: row.matchKey,
    league: row.league,
    home: row.home,
    away: row.away,
    score: row.score,
    result: row.hhad.result,
    handicap: row.hhad.handicap,
    totalGoals: row.totalGoals,
    initialOdds: row.hhad.initialOdds,
    odds: row.hhad.odds,
  };
}

function goalHistoryRow(row) {
  return {
    matchKey: row.matchKey,
    league: row.league,
    home: row.home,
    away: row.away,
    score: row.score,
    result: row.spf.result,
    goals: row.goals,
    initialOdds: row.goalMarket.initialOdds,
    odds: row.goalMarket.odds,
  };
}

function mapStandaloneSpfRow(row) {
  return {
    matchKey: row.match_key,
    league: row.league,
    home: row.home_team,
    away: row.away_team,
    score: row.score,
    result: row.result,
    handicap: row.handicap,
    totalGoals: row.total_goals,
    initialOdds: optionalOdds([
      row.initial_home_odds,
      row.initial_draw_odds,
      row.initial_away_odds,
    ]),
    odds: [row.final_home_odds, row.final_draw_odds, row.final_away_odds],
    sourceFile: row.source_file,
    sourceRow: row.source_row,
    historyId: row.history_id,
    historyBatchId: row.history_batch_id || 0,
  };
}

function mapStandaloneHhadRow(row) {
  return {
    matchKey: row.match_key,
    league: row.league,
    home: row.home_team,
    away: row.away_team,
    score: row.score,
    result: row.result,
    handicap: row.handicap,
    totalGoals: null,
    initialOdds: optionalOdds([
      row.initial_home_odds,
      row.initial_draw_odds,
      row.initial_away_odds,
    ]),
    odds: [row.final_home_odds, row.final_draw_odds, row.final_away_odds],
    sourceFile: row.source_file,
    sourceRow: row.source_row,
    historyId: row.history_id,
    historyBatchId: row.history_batch_id || 0,
  };
}

function mapStandaloneGoalRow(row) {
  return {
    matchKey: row.match_key,
    league: row.league,
    home: row.home_team,
    away: row.away_team,
    score: null,
    goals: row.actual_goals,
    initialOdds: optionalOdds([
      row.initial_g0,
      row.initial_g1,
      row.initial_g2,
      row.initial_g3,
      row.initial_g4,
      row.initial_g5,
      row.initial_g6,
      row.initial_g7plus,
    ]),
    odds: [
      row.final_g0,
      row.final_g1,
      row.final_g2,
      row.final_g3,
      row.final_g4,
      row.final_g5,
      row.final_g6,
      row.final_g7plus,
    ],
    sourceFile: row.source_file,
    sourceRow: row.source_row,
    historyId: row.history_id,
    historyBatchId: row.history_batch_id || 0,
  };
}

function mapPairedSpfHhadRow(row) {
  return {
    matchKey: row.match_key,
    league: row.league,
    home: row.home_team,
    away: row.away_team,
    score: row.score,
    totalGoals: row.total_goals,
    sourceFile: row.spf_source_file,
    sourceRow: row.spf_source_row,
    historyId: row.history_id,
    historyBatchId: row.history_batch_id || 0,
    spf: {
      matchKey: row.match_key,
      league: row.league,
      home: row.home_team,
      away: row.away_team,
      score: row.score,
      result: row.spf_result,
      handicap: row.spf_handicap,
      totalGoals: row.total_goals,
      sourceFile: row.spf_source_file,
      sourceRow: row.spf_source_row,
      historyId: row.history_id,
      historyBatchId: row.history_batch_id || 0,
      initialOdds: optionalOdds([
        row.spf_initial_home,
        row.spf_initial_draw,
        row.spf_initial_away,
      ]),
      odds: [row.spf_final_home, row.spf_final_draw, row.spf_final_away],
    },
    hhad: {
      matchKey: row.match_key,
      league: row.league,
      home: row.home_team,
      away: row.away_team,
      score: row.score,
      result: row.hhad_result,
      handicap: row.hhad_handicap,
      totalGoals: row.total_goals,
      sourceFile: row.hhad_source_file,
      sourceRow: row.hhad_source_row,
      historyId: row.hhad_id,
      historyBatchId: row.history_batch_id || 0,
      initialOdds: optionalOdds([
        row.hhad_initial_home,
        row.hhad_initial_draw,
        row.hhad_initial_away,
      ]),
      odds: [row.hhad_final_home, row.hhad_final_draw, row.hhad_final_away],
    },
  };
}

function oddsBounds(odds, tolerance) {
  if (
    !Array.isArray(odds) ||
    odds.length !== 3 ||
    odds.some((value) => !Number.isFinite(Number(value))) ||
    !Number.isFinite(Number(tolerance)) ||
    Number(tolerance) < 0
  ) {
    return null;
  }
  const range = Number(tolerance);
  return odds.flatMap((value) => {
    const numeric = Number(value);
    return [numeric * (1 - range), numeric * (1 + range)];
  });
}

export function assembleCurrentMatches(matches, spfSnapshots, goalSnapshots) {
  const spfGroups = groupBy(
    spfSnapshots,
    (row) => `${row.match_id}:${row.market}:${row.goal_line}`,
  );
  const goalGroups = groupBy(
    goalSnapshots,
    (row) => String(row.match_id),
  );

  return matches.map((match) => {
    const hadRows = spfGroups.get(`${match.match_id}:had:`) || [];
    const hhadGroups = [...spfGroups.entries()]
      .filter(([key]) => key.startsWith(`${match.match_id}:hhad:`))
      .map(([, rows]) => rows);
    const activeHhadRows =
      hhadGroups.sort((left, right) => right.at(-1).id - left.at(-1).id)[0] || [];
    const goalRows = goalGroups.get(String(match.match_id)) || [];
    const had = buildThreeWayMarket(hadRows);
    const hhad = buildThreeWayMarket(activeHhadRows, true);
    const goals = buildGoalMarket(goalRows);

    return {
      id: String(match.match_id),
      displayName: match.display_name,
      league: match.league,
      home: match.home_team,
      away: match.away_team,
      had,
      hhad,
      hadTimeline: had?.history?.timeline || [],
      hhadTimeline: hhad?.history?.timeline || [],
      goals,
      goalTimeline: goals?.history?.timeline || [],
    };
  });
}

export function createDataStore(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec("PRAGMA foreign_keys = ON");
  const batchColumn = (table, alias = "") =>
    db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === "history_batch_id")
      ? `${alias}history_batch_id` : "0";
  const currentMatchColumns = new Set(
    db.prepare("PRAGMA table_info(current_matches)").all()
      .map((column) => column.name),
  );
  const activeConditions = [
    currentMatchColumns.has("active") ? "active = 1" : null,
    `(
      EXISTS (
        SELECT 1
        FROM spf_odds_snapshots live_spf
        WHERE live_spf.match_id = current_matches.match_id
          AND live_spf.source_name = 'realtime_matches_had_hhad_history.json'
      )
      OR EXISTS (
        SELECT 1
        FROM goal_odds_snapshots live_goals
        WHERE live_goals.match_id = current_matches.match_id
          AND live_goals.source_name = 'realtime_matches_history.json'
      )
    )`,
  ].filter(Boolean);
  const activeMatchFilter = `WHERE ${activeConditions.join(" AND ")}`;

  const statements = {
    matches: db.prepare(`
      SELECT match_id, display_name, league, home_team, away_team, imported_at
      FROM current_matches
      ${activeMatchFilter}
      ORDER BY match_id
    `),
    spfSnapshots: db.prepare(`
      SELECT id, match_id, market, goal_line, captured_at,
             home_odds, draw_odds, away_odds
      FROM spf_odds_snapshots
      ORDER BY match_id, market, goal_line, captured_at, id
    `),
    goalSnapshots: db.prepare(`
      SELECT id, match_id, captured_at, g0, g1, g2, g3, g4, g5, g6, g7plus
      FROM goal_odds_snapshots
      ORDER BY match_id, captured_at, id
    `),
    standaloneSpfHistory: db.prepare(`
      SELECT fingerprint AS match_key, league, home_team, away_team, score,
             result, handicap, total_goals,
             initial_home_odds, initial_draw_odds, initial_away_odds,
             final_home_odds, final_draw_odds, final_away_odds,
             source_file, source_row, id AS history_id, ${batchColumn("historical_spf")} AS history_batch_id
      FROM historical_spf
      WHERE (? = 0 OR league = ?)
      ORDER BY source_file, source_row DESC
    `),
    nearbySpfHistory: db.prepare(`
      SELECT fingerprint AS match_key, league, home_team, away_team, score,
             result, handicap, total_goals,
             initial_home_odds, initial_draw_odds, initial_away_odds,
             final_home_odds, final_draw_odds, final_away_odds,
             source_file, source_row, id AS history_id, ${batchColumn("historical_spf")} AS history_batch_id
      FROM historical_spf
      WHERE final_home_odds BETWEEN ? AND ?
        AND final_draw_odds BETWEEN ? AND ?
        AND final_away_odds BETWEEN ? AND ?
        AND (? = 0 OR league = ?)
      ORDER BY source_file, source_row DESC
    `),
    standaloneHhadHistory: db.prepare(`
      SELECT fingerprint AS match_key, league, home_team, away_team, score,
             result, handicap,
             initial_home_odds, initial_draw_odds, initial_away_odds,
             final_home_odds, final_draw_odds, final_away_odds,
             source_file, source_row, id AS history_id, ${batchColumn("historical_hhad")} AS history_batch_id
      FROM historical_hhad
      WHERE (? = 0 OR league = ?)
      ORDER BY source_file, source_row DESC
    `),
    nearbyHhadHistory: db.prepare(`
      SELECT fingerprint AS match_key, league, home_team, away_team, score,
             result, handicap,
             initial_home_odds, initial_draw_odds, initial_away_odds,
             final_home_odds, final_draw_odds, final_away_odds,
             source_file, source_row, id AS history_id, ${batchColumn("historical_hhad")} AS history_batch_id
      FROM historical_hhad
      WHERE handicap = ?
        AND final_home_odds BETWEEN ? AND ?
        AND final_draw_odds BETWEEN ? AND ?
        AND final_away_odds BETWEEN ? AND ?
        AND (? = 0 OR league = ?)
      ORDER BY source_file, source_row DESC
    `),
    standaloneGoalHistory: db.prepare(`
      SELECT fingerprint AS match_key, league, home_team, away_team,
             actual_goals,
             initial_g0, initial_g1, initial_g2, initial_g3,
             initial_g4, initial_g5, initial_g6, initial_g7plus,
             final_g0, final_g1, final_g2, final_g3,
             final_g4, final_g5, final_g6, final_g7plus,
             source_file, source_row, id AS history_id, ${batchColumn("historical_goals")} AS history_batch_id
      FROM historical_goals
      WHERE (? = 0 OR league = ?)
      ORDER BY source_file, source_row DESC
    `),
    nearbyGoalHistory: db.prepare(`
      SELECT fingerprint AS match_key, league, home_team, away_team,
             actual_goals,
             initial_g0, initial_g1, initial_g2, initial_g3,
             initial_g4, initial_g5, initial_g6, initial_g7plus,
             final_g0, final_g1, final_g2, final_g3,
             final_g4, final_g5, final_g6, final_g7plus,
             source_file, source_row, id AS history_id, ${batchColumn("historical_goals")} AS history_batch_id
      FROM historical_goals
      WHERE final_g0 BETWEEN ? AND ?
        AND (? = 0 OR league = ?)
      ORDER BY source_file, source_row DESC
    `),
    pairedSpfHhadHistory: db.prepare(`
      SELECT m.match_key, s.id AS history_id, h.id AS hhad_id, ${batchColumn("historical_spf", "s.")} AS history_batch_id,
             m.spf_source_file, m.spf_source_row,
             m.hhad_source_file, m.hhad_source_row,
             s.league, s.home_team, s.away_team, s.score, s.total_goals,
             s.result AS spf_result, s.handicap AS spf_handicap,
             s.initial_home_odds AS spf_initial_home,
             s.initial_draw_odds AS spf_initial_draw,
             s.initial_away_odds AS spf_initial_away,
             s.final_home_odds AS spf_final_home,
             s.final_draw_odds AS spf_final_draw,
             s.final_away_odds AS spf_final_away,
             h.result AS hhad_result, h.handicap AS hhad_handicap,
             h.initial_home_odds AS hhad_initial_home,
             h.initial_draw_odds AS hhad_initial_draw,
             h.initial_away_odds AS hhad_initial_away,
             h.final_home_odds AS hhad_final_home,
             h.final_draw_odds AS hhad_final_draw,
             h.final_away_odds AS hhad_final_away
      FROM historical_matches m
      JOIN historical_spf s ON s.id = m.spf_id
      JOIN historical_hhad h ON h.id = m.hhad_id
      WHERE (? = 0 OR s.league = ?)
      ORDER BY s.source_file, s.source_row DESC
    `),
    nearbyPairedSpfHhadHistory: db.prepare(`
      SELECT m.match_key, s.id AS history_id, h.id AS hhad_id, ${batchColumn("historical_spf", "s.")} AS history_batch_id,
             m.spf_source_file, m.spf_source_row,
             m.hhad_source_file, m.hhad_source_row,
             s.league, s.home_team, s.away_team, s.score, s.total_goals,
             s.result AS spf_result, s.handicap AS spf_handicap,
             s.initial_home_odds AS spf_initial_home,
             s.initial_draw_odds AS spf_initial_draw,
             s.initial_away_odds AS spf_initial_away,
             s.final_home_odds AS spf_final_home,
             s.final_draw_odds AS spf_final_draw,
             s.final_away_odds AS spf_final_away,
             h.result AS hhad_result, h.handicap AS hhad_handicap,
             h.initial_home_odds AS hhad_initial_home,
             h.initial_draw_odds AS hhad_initial_draw,
             h.initial_away_odds AS hhad_initial_away,
             h.final_home_odds AS hhad_final_home,
             h.final_draw_odds AS hhad_final_draw,
             h.final_away_odds AS hhad_final_away
      FROM historical_matches m
      JOIN historical_spf s ON s.id = m.spf_id
      JOIN historical_hhad h ON h.id = m.hhad_id
      WHERE h.handicap = ?
        AND s.final_home_odds BETWEEN ? AND ?
        AND s.final_draw_odds BETWEEN ? AND ?
        AND s.final_away_odds BETWEEN ? AND ?
        AND h.final_home_odds BETWEEN ? AND ?
        AND h.final_draw_odds BETWEEN ? AND ?
        AND h.final_away_odds BETWEEN ? AND ?
        AND (? = 0 OR s.league = ?)
      ORDER BY s.source_file, s.source_row DESC
    `),
    verifiedHistory: db.prepare(`
      SELECT m.match_key, m.fixture_occurrence_from_latest,
             g.id AS goal_history_id,
             m.spf_source_file, m.spf_source_row,
             m.hhad_source_file, m.hhad_source_row,
             m.goals_source_file, m.goals_source_row,
             s.league, s.home_team, s.away_team, s.score, s.total_goals,
             s.result AS spf_result, s.handicap AS spf_handicap,
             s.initial_home_odds AS spf_initial_home,
             s.initial_draw_odds AS spf_initial_draw,
             s.initial_away_odds AS spf_initial_away,
             s.final_home_odds AS spf_final_home,
             s.final_draw_odds AS spf_final_draw,
             s.final_away_odds AS spf_final_away,
             h.result AS hhad_result, h.handicap AS hhad_handicap,
             h.initial_home_odds AS hhad_initial_home,
             h.initial_draw_odds AS hhad_initial_draw,
             h.initial_away_odds AS hhad_initial_away,
             h.final_home_odds AS hhad_final_home,
             h.final_draw_odds AS hhad_final_draw,
             h.final_away_odds AS hhad_final_away,
             g.actual_goals,
             g.initial_g0 AS goal_initial_g0,
             g.initial_g1 AS goal_initial_g1,
             g.initial_g2 AS goal_initial_g2,
             g.initial_g3 AS goal_initial_g3,
             g.initial_g4 AS goal_initial_g4,
             g.initial_g5 AS goal_initial_g5,
             g.initial_g6 AS goal_initial_g6,
             g.initial_g7plus AS goal_initial_g7plus,
             g.final_g0 AS goal_final_g0,
             g.final_g1 AS goal_final_g1,
             g.final_g2 AS goal_final_g2,
             g.final_g3 AS goal_final_g3,
             g.final_g4 AS goal_final_g4,
             g.final_g5 AS goal_final_g5,
             g.final_g6 AS goal_final_g6,
             g.final_g7plus AS goal_final_g7plus
      FROM historical_matches m
      JOIN historical_spf s ON s.id = m.spf_id
      JOIN historical_hhad h ON h.id = m.hhad_id
      LEFT JOIN historical_goals g ON g.id = m.goals_id
      WHERE m.match_status IN ('matched', 'spf_hhad_only')
        AND (m.goals_id IS NULL OR m.goal_consistent = 1)
        AND (? = 0 OR s.league = ?)
      ORDER BY m.spf_source_file, m.spf_source_row DESC
    `),
    settlementHistory: db.prepare(`
      SELECT m.match_key, m.fixture_occurrence_from_latest,
             m.spf_source_file, m.spf_source_row,
             m.hhad_source_file, m.hhad_source_row,
             m.goals_source_file, m.goals_source_row,
             m.league, m.home_team, m.away_team, m.score, m.total_goals,
             s.result AS spf_result, s.handicap AS spf_handicap,
             s.initial_home_odds AS spf_initial_home,
             s.initial_draw_odds AS spf_initial_draw,
             s.initial_away_odds AS spf_initial_away,
             s.final_home_odds AS spf_final_home,
             s.final_draw_odds AS spf_final_draw,
             s.final_away_odds AS spf_final_away,
             s.imported_at AS spf_imported_at,
             h.result AS hhad_result, h.handicap AS hhad_handicap,
             h.initial_home_odds AS hhad_initial_home,
             h.initial_draw_odds AS hhad_initial_draw,
             h.initial_away_odds AS hhad_initial_away,
             h.final_home_odds AS hhad_final_home,
             h.final_draw_odds AS hhad_final_draw,
             h.final_away_odds AS hhad_final_away,
             h.imported_at AS hhad_imported_at,
             COALESCE(g.actual_goals, m.actual_goal_label) AS actual_goals,
             g.initial_g0 AS goal_initial_g0,
             g.initial_g1 AS goal_initial_g1,
             g.initial_g2 AS goal_initial_g2,
             g.initial_g3 AS goal_initial_g3,
             g.initial_g4 AS goal_initial_g4,
             g.initial_g5 AS goal_initial_g5,
             g.initial_g6 AS goal_initial_g6,
             g.initial_g7plus AS goal_initial_g7plus,
             g.final_g0 AS goal_final_g0,
             g.final_g1 AS goal_final_g1,
             g.final_g2 AS goal_final_g2,
             g.final_g3 AS goal_final_g3,
             g.final_g4 AS goal_final_g4,
             g.final_g5 AS goal_final_g5,
             g.final_g6 AS goal_final_g6,
             g.final_g7plus AS goal_final_g7plus,
             g.imported_at AS goal_imported_at
      FROM historical_matches m
      LEFT JOIN historical_spf s ON s.id = m.spf_id
      LEFT JOIN historical_hhad h ON h.id = m.hhad_id
      LEFT JOIN historical_goals g ON g.id = m.goals_id
      ORDER BY m.id DESC
    `),
    counts: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM historical_spf) AS spf_history,
        (SELECT COUNT(*) FROM historical_hhad) AS hhad_history,
        (SELECT COUNT(*) FROM historical_goals) AS goal_history,
        (SELECT COUNT(*) FROM historical_matches) AS unified_history,
        (SELECT COUNT(*)
          FROM historical_matches m
          JOIN historical_spf s ON s.id = m.spf_id
          JOIN historical_hhad h ON h.id = m.hhad_id
          LEFT JOIN historical_goals g ON g.id = m.goals_id
          WHERE m.match_status IN ('matched', 'spf_hhad_only')
            AND (m.goals_id IS NULL OR m.goal_consistent = 1)
        ) AS verified_history,
        (SELECT COUNT(*) FROM current_matches
          ${activeMatchFilter}
        ) AS current_matches,
        (SELECT COUNT(*) FROM current_matches) AS stored_current_matches
    `),
    scopedHistoryCounts: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM historical_spf
          WHERE (? = 0 OR league = ?)
        ) AS spf_history,
        (SELECT COUNT(*) FROM historical_hhad
          WHERE (? = 0 OR league = ?)
        ) AS hhad_history,
        (SELECT COUNT(*) FROM historical_goals
          WHERE (? = 0 OR league = ?)
        ) AS goal_history
    `),
    sourceUpdatedAt: db.prepare(`
      SELECT MAX(imported_at) AS updated_at
      FROM source_files
    `),
    historicalSourceUpdatedAt: db.prepare(`
      SELECT MAX(imported_at) AS updated_at
      FROM source_files
      WHERE file_type = 'xlsx'
    `),
    sourceFileUpdatedAt: db.prepare(`
      SELECT imported_at AS updated_at
      FROM source_files
      WHERE file_name = ?
    `),
  };

  function getMatches() {
    return assembleCurrentMatches(
      statements.matches.all(),
      statements.spfSnapshots.all(),
      statements.goalSnapshots.all(),
    );
  }

  function getVerifiedHistory({ league = "", sameLeague = false } = {}) {
    return statements.verifiedHistory
      .all(sameLeague ? 1 : 0, league)
      .map(mapVerifiedHistoryRow);
  }

  function getSpfHistory({ league = "", sameLeague = false } = {}) {
    return statements.standaloneSpfHistory
      .all(sameLeague ? 1 : 0, league)
      .map(mapStandaloneSpfRow);
  }

  function getHhadHistory({ league = "", sameLeague = false } = {}) {
    return statements.standaloneHhadHistory
      .all(sameLeague ? 1 : 0, league)
      .map(mapStandaloneHhadRow);
  }

  function getGoalHistory({ league = "", sameLeague = false, includeScores = false } = {}) {
    const rows = statements.standaloneGoalHistory
      .all(sameLeague ? 1 : 0, league)
      .map(mapStandaloneGoalRow);
    if (includeScores) {
      // 比分仅作报告展示，按数据库外键关联；缺少比分不排除进球样本。
      const scores = new Map(db.prepare(`SELECT goals_id, score FROM historical_matches
        WHERE goals_id IS NOT NULL AND goal_consistent = 1 AND match_status = 'matched'`).all()
        .map(row => [row.goals_id, row.score]));
      for (const row of rows) row.score = scores.get(row.historyId) || null;
    }
    return rows;
  }

  function getPairedSpfHhadHistory({ league = "", sameLeague = false } = {}) {
    return statements.pairedSpfHhadHistory
      .all(sameLeague ? 1 : 0, league)
      .map(mapPairedSpfHhadRow);
  }

  function getSettlementHistory() {
    return statements.settlementHistory.all().map(mapVerifiedHistoryRow);
  }

  function getHistoricalSpf(targetOdds, { tolerance, league, sameLeague }) {
    const bounds = oddsBounds(targetOdds, tolerance);
    if (!bounds) return [];
    return statements.nearbySpfHistory
      .all(...bounds, sameLeague ? 1 : 0, league)
      .map(mapStandaloneSpfRow);
  }

  function getHistoricalGoals({ league, sameLeague }) {
    return getGoalHistory({ league, sameLeague });
  }

  function getHistoricalHhad(
    targetOdds,
    { tolerance, league, sameLeague, handicap },
  ) {
    const bounds = oddsBounds(targetOdds, tolerance);
    const numericHandicap = Number(handicap);
    if (!bounds || !Number.isFinite(numericHandicap)) return [];
    return statements.nearbyHhadHistory
      .all(numericHandicap, ...bounds, sameLeague ? 1 : 0, league)
      .map(mapStandaloneHhadRow);
  }

  function getGoalHistoryNearZeroOdds(
    zeroOdds,
    { tolerance, league = "", sameLeague = false },
  ) {
    const target = Number(zeroOdds);
    const range = Number(tolerance);
    if (!Number.isFinite(target) || !Number.isFinite(range) || range < 0) {
      return [];
    }
    return statements.nearbyGoalHistory
      .all(
        target - range,
        target + range,
        sameLeague ? 1 : 0,
        league,
      )
      .map(mapStandaloneGoalRow);
  }

  function getPairedSpfHhadHistoryNear(
    spfOdds,
    hhadOdds,
    {
      spfTolerance,
      hhadTolerance,
      handicap,
      league = "",
      sameLeague = false,
    },
  ) {
    const spfBounds = oddsBounds(spfOdds, spfTolerance);
    const hhadBounds = oddsBounds(hhadOdds, hhadTolerance);
    const numericHandicap = Number(handicap);
    if (
      !spfBounds ||
      !hhadBounds ||
      !Number.isFinite(numericHandicap)
    ) {
      return [];
    }
    return statements.nearbyPairedSpfHhadHistory
      .all(
        numericHandicap,
        ...spfBounds,
        ...hhadBounds,
        sameLeague ? 1 : 0,
        league,
      )
      .map(mapPairedSpfHhadRow);
  }

  function getCounts() {
    const row = statements.counts.get();
    return {
      spfHistory: row.spf_history,
      hhadHistory: row.hhad_history,
      goalHistory: row.goal_history,
      unifiedHistory: row.unified_history,
      verifiedHistory: row.verified_history,
      currentMatches: row.current_matches,
      storedCurrentMatches: row.stored_current_matches,
    };
  }

  function getHistoryCounts({ league = "", sameLeague = false } = {}) {
    const scoped = sameLeague ? 1 : 0;
    const row = statements.scopedHistoryCounts.get(
      scoped,
      league,
      scoped,
      league,
      scoped,
      league,
    );
    return {
      spfHistory: Number(row?.spf_history || 0),
      hhadHistory: Number(row?.hhad_history || 0),
      goalHistory: Number(row?.goal_history || 0),
    };
  }

  function getSourceUpdatedAt() {
    return statements.sourceUpdatedAt.get()?.updated_at || null;
  }

  function getHistoricalSourceUpdatedAt() {
    return statements.historicalSourceUpdatedAt.get()?.updated_at || null;
  }

  function getSourceFileUpdatedAt(fileName) {
    return statements.sourceFileUpdatedAt.get(String(fileName || ""))
      ?.updated_at || null;
  }

  let formBatch = null;
  function getRecentForm(match) {
    const row = db.prepare("SELECT imported_at, payload_json FROM raw_json_documents WHERE file_name = ?").get("match_data1.json");
    if (!row) return buildRecentForm(null);
    if (!formBatch || formBatch.payload !== row.payload_json || formBatch.importedAt !== row.imported_at) {
      const details = JSON.parse(row.payload_json);
      if (!Array.isArray(details)) throw new Error("match_data1.json 战绩数据应为数组");
      formBatch = { payload: row.payload_json, importedAt: row.imported_at, details: new Map(details.map(d => [String(d.matchId), d])) };
    }
    return buildRecentForm(formBatch.details.get(String(match.id)), { match, importedAt: row.imported_at });
  }

  function getDataStatus() {
    return {
      oddsCollectedAt: null,
      collectionNote: "数据未保存独立的采集完成时间；盘口时间只代表上游赔率记录。",
      currentImportedAt: db.prepare("SELECT MAX(imported_at) AS time FROM raw_json_documents").get()?.time || null,
      historicalUpdatedAt: getHistoricalSourceUpdatedAt(),
      historyOrder: "每日历史按数据库首次入库批次排序，后入库更新；旧累加文件保留各自原有顺序。",
    };
  }

  return {
    getMatches,
    getHistoricalSpf,
    getHistoricalHhad,
    getHistoricalGoals,
    getGoalHistoryNearZeroOdds,
    getPairedSpfHhadHistoryNear,
    getSpfHistory,
    getHhadHistory,
    getGoalHistory,
    getPairedSpfHhadHistory,
    getVerifiedHistory,
    getSettlementHistory,
    getCounts,
    getHistoryCounts,
    getSourceUpdatedAt,
    getHistoricalSourceUpdatedAt,
    getSourceFileUpdatedAt,
    getDataStatus,
    getRecentForm,
    close: () => db.close(),
  };
}
