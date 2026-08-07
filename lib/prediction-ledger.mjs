import { DatabaseSync } from "node:sqlite";
import {
  GOAL_LABELS,
  selectTopGoalPair,
} from "./predictor.mjs";

const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS prediction_ledger (
  id INTEGER PRIMARY KEY,
  match_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('spf', 'hhad', 'goals')),
  handicap INTEGER,
  captured_at TEXT NOT NULL,
  source_updated_at TEXT,
  history_source_file TEXT NOT NULL,
  history_row_watermark INTEGER NOT NULL,
  league TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  display_name TEXT NOT NULL,
  predicted TEXT NOT NULL,
  top_labels_json TEXT NOT NULL,
  selected_probability REAL NOT NULL,
  selected_odds REAL NOT NULL,
  probabilities_json TEXT NOT NULL,
  odds_json TEXT NOT NULL,
  reliability_level TEXT NOT NULL CHECK (
    reliability_level IN ('recommended', 'cautious', 'skip')
  ),
  reliability_label TEXT NOT NULL,
  reliability_reason TEXT NOT NULL,
  threshold REAL NOT NULL,
  samples INTEGER NOT NULL,
  settings_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'settled')
  ),
  actual_result TEXT,
  score TEXT,
  correct INTEGER CHECK (correct IN (0, 1) OR correct IS NULL),
  simulated_return REAL,
  simulated_profit REAL,
  settled_source_file TEXT,
  settled_source_row INTEGER,
  settled_at TEXT,
  valid INTEGER NOT NULL DEFAULT 1 CHECK (valid IN (0, 1)),
  invalid_reason TEXT,
  UNIQUE (match_id, market, policy_version)
);

CREATE INDEX IF NOT EXISTS idx_prediction_ledger_status
  ON prediction_ledger (status, captured_at);
CREATE INDEX IF NOT EXISTS idx_prediction_ledger_grade
  ON prediction_ledger (reliability_level, market, status);
