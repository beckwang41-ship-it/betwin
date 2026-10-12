import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ledgerCalendarDate } from "../public/ledger-date.js";

const PARLAY_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS parlay_ledger (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  combination_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('standard', 'goalsPair')),
  selection_source TEXT NOT NULL CHECK (
    selection_source IN ('system_default', 'user_saved')
  ),
  policy_version TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source_updated_at TEXT,
  history_source_file TEXT NOT NULL,
  history_row_watermark INTEGER NOT NULL,
  legs_json TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  total_stake REAL NOT NULL,
  hit_probability REAL NOT NULL,
  value_index REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'settled')
  ),
  correct INTEGER CHECK (correct IN (0, 1) OR correct IS NULL),
  simulated_return REAL,
  simulated_profit REAL,
  actual_results_json TEXT,
  settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_parlay_ledger_status
  ON parlay_ledger (status, captured_at);
CREATE INDEX IF NOT EXISTS idx_parlay_ledger_mode
  ON parlay_ledger (mode, selection_source, status);
`;

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function fingerprintFor(snapshot) {
  const legs = snapshot.legs
    .map((leg) => ({
      matchId: String(leg.matchId),
      market: String(leg.market),
      handicap:
        leg.handicap === null || leg.handicap === undefined
          ? null
          : Number(leg.handicap),
      labels: leg.selections.map((selection) => String(selection.label)).sort(),
    }))
    .sort((left, right) =>
      `${left.matchId}:${left.market}`.localeCompare(
        `${right.matchId}:${right.market}`,
      ),
    );
  return createHash("sha256")
    .update(
      JSON.stringify({
        mode: snapshot.mode,
        policyVersion: snapshot.policyVersion,
        algorithmVersion: snapshot.settings?.algorithmVersion || null,
        legs,
      }),
    )
    .digest("hex");
}

function publicRow(row) {
  return {
    id: Number(row.id),
    fingerprint: row.fingerprint,
    combinationId: row.combination_id,
    mode: row.mode,
    selectionSource: row.selection_source,
    policyVersion: row.policy_version,
    algorithmVersion: parseJson(row.settings_json, {}).algorithmVersion || null,
    capturedAt: row.captured_at,
    legs: parseJson(row.legs_json, []),
    settings: parseJson(row.settings_json, {}),
    totalStake: Number(row.total_stake),
    hitProbability: Number(row.hit_probability),
    valueIndex: Number(row.value_index),
    status: row.status,
    correct: row.correct === null ? null : Boolean(row.correct),
    simulatedReturn:
      row.simulated_return === null ? null : Number(row.simulated_return),
    simulatedProfit:
      row.simulated_profit === null ? null : Number(row.simulated_profit),
    actualResults: parseJson(row.actual_results_json, []),
    settledAt: row.settled_at,
  };
}

function metrics(rows) {
  const settled = rows.filter(
    (row) => row.status === "settled" && row.correct !== null,
  );
  const correct = settled.filter((row) => row.correct === 1).length;
  const stake = settled.reduce(
    (sum, row) => sum + Number(row.total_stake || 0),
    0,
  );
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
    stakeUnits: stake,
    roi: stake ? profit / stake : null,
  };
}

function performanceEvents(rows) {
  return rows
    .filter(
      (row) =>
        row.status === "settled" &&
        row.correct !== null &&
        Number(row.total_stake) > 0 &&
        row.simulated_profit !== null,
    )
    .map((row) => ({
      id: `parlay:${row.id}`,
      type: "parlay",
      market: row.mode,
      capturedAt: row.captured_at,
      settledAt: row.settled_at,
      correct: Boolean(row.correct),
      stakeUnits: Number(row.total_stake),
      simulatedProfit: Number(row.simulated_profit),
    }));
}

export function parlaySettlementDecision(legCount, actualResults = []) {
  if (actualResults.some((result) => !result.correct)) {
    return { ready: true, correct: false };
  }
  if (Number(legCount) > 0 && actualResults.length === Number(legCount)) {
    return { ready: true, correct: true };
  }
  return { ready: false, correct: null };
}

export function settlementRowEligible(
  sourceRow,
  watermark,
  sourceChanged = false,
) {
  const row = Number(sourceRow || 0);
  const boundary = Number(watermark || 0);
  return row > boundary || (sourceChanged && row === boundary);
}

function rowMatchesStatus(row, status) {
  if (!status || status === "all") return true;
  if (status === "pending" || status === "settled") return row.status === status;
  if (status === "hit") return row.status === "settled" && row.correct === 1;
  if (status === "miss") return row.status === "settled" && row.correct === 0;
  return true;
}



function policyRows(rows, options = {}) {
  const mode = String(options.policyVersion || "all");
  const prefix = String(options.currentPolicyPrefix || "");
  const currentVersions = new Set(
    (Array.isArray(options.currentPolicyVersions)
      ? options.currentPolicyVersions
      : [])
      .map(String)
      .filter(Boolean),
  );
  if (mode === "all" || !mode) return rows;
  if (mode === "unknown") return rows.filter(row => !parseJson(row.settings_json, {}).algorithmVersion);
  if (mode === "current" && currentVersions.size) {
    return rows.filter((row) =>
      currentVersions.has(parseJson(row.settings_json, {}).algorithmVersion || row.policy_version),
    );
  }
  if (mode === "legacy" && currentVersions.size) {
    return rows.filter(
      (row) =>
        !currentVersions.has(parseJson(row.settings_json, {}).algorithmVersion || row.policy_version),
    );
  }
  if (mode === "current" && prefix) {
    return rows.filter((row) => row.policy_version.startsWith(prefix));
  }
  if (mode === "legacy" && prefix) {
    return rows.filter((row) => !row.policy_version.startsWith(prefix));
  }
  return rows.filter((row) => row.policy_version === mode);
}

function filterRows(rows, options = {}) {
  const query = String(options.query || "").trim().toLowerCase();
  const from = String(options.from || "").trim();
  const to = String(options.to || "").trim();
  return rows.filter((row) => {
    if (!rowMatchesStatus(row, options.status)) return false;
    if (options.mode && options.mode !== "all" && row.mode !== options.mode) return false;
    if (
      options.source &&
      options.source !== "all" &&
      row.selection_source !== options.source
    ) {
      return false;
    }
    const date = ledgerCalendarDate(row.captured_at);
    if (from && date < from) return false;
    if (to && date > to) return false;
    if (query) {
      const legs = parseJson(row.legs_json, []);
      const searchable = legs
        .map((leg) => `${leg.league || ""} ${leg.home || ""} ${leg.away || ""}`)
        .join(" ")
        .toLowerCase();
      if (!searchable.includes(query)) return false;
    }
    return true;
  });
}

export function createParlayLedger(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(PARLAY_LEDGER_SCHEMA);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO parlay_ledger (
      fingerprint, combination_id, mode, selection_source, policy_version,
      captured_at, source_updated_at, history_source_file,
      history_row_watermark, legs_json, settings_json, total_stake,
      hit_probability, value_index
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const byFingerprint = db.prepare(`
    SELECT * FROM parlay_ledger WHERE fingerprint = ?
  `);
  const pending = db.prepare(`
    SELECT * FROM parlay_ledger
    WHERE status = 'pending'
    ORDER BY captured_at, id
  `);
  const incompleteSettled = db.prepare(`
    SELECT * FROM parlay_ledger
    WHERE status = 'settled'
      AND json_array_length(COALESCE(actual_results_json, '[]'))
        < json_array_length(legs_json)
    ORDER BY captured_at, id
  `);
  const settle = db.prepare(`
    UPDATE parlay_ledger
    SET status = 'settled',
        correct = ?,
        simulated_return = ?,
        simulated_profit = ?,
        actual_results_json = ?,
        settled_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const updateActualResults = db.prepare(`
    UPDATE parlay_ledger
    SET actual_results_json = ?
    WHERE id = ?
      AND COALESCE(actual_results_json, '[]') <> ?
  `);
  const allRows = db.prepare(`
    SELECT * FROM parlay_ledger
    ORDER BY captured_at DESC, id DESC
  `);

  function record(snapshot) {
    const fingerprint = fingerprintFor(snapshot);
    const selectionSource =
      snapshot.selectionSource === "system_default"
        ? "system_default"
        : "user_saved";
    const result = insert.run(
      fingerprint,
      snapshot.combinationId,
      snapshot.mode,
      selectionSource,
      snapshot.policyVersion,
      snapshot.capturedAt,
      snapshot.sourceUpdatedAt || null,
      snapshot.historySourceFile,
      snapshot.historyRowWatermark,
      JSON.stringify(snapshot.legs),
      JSON.stringify(snapshot.settings || {}),
      snapshot.totalStake,
      snapshot.hitProbability,
      snapshot.valueIndex,
    );
    const row = byFingerprint.get(fingerprint);
    return {
      inserted: Number(result.changes || 0) > 0,
      row: publicRow(row),
    };
  }

  function settleRow(id, result) {
    const correct = Boolean(result.correct);
    const simulatedReturn = correct
      ? Number(Number(result.simulatedReturn || 0).toFixed(3))
      : 0;
    const totalStake = Number(result.totalStake || 0);
    return settle.run(
      correct ? 1 : 0,
      simulatedReturn,
      Number((simulatedReturn - totalStake).toFixed(3)),
      JSON.stringify(result.actualResults || []),
      result.settledAt,
      id,
    );
  }

  function updateProgress(id, actualResults) {
    const payload = JSON.stringify(actualResults || []);
    const result = updateActualResults.run(payload, id, payload);
    return Number(result.changes || 0) > 0;
  }

  function transaction(callback) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function summary(options = {}) {
    const all = allRows.all();
    const scopedRows = policyRows(all, options);
    const rows = options.applyFiltersToSummary
      ? filterRows(scopedRows, options)
      : scopedRows;
    const filteredRows = filterRows(rows, options);
    const pageSize = Math.max(1, Math.min(100, Math.trunc(Number(options.pageSize) || 20)));
    const totalItems = filteredRows.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const page = Math.max(1, Math.min(totalPages, Math.trunc(Number(options.page) || 1)));
    const visibleRows = filteredRows.slice((page - 1) * pageSize, page * pageSize);
    return {
      recordContext: {
        all: all.length,
        selectedPolicy: scopedRows.length,
        unknown: policyRows(all, { ...options, policyVersion: "unknown" }).length,
      },
      totals: metrics(rows),
      byMode: Object.fromEntries(
        ["standard", "goalsPair"].map((mode) => [
          mode,
          metrics(rows.filter((row) => row.mode === mode)),
        ]),
      ),
      bySource: Object.fromEntries(
        ["system_default", "user_saved"].map((source) => [
          source,
          metrics(rows.filter((row) => row.selection_source === source)),
        ]),
      ),
      performanceEvents: performanceEvents(rows),
      filtered: {
        ...metrics(filteredRows),
        byMode: Object.fromEntries(
          ["standard", "goalsPair"].map((mode) => [
            mode,
            metrics(filteredRows.filter((row) => row.mode === mode)),
          ]),
        ),
      },
      rows: visibleRows.map(publicRow),
      page: { page, pageSize, totalItems, totalPages },
      filters: {
        policyVersions: [...new Set(all.map((row) => row.policy_version))],
      },
    };
  }

  return {
    record,
    findRecorded(snapshot) {
      const row = byFingerprint.get(fingerprintFor(snapshot));
      return row ? { id: Number(row.id), status: row.status, capturedAt: row.captured_at } : null;
    },
    pending: () => pending.all(),
    incompleteSettled: () => incompleteSettled.all(),
    updateProgress,
    settle: settleRow,
    transaction,
    summary,
    close: () => db.close(),
  };
}
