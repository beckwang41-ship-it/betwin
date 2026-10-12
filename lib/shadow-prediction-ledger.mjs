import { DatabaseSync } from "node:sqlite";
import {
  blockBootstrapComparison,
  classificationDelta,
} from "./significance.mjs";
import {
  blockBootstrapStrategyComparison,
  pairedStrategyCase,
  summarizeStrategy,
  strategyOutcome,
} from "./strategy-evaluation.mjs";
import { SPF_SHADOW_MODEL_VERSION } from "./three-way-shadow.mjs";

const LABELS = ["胜", "平", "负"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shadow_model_state (
  model_version TEXT PRIMARY KEY,
  activated_at TEXT NOT NULL,
  initial_match_ids_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shadow_spf_predictions (
  id INTEGER PRIMARY KEY,
  match_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source_updated_at TEXT,
  history_source_file TEXT NOT NULL,
  history_row_watermark INTEGER NOT NULL,
  league TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  display_name TEXT NOT NULL,
  odds_json TEXT NOT NULL,
  baseline_available INTEGER NOT NULL CHECK (baseline_available IN (0, 1)),
  baseline_matching_mode TEXT NOT NULL,
  baseline_samples INTEGER NOT NULL,
  baseline_probabilities_json TEXT NOT NULL,
  baseline_top_labels_json TEXT NOT NULL,
  candidate_available INTEGER NOT NULL CHECK (candidate_available IN (0, 1)),
  candidate_matching_mode TEXT NOT NULL,
  candidate_samples INTEGER NOT NULL,
  candidate_probabilities_json TEXT NOT NULL,
  candidate_top_labels_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled')),
  actual_result TEXT CHECK (actual_result IN ('胜', '平', '负') OR actual_result IS NULL),
  score TEXT,
  settled_source_file TEXT,
  settled_source_row INTEGER,
  settled_at TEXT,
  UNIQUE (match_id, model_version)
);
CREATE INDEX IF NOT EXISTS idx_shadow_spf_status
  ON shadow_spf_predictions (status, captured_at);
`;

function parseJson(value, fallback = []) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function modelView(row, side) {
  return {
    available: Boolean(row[`${side}_available`]),
    samples: Number(row[`${side}_samples`] || 0),
    probabilities: parseJson(row[`${side}_probabilities_json`]),
    topLabels: parseJson(row[`${side}_top_labels_json`]).map(String),
  };
}

function emptyMetrics(targets) {
  return {
    targets,
    evaluated: 0,
    correct: 0,
    logLoss: 0,
    brier: 0,
    samples: 0,
    strategyCases: [],
  };
}

function addModelMetrics(metrics, row, model, actualIndex) {
  if (
    !model.available ||
    model.probabilities.length !== LABELS.length ||
    model.topLabels.length === 0
  ) {
    return;
  }
  metrics.evaluated += 1;
  metrics.samples += model.samples;
  metrics.correct += model.topLabels.includes(LABELS[actualIndex])
    ? 1 / model.topLabels.length
    : 0;
  metrics.logLoss -= Math.log(
    Math.max(1e-12, Number(model.probabilities[actualIndex])),
  );
  metrics.brier += model.probabilities.reduce((sum, probability, index) => {
    const actual = index === actualIndex ? 1 : 0;
    return sum + (Number(probability) - actual) ** 2;
  }, 0);
  metrics.strategyCases.push({
    sourceFile: row.settled_source_file || "unknown",
    order: Number(row.settled_source_row || 0),
    candidate: strategyOutcome(
      model.probabilities,
      parseJson(row.odds_json),
      actualIndex,
    ),
  });
}

function summarizeModel(metrics) {
  const strategy = summarizeStrategy(metrics.strategyCases, "candidate");
  return {
    targets: metrics.targets,
    evaluated: metrics.evaluated,
    coverage: metrics.targets ? metrics.evaluated / metrics.targets : 0,
    accuracy: metrics.evaluated ? metrics.correct / metrics.evaluated : null,
    logLoss: metrics.evaluated ? metrics.logLoss / metrics.evaluated : null,
    brier: metrics.evaluated ? metrics.brier / metrics.evaluated : null,
    meanSamples: metrics.evaluated ? metrics.samples / metrics.evaluated : null,
    strategy,
  };
}

export function summarizeShadowSpfRows(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const settled = safeRows.filter(
    (row) => row.status === "settled" && LABELS.includes(row.actual_result),
  );
  const baselineMetrics = emptyMetrics(settled.length);
  const candidateMetrics = emptyMetrics(settled.length);
  const probabilityCases = [];
  const strategyCases = [];
  for (const row of settled) {
    const actualIndex = LABELS.indexOf(row.actual_result);
    const baseline = modelView(row, "baseline");
    const candidate = modelView(row, "candidate");
    addModelMetrics(baselineMetrics, row, baseline, actualIndex);
    addModelMetrics(candidateMetrics, row, candidate, actualIndex);
    if (!baseline.available || !candidate.available) continue;
    if (
      baseline.probabilities.length !== LABELS.length ||
      candidate.probabilities.length !== LABELS.length
    ) {
      continue;
    }
    const meta = {
      sourceFile: row.settled_source_file || "unknown",
      order: Number(row.settled_source_row || 0),
    };
    probabilityCases.push(
      classificationDelta(
        candidate.probabilities,
        baseline.probabilities,
        actualIndex,
        meta,
      ),
    );
    strategyCases.push(
      pairedStrategyCase(
        candidate.probabilities,
        baseline.probabilities,
        parseJson(row.odds_json),
        actualIndex,
        meta,
      ),
    );
  }
  const probabilityComparison = blockBootstrapComparison(probabilityCases);
  const roiComparison = blockBootstrapStrategyComparison(strategyCases);
  return {
    generatedAt: new Date().toISOString(),
    reportOnly: true,
    affectsProduction: false,
    modelVersion:
      safeRows[0]?.model_version || SPF_SHADOW_MODEL_VERSION,
    totals: {
      snapshots: safeRows.length,
      pending: safeRows.filter((row) => row.status === "pending").length,
      settled: settled.length,
      commonEvaluated: probabilityCases.length,
      firstCapturedAt:
        safeRows.map((row) => row.captured_at).sort()[0] || null,
      lastCapturedAt:
        safeRows.map((row) => row.captured_at).sort().at(-1) || null,
    },
    baseline: summarizeModel(baselineMetrics),
    candidate: summarizeModel(candidateMetrics),
    probabilityComparison,
    roiComparison,
    reviewGate: {
      minimumSettled: 200,
      enoughFreshSamples: settled.length >= 200,
      probabilityPassed: probabilityComparison.passed,
      roiPassed: roiComparison.passed && roiComparison.positiveEdge,
      eligibleForManualReview:
        settled.length >= 200 &&
        probabilityComparison.passed &&
        roiComparison.passed &&
        roiComparison.positiveEdge,
      productionChanged: false,
    },
  };
}

export function createShadowPredictionLedger(
  databasePath,
  { initialMatchIds = [], activatedAt = new Date().toISOString() } = {},
) {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  const initialIds = [...new Set(initialMatchIds.map(String))].sort();
  db.prepare(`
    INSERT OR IGNORE INTO shadow_model_state (
      model_version, activated_at, initial_match_ids_json
    ) VALUES (?, ?, ?)
  `).run(
    SPF_SHADOW_MODEL_VERSION,
    activatedAt,
    JSON.stringify(initialIds),
  );
  const state = db.prepare(`
    SELECT * FROM shadow_model_state WHERE model_version = ?
  `).get(SPF_SHADOW_MODEL_VERSION);
  const excludedInitialMatches = new Set(
    parseJson(state?.initial_match_ids_json, []).map(String),
  );
  const existing = db.prepare(`
    SELECT * FROM shadow_spf_predictions
    WHERE match_id = ? AND model_version = ?
  `);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO shadow_spf_predictions (
      match_id, model_version, captured_at, source_updated_at,
      history_source_file, history_row_watermark,
      league, home_team, away_team, display_name, odds_json,
      baseline_available, baseline_matching_mode, baseline_samples,
      baseline_probabilities_json, baseline_top_labels_json,
      candidate_available, candidate_matching_mode, candidate_samples,
      candidate_probabilities_json, candidate_top_labels_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE shadow_spf_predictions
    SET captured_at = ?, source_updated_at = ?,
        league = ?, home_team = ?, away_team = ?, display_name = ?,
        odds_json = ?,
        baseline_available = ?, baseline_matching_mode = ?, baseline_samples = ?,
        baseline_probabilities_json = ?, baseline_top_labels_json = ?,
        candidate_available = ?, candidate_matching_mode = ?, candidate_samples = ?,
        candidate_probabilities_json = ?, candidate_top_labels_json = ?
    WHERE id = ? AND status = 'pending'
  `);
  const pending = db.prepare(`
    SELECT * FROM shadow_spf_predictions
    WHERE status = 'pending'
    ORDER BY captured_at, id
  `);
  const byId = db.prepare(
    "SELECT * FROM shadow_spf_predictions WHERE id = ?",
  );
  const settle = db.prepare(`
    UPDATE shadow_spf_predictions
    SET status = 'settled', actual_result = ?, score = ?,
        settled_source_file = ?, settled_source_row = ?, settled_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const allRows = db.prepare(`
    SELECT * FROM shadow_spf_predictions
    ORDER BY captured_at, id
  `);

  function serialized(snapshot) {
    return {
      odds: JSON.stringify(snapshot.odds || []),
      baselineProbabilities: JSON.stringify(
        snapshot.baseline?.probabilities || [],
      ),
      baselineTopLabels: JSON.stringify(snapshot.baseline?.topLabels || []),
      candidateProbabilities: JSON.stringify(
        snapshot.candidate?.probabilities || [],
      ),
      candidateTopLabels: JSON.stringify(snapshot.candidate?.topLabels || []),
    };
  }

  function record(snapshot) {
    if (excludedInitialMatches.has(String(snapshot.matchId))) return false;
    const json = serialized(snapshot);
    const current = existing.get(snapshot.matchId, snapshot.modelVersion);
    const values = [
      snapshot.capturedAt,
      snapshot.sourceUpdatedAt || null,
      snapshot.league,
      snapshot.home,
      snapshot.away,
      snapshot.displayName,
      json.odds,
      snapshot.baseline?.available ? 1 : 0,
      snapshot.baseline?.matchingMode || "unavailable",
      Number(snapshot.baseline?.samples || 0),
      json.baselineProbabilities,
      json.baselineTopLabels,
      snapshot.candidate?.available ? 1 : 0,
      snapshot.candidate?.matchingMode || "unavailable",
      Number(snapshot.candidate?.samples || 0),
      json.candidateProbabilities,
      json.candidateTopLabels,
    ];
    if (current) {
      if (current.status !== "pending") return false;
      const changed =
        current.source_updated_at !== (snapshot.sourceUpdatedAt || null) ||
        current.league !== snapshot.league ||
        current.home_team !== snapshot.home ||
        current.away_team !== snapshot.away ||
        current.display_name !== snapshot.displayName ||
        current.odds_json !== json.odds ||
        Boolean(current.baseline_available) !==
          Boolean(snapshot.baseline?.available) ||
        current.baseline_matching_mode !==
          (snapshot.baseline?.matchingMode || "unavailable") ||
        Number(current.baseline_samples) !==
          Number(snapshot.baseline?.samples || 0) ||
        current.baseline_probabilities_json !== json.baselineProbabilities ||
        current.baseline_top_labels_json !== json.baselineTopLabels ||
        Boolean(current.candidate_available) !==
          Boolean(snapshot.candidate?.available) ||
        current.candidate_matching_mode !==
          (snapshot.candidate?.matchingMode || "unavailable") ||
        Number(current.candidate_samples) !==
          Number(snapshot.candidate?.samples || 0) ||
        current.candidate_probabilities_json !== json.candidateProbabilities ||
        current.candidate_top_labels_json !== json.candidateTopLabels;
      if (!changed) return false;
      const result = update.run(...values, current.id);
      return Number(result.changes || 0) > 0;
    }
    const result = insert.run(
      snapshot.matchId,
      snapshot.modelVersion,
      ...values.slice(0, 2),
      snapshot.historySourceFile,
      snapshot.historyRowWatermark,
      ...values.slice(2),
    );
    return Number(result.changes || 0) > 0;
  }

  function settleRow(id, result) {
    const row = byId.get(id);
    if (!row || row.status !== "pending") return { changes: 0 };
    return settle.run(
      result.actualResult,
      result.score || null,
      result.sourceFile,
      result.sourceRow,
      result.settledAt,
      id,
    );
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

  return {
    record,
    pending: () => pending.all(),
    settle: settleRow,
    transaction,
    summary: () => ({
      ...summarizeShadowSpfRows(allRows.all()),
      activation: {
        activatedAt: state?.activated_at || null,
        initialMatchesExcluded: excludedInitialMatches.size,
        backfillExistingMatches: false,
      },
    }),
    close: () => db.close(),
  };
}