`;

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function goalPairForRow(row) {
  if (row.market !== "goals") return null;
  const probabilities = parseJson(row.probabilities_json, []);
  const odds = parseJson(row.odds_json, []);
  const pair = selectTopGoalPair(probabilities, odds);
  const actualIndex = GOAL_LABELS.indexOf(String(row.actual_result));
  const settled =
    row.status === "settled" &&
    actualIndex >= 0 &&
    pair.available;
  const correct = settled ? pair.indices.includes(actualIndex) : null;
  const simulatedReturn = settled && correct ? Number(odds[actualIndex]) : settled ? 0 : null;
  return {
    ...pair,
    correct,
    simulatedReturn,
    simulatedProfit:
      simulatedReturn === null ? null : simulatedReturn - pair.stakeUnits,
  };
}

function publicRow(row) {
  const settings = parseJson(row.settings_json, {});
  const sameLeague = Boolean(settings.sameLeague);
  return {
    id: row.id,
    matchId: row.match_id,
    policyVersion: row.policy_version,
    market: row.market,
    handicap: row.handicap,
    capturedAt: row.captured_at,
    league: row.league,
    home: row.home_team,
    away: row.away_team,
    displayName: row.display_name,
    predicted: row.predicted,
    topLabels: parseJson(row.top_labels_json, []),
    selectedProbability: row.selected_probability,
    selectedOdds: row.selected_odds,
    reliabilityLevel: row.reliability_level,
    reliabilityLabel: row.reliability_label,
    reliabilityReason: row.reliability_reason,
    threshold: row.threshold,
    samples: row.samples,
    sameLeague,
    sampleScope: sameLeague ? "同联赛" : "全部联赛",
    status: row.status,
    actualResult: row.actual_result,
    score: row.score,
    correct: row.correct === null ? null : Boolean(row.correct),
    simulatedReturn: row.simulated_return,
    simulatedProfit: row.simulated_profit,
    settledAt: row.settled_at,
    goalPair: goalPairForRow(row),
  };
}

function rowUsesSameLeague(row) {
  return Boolean(parseJson(row.settings_json, {}).sameLeague);
}

function groupMetrics(rows) {
  const settled = rows.filter(
    (row) => row.status === "settled" && row.correct !== null,
  );
  const correct = settled.filter((row) => row.correct === 1).length;
  const profit = settled.reduce(
    (sum, row) => sum + Number(row.simulated_profit || 0),
    0,
  );
  return {
    total: rows.length,
    pending: rows.filter((row) => row.status === "pending").length,
    settled: settled.length,
    correct,
    accuracy: settled.length ? correct / settled.length : null,
    simulatedProfit: profit,
    roi: settled.length ? profit / settled.length : null,
  };
}

function goalPairMetrics(rows) {
  const goalRows = rows.filter((row) => row.market === "goals");
  const settled = goalRows
    .map(goalPairForRow)
    .filter((pair) => pair?.correct !== null);
  const correct = settled.filter((pair) => pair.correct).length;
  const profit = settled.reduce(
    (sum, pair) => sum + Number(pair.simulatedProfit || 0),
    0,
  );
  const stake = settled.reduce(
    (sum, pair) => sum + Number(pair.stakeUnits || 0),
    0,
  );
  return {
    total: goalRows.length,
    pending: goalRows.filter((row) => row.status === "pending").length,
    settled: settled.length,
    correct,
    accuracy: settled.length ? correct / settled.length : null,
    simulatedProfit: profit,
    roi: stake ? profit / stake : null,
    stakeUnits: stake,
    costPerRecord: 2,
  };
}

function rowMatchesStatus(row, status) {
  if (!status || status === "all") return true;
  if (status === "pending" || status === "settled") {
    return row.status === status;
  }
  if (status === "hit") return row.status === "settled" && row.correct === 1;
  if (status === "miss") return row.status === "settled" && row.correct === 0;
  return true;
}

function filterRows(rows, options = {}) {
  const query = String(options.query || "").trim().toLowerCase();
  const from = String(options.from || "").trim();
  const to = String(options.to || "").trim();
  return rows.filter((row) => {
    if (!rowMatchesStatus(row, options.status)) return false;
    if (options.market && options.market !== "all" && row.market !== options.market) {
      return false;
    }
    if (options.scope === "global" && rowUsesSameLeague(row)) return false;
    if (options.scope === "same" && !rowUsesSameLeague(row)) return false;
    if (options.league && options.league !== "all" && row.league !== options.league) {
      return false;
    }
    if (from && row.captured_at.slice(0, 10) < from) return false;
    if (to && row.captured_at.slice(0, 10) > to) return false;
    if (
      query &&
      !`${row.league} ${row.home_team} ${row.away_team} ${row.display_name}`
        .toLowerCase()
        .includes(query)
    ) {
      return false;
    }
    return true;
  });
}

function paginateFixtures(rows, options = {}) {
  const pageSize = Math.max(1, Math.min(100, Math.trunc(Number(options.pageSize) || 20)));
  const fixtureMap = new Map();
  for (const row of rows) {
    if (!fixtureMap.has(row.match_id)) fixtureMap.set(row.match_id, []);
    fixtureMap.get(row.match_id).push(row);
  }
  const fixtures = [...fixtureMap.values()];
  const totalItems = fixtures.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.max(1, Math.min(totalPages, Math.trunc(Number(options.page) || 1)));
  const visible = fixtures.slice((page - 1) * pageSize, page * pageSize).flat();
  return {
    rows: visible.map(publicRow),
    page: { page, pageSize, totalItems, totalPages },
  };
}

export function createPredictionLedger(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(LEDGER_SCHEMA);
  const columns = new Set(
    db.prepare("PRAGMA table_info(prediction_ledger)").all()
      .map((column) => column.name),
  );
  if (!columns.has("valid")) {
    db.exec(
      "ALTER TABLE prediction_ledger ADD COLUMN valid INTEGER NOT NULL DEFAULT 1",
    );
  }
  if (!columns.has("invalid_reason")) {
    db.exec(
      "ALTER TABLE prediction_ledger ADD COLUMN invalid_reason TEXT",
    );
  }
  db.exec(`
    UPDATE prediction_ledger AS pending
    SET valid = 0,
        invalid_reason = '同一比赛同一玩法已有较早的赛前快照并完成结算'
    WHERE pending.status = 'pending'
      AND pending.valid = 1
      AND EXISTS (
        SELECT 1
        FROM prediction_ledger AS settled
        WHERE settled.match_id = pending.match_id
          AND settled.market = pending.market
          AND settled.status = 'settled'
          AND settled.valid = 1
          AND COALESCE(
            json_extract(settled.settings_json, '$.sameLeague'),
            0
          ) = COALESCE(
            json_extract(pending.settings_json, '$.sameLeague'),
            0
          )
      )
  `);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO prediction_ledger (
      match_id, policy_version, market, handicap, captured_at,
      source_updated_at, history_source_file, history_row_watermark,
      league, home_team, away_team, display_name, predicted,
      top_labels_json, selected_probability, selected_odds,
      probabilities_json, odds_json, reliability_level,
      reliability_label, reliability_reason, threshold, samples,
      settings_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);
  const pending = db.prepare(`
    SELECT * FROM prediction_ledger
    WHERE status = 'pending' AND valid = 1
    ORDER BY captured_at, id
  `);
  const settle = db.prepare(`
    UPDATE prediction_ledger
    SET status = 'settled',
        actual_result = ?,
        score = ?,
        correct = ?,
        simulated_return = ?,
        simulated_profit = ?,
        settled_source_file = ?,
        settled_source_row = ?,
        settled_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const allRows = db.prepare(`
    SELECT * FROM prediction_ledger
    WHERE valid = 1
    ORDER BY captured_at DESC, id DESC
  `);
  const existingFixture = db.prepare(`
    SELECT *
    FROM prediction_ledger
    WHERE match_id = ? AND market = ?
      AND valid = 1
      AND COALESCE(json_extract(settings_json, '$.sameLeague'), 0) = ?
    LIMIT 1
  `);
  const updatePending = db.prepare(`
    UPDATE prediction_ledger
    SET policy_version = ?,
        handicap = ?,
        captured_at = ?,
        source_updated_at = ?,
        league = ?,
        home_team = ?,
        away_team = ?,
        display_name = ?,
        predicted = ?,
        top_labels_json = ?,
        selected_probability = ?,
        selected_odds = ?,
        probabilities_json = ?,
        odds_json = ?,
        reliability_level = ?,
        reliability_label = ?,
        reliability_reason = ?,
        threshold = ?,
        samples = ?,
        settings_json = ?
    WHERE id = ? AND status = 'pending' AND valid = 1
  `);

  function record(snapshot) {
    const topLabelsJson = JSON.stringify(snapshot.topLabels || []);
    const probabilitiesJson = JSON.stringify(snapshot.probabilities || []);
    const oddsJson = JSON.stringify(snapshot.odds || []);
    const settingsJson = JSON.stringify(snapshot.settings || {});
    const sameLeague = Boolean(snapshot.settings?.sameLeague);
    const existing = existingFixture.get(
      snapshot.matchId,
      snapshot.market,
      sameLeague ? 1 : 0,
    );
    if (existing) {
      if (existing.status !== "pending") return false;
      const changed =
        existing.policy_version !== snapshot.policyVersion ||
        Number(existing.handicap) !== Number(snapshot.handicap) ||
        existing.predicted !== snapshot.predicted ||
        existing.top_labels_json !== topLabelsJson ||
        Number(existing.selected_probability) !==
          Number(snapshot.selectedProbability) ||
        Number(existing.selected_odds) !== Number(snapshot.selectedOdds) ||
        existing.probabilities_json !== probabilitiesJson ||
        existing.odds_json !== oddsJson ||
        existing.reliability_level !== snapshot.reliabilityLevel ||
        existing.reliability_label !== snapshot.reliabilityLabel ||
        existing.reliability_reason !== snapshot.reliabilityReason ||
        Number(existing.threshold) !== Number(snapshot.threshold) ||
        Number(existing.samples) !== Number(snapshot.samples) ||
        existing.settings_json !== settingsJson;
      if (!changed) return false;
      const result = updatePending.run(
        snapshot.policyVersion,
        snapshot.handicap ?? null,
        snapshot.capturedAt,
        snapshot.sourceUpdatedAt || null,
        snapshot.league,
        snapshot.home,
        snapshot.away,
        snapshot.displayName,
        snapshot.predicted,
        topLabelsJson,
        snapshot.selectedProbability,
        snapshot.selectedOdds,
        probabilitiesJson,
        oddsJson,
        snapshot.reliabilityLevel,
        snapshot.reliabilityLabel,
        snapshot.reliabilityReason,
        snapshot.threshold,
        snapshot.samples,
        settingsJson,
        existing.id,
      );
      return Number(result.changes || 0) > 0;
    }
    const result = insert.run(
      snapshot.matchId,
      snapshot.policyVersion,
      snapshot.market,
      snapshot.handicap ?? null,
      snapshot.capturedAt,
      snapshot.sourceUpdatedAt || null,
      snapshot.historySourceFile,
      snapshot.historyRowWatermark,
      snapshot.league,
      snapshot.home,
      snapshot.away,
      snapshot.displayName,
      snapshot.predicted,
      topLabelsJson,
      snapshot.selectedProbability,
      snapshot.selectedOdds,
      probabilitiesJson,
      oddsJson,
      snapshot.reliabilityLevel,
      snapshot.reliabilityLabel,
      snapshot.reliabilityReason,
      snapshot.threshold,
      snapshot.samples,
      settingsJson,
    );
    return Number(result.changes || 0) > 0;
  }

  function settleRow(id, result) {
    const correct = Boolean(result.correct);
    const simulatedReturn = correct ? Number(result.selectedOdds) : 0;
    const simulatedProfit = simulatedReturn - 1;
    return settle.run(
      result.actualResult,
      result.score || null,
      correct ? 1 : 0,
      simulatedReturn,
      simulatedProfit,
      result.sourceFile,
      result.sourceRow,
      result.settledAt,
      id,
    );
  }

  function summary(options = {}) {
    const rows = allRows.all();
    const fixtures = new Map();
    for (const row of rows) {
      if (!fixtures.has(row.match_id)) fixtures.set(row.match_id, []);
      fixtures.get(row.match_id).push(row);
    }
    const fixtureRows = [...fixtures.values()];
    const byReliability = Object.fromEntries(
      ["recommended", "cautious", "skip"].map((level) => [
        level,
        groupMetrics(rows.filter((row) => row.reliability_level === level)),
      ]),
    );
    const byMarket = Object.fromEntries(
      ["spf", "hhad", "goals"].map((market) => [
        market,
        groupMetrics(rows.filter((row) => row.market === market)),
      ]),
    );
    byMarket.goalsPair = goalPairMetrics(rows);
    const byScope = {
      all: groupMetrics(rows.filter((row) => !rowUsesSameLeague(row))),
      sameLeague: groupMetrics(rows.filter(rowUsesSameLeague)),
    };
    const settled = rows.filter((row) => row.status === "settled").length;
    const recommendedSettled = rows.filter(
      (row) =>
        row.status === "settled" &&
        row.reliability_level === "recommended",
    ).length;
    const filteredRows = filterRows(rows, options);
    const filteredFixtures = new Map();
    for (const row of filteredRows) {
      if (!filteredFixtures.has(row.match_id)) filteredFixtures.set(row.match_id, []);
      filteredFixtures.get(row.match_id).push(row);
    }
    const filteredMetrics = groupMetrics(filteredRows);
    const pagination = paginateFixtures(filteredRows, options);
    return {
      totals: {
        fixtures: fixtureRows.length,
        pendingFixtures: fixtureRows.filter((fixture) =>
          fixture.some((row) => row.status === "pending"),
        ).length,
        settledFixtures: fixtureRows.filter((fixture) =>
          fixture.every((row) => row.status === "settled"),
        ).length,
        snapshots: rows.length,
        pending: rows.filter((row) => row.status === "pending").length,
        settled,
        recommendedCoverage: settled
          ? recommendedSettled / settled
          : null,
      },
      byReliability,
      byMarket,
      byScope,
      filtered: {
        ...filteredMetrics,
        fixtures: filteredFixtures.size,
        pendingFixtures: [...filteredFixtures.values()].filter((fixture) =>
          fixture.some((row) => row.status === "pending"),
        ).length,
        byMarket: Object.fromEntries(
          ["spf", "hhad", "goals"].map((market) => [
            market,
            groupMetrics(filteredRows.filter((row) => row.market === market)),
          ]),
        ),
      },
      rows: pagination.rows,
      page: pagination.page,
      filters: {
        leagues: [...new Set(rows.map((row) => row.league))].sort((left, right) =>
          left.localeCompare(right, "zh-CN"),
        ),
      },
    };
  }

  return {
    record,
    pending: () => pending.all(),
    settle: settleRow,
    summary,
    close: () => db.close(),
  };
}
