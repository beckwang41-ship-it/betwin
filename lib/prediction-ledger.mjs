import { DatabaseSync } from "node:sqlite";
import {
  GOAL_LABELS,
  selectTopGoalPair,
} from "./predictor.mjs";
import { blockBootstrapFixtureMean } from "./significance.mjs";
import { ledgerCalendarDate } from "../public/ledger-date.js";

const LEDGER_TABLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS prediction_ledger (
  id INTEGER PRIMARY KEY,
  match_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  market TEXT NOT NULL CHECK (
    market IN ('spf', 'hhad', 'goals', 'goalMultiple')
  ),
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
  algorithm_version TEXT,
  data_version TEXT,
  validation_status TEXT,
  selection_count INTEGER,
  stake_units REAL,
  settlement_rule TEXT,
  UNIQUE (match_id, market, policy_version)
);
`;

const LEDGER_INDEX_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_prediction_ledger_status
  ON prediction_ledger (status, captured_at);
CREATE INDEX IF NOT EXISTS idx_prediction_ledger_grade
  ON prediction_ledger (reliability_level, market, status);
`;

const LEDGER_SCHEMA = `${LEDGER_TABLE_SCHEMA}\n${LEDGER_INDEX_SCHEMA}`;

function migrateGoalMultipleMarket(db) {
  const table = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'prediction_ledger'",
    )
    .get();
  if (!table?.sql || table.sql.includes("'goalMultiple'")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE prediction_ledger RENAME TO prediction_ledger_legacy");
    db.exec(LEDGER_TABLE_SCHEMA);
    db.exec(`
      INSERT INTO prediction_ledger
      SELECT * FROM prediction_ledger_legacy
    `);
    db.exec("DROP TABLE prediction_ledger_legacy");
    db.exec(LEDGER_INDEX_SCHEMA);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const SETTLEMENT_RULE_VERSION = "selection-cost-v2";
const MARKET_LABELS = {
  spf: ["胜", "平", "负"],
  hhad: ["胜", "平", "负"],
  goals: GOAL_LABELS,
};

function selectionAccounting(row, actualResult = row.actual_result) {
  const selected = [...new Set(parseJson(row.top_labels_json, []).map(String))];
  const marketLabels = MARKET_LABELS[row.market] || [];
  const selectionCount = selected.length;
  const noPrediction =
    marketLabels.length > 0 && selectionCount >= marketLabels.length;
  const metricsOnly = row.market === "goalMultiple";
  const settled = row.status === "settled" && actualResult !== null;
  const covered = settled ? selected.includes(String(actualResult)) : null;
  const stakeUnits = metricsOnly || noPrediction ? 0 : selectionCount;
  const odds = parseJson(row.odds_json, []).map(Number);
  const actualIndex = marketLabels.indexOf(String(actualResult));
  const winningOdds = actualIndex >= 0 ? Number(odds[actualIndex]) : null;
  const simulatedReturn =
    !settled || metricsOnly || noPrediction
      ? null
      : covered && Number.isFinite(winningOdds)
        ? winningOdds
        : 0;
  return {
    selected,
    selectionCount,
    strictSingle: !metricsOnly && !noPrediction && selectionCount === 1,
    multiSelection: !metricsOnly && !noPrediction && selectionCount > 1,
    noPrediction,
    metricsOnly,
    covered,
    stakeUnits,
    simulatedReturn,
    simulatedProfit:
      simulatedReturn === null ? null : simulatedReturn - stakeUnits,
    settlementRule: metricsOnly
      ? "metrics-only"
      : noPrediction
        ? "no-prediction-full-cover"
        : SETTLEMENT_RULE_VERSION,
  };
}

function strictSingleRow(row) {
  return selectionAccounting(row).strictSingle;
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

function goalMultipleForRow(row) {
  if (row.market !== "goalMultiple") return null;
  const settings = parseJson(row.settings_json, {});
  return {
    available: true,
    labels: parseJson(row.top_labels_json, []),
    counts: Array.isArray(settings.goalMultipleCounts)
      ? settings.goalMultipleCounts.map(Number)
      : [],
    probabilities: Array.isArray(settings.goalMultipleProbabilities)
      ? settings.goalMultipleProbabilities.map(Number)
      : [],
    coverageProbability: Number(settings.goalMultipleCoverage || 0),
    zeroOdds: Number(settings.goalMultipleZeroOdds || row.selected_odds),
    relations: Array.isArray(settings.goalMultipleRelations)
      ? settings.goalMultipleRelations
      : [],
    source: settings.goalMultipleSource || null,
    correct:
      row.status === "settled" && row.correct !== null
        ? Boolean(row.correct)
        : null,
  };
}

function publicRow(row) {
  const settings = parseJson(row.settings_json, {});
  const sameLeague = Boolean(settings.sameLeague);
  const accounting = selectionAccounting(row);
  return {
    id: row.id,
    matchId: row.match_id,
    policyVersion: row.policy_version,
    algorithmVersion: row.algorithm_version || null,
    dataVersion: row.data_version || row.source_updated_at || null,
    validationStatus: row.validation_status || null,
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
    selectionCount: accounting.selectionCount,
    stakeUnits: accounting.stakeUnits,
    strictSingle: accounting.strictSingle,
    multiSelection: accounting.multiSelection,
    noPrediction: accounting.noPrediction,
    settlementRule: row.settlement_rule || accounting.settlementRule,
    simulatedReturn: accounting.simulatedReturn,
    simulatedProfit: accounting.simulatedProfit,
    settledAt: row.settled_at,
    goalPair: goalPairForRow(row),
    goalMultiple: goalMultipleForRow(row),
  };
}

function rowUsesSameLeague(row) {
  return Boolean(parseJson(row.settings_json, {}).sameLeague);
}

function roundedMetric(value) {
  return Number(Number(value).toFixed(4));
}

function accuracyEvidence(correct, settled) {
  if (!settled) {
    return {
      accuracyLow: null,
      accuracyHigh: null,
      sampleLevel: "empty",
    };
  }
  const z = 1.96;
  const proportion = correct / settled;
  const denominator = 1 + (z ** 2) / settled;
  const centre = proportion + (z ** 2) / (2 * settled);
  const margin =
    z *
    Math.sqrt(
      (proportion * (1 - proportion)) / settled +
        (z ** 2) / (4 * settled ** 2),
    );
  return {
    accuracyLow: roundedMetric(Math.max(0, (centre - margin) / denominator)),
    accuracyHigh: roundedMetric(Math.min(1, (centre + margin) / denominator)),
    sampleLevel:
      settled < 20 ? "insufficient" : settled < 50 ? "preliminary" : "reference",
  };
}

function sampleLevelForCount(count) {
  const total = Math.max(0, Number(count) || 0);
  return total < 20 ? (total ? "insufficient" : "empty") : total < 50 ? "preliminary" : "reference";
}

function groupMetrics(rows) {
  const coreRows = rows.filter((row) => row.market !== "goalMultiple");
  const strictSettled = coreRows.filter(
    (row) =>
      row.status === "settled" &&
      row.correct !== null &&
      strictSingleRow(row),
  );
  const correct = strictSettled.filter((row) => row.correct === 1).length;
  const multiSettled = coreRows.filter((row) => {
    const accounting = selectionAccounting(row);
    return row.status === "settled" && accounting.multiSelection;
  });
  const multiCorrect = multiSettled.filter((row) => row.correct === 1).length;
  const noPrediction = coreRows.filter(
    (row) => row.status === "settled" && selectionAccounting(row).noPrediction,
  ).length;
  const wagered = coreRows.filter((row) => {
    const accounting = selectionAccounting(row);
    return row.status === "settled" && accounting.stakeUnits > 0;
  });
  const profit = wagered.reduce(
    (sum, row) => sum + Number(selectionAccounting(row).simulatedProfit || 0),
    0,
  );
  const stakeUnits = wagered.reduce(
    (sum, row) => sum + selectionAccounting(row).stakeUnits,
    0,
  );
  return {
    total: rows.length,
    pending: rows.filter((row) => row.status === "pending").length,
    recordedSettled: rows.filter((row) => row.status === "settled").length,
    settled: strictSettled.length,
    correct,
    accuracy: strictSettled.length ? correct / strictSettled.length : null,
    multiSelection: {
      settled: multiSettled.length,
      correct: multiCorrect,
      coverageAccuracy: multiSettled.length
        ? multiCorrect / multiSettled.length
        : null,
    },
    noPrediction,
    simulatedProfit: profit,
    roi: stakeUnits ? profit / stakeUnits : null,
    stakeUnits,
    ...accuracyEvidence(correct, strictSettled.length),
  };
}

function performanceEvents(rows) {
  return rows.flatMap((row) => {
    const accounting = selectionAccounting(row);
    if (
      row.status !== "settled" ||
      accounting.stakeUnits <= 0 ||
      accounting.simulatedProfit === null
    ) {
      return [];
    }
    return [{
      id: `single:${row.id}`,
      type: "single",
      market: row.market,
      scope: rowUsesSameLeague(row) ? "sameLeague" : "all",
      capturedAt: row.captured_at,
      settledAt: row.settled_at,
      correct: Boolean(accounting.covered),
      stakeUnits: accounting.stakeUnits,
      simulatedProfit: accounting.simulatedProfit,
    }];
  });
}

function goalMultipleMetrics(rows) {
  const goalMultipleRows = rows.filter((row) => row.market === "goalMultiple");
  const settled = goalMultipleRows.filter(
    (row) => row.status === "settled" && row.correct !== null,
  );
  const correct = settled.filter((row) => row.correct === 1).length;
  return {
    total: goalMultipleRows.length,
    pending: goalMultipleRows.filter((row) => row.status === "pending").length,
    recordedSettled: settled.length,
    settled: settled.length,
    correct,
    accuracy: settled.length ? correct / settled.length : null,
    simulatedProfit: 0,
    roi: null,
    stakeUnits: 0,
    ...accuracyEvidence(correct, settled.length),
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
    ...accuracyEvidence(correct, settled.length),
  };
}

function calibrationMetrics(rows) {
  const definitions = [
    { label: "低于40%", from: 0, to: 0.4 },
    { label: "40%–50%", from: 0.4, to: 0.5 },
    { label: "50%–60%", from: 0.5, to: 0.6 },
    { label: "60%以上", from: 0.6, to: 1.0000001 },
  ];
  const eligible = rows.filter(
    (row) =>
      ["spf", "hhad", "goals"].includes(row.market) &&
      row.status === "settled" &&
      row.correct !== null &&
      strictSingleRow(row) &&
      Number.isFinite(Number(row.selected_probability)),
  );
  const bins = definitions.map((definition) => {
    const matches = eligible.filter((row) => {
      const probability = Number(row.selected_probability);
      return probability >= definition.from && probability < definition.to;
    });
    const correct = matches.filter((row) => row.correct === 1).length;
    const predictedAverage = matches.length
      ? matches.reduce(
          (sum, row) => sum + Number(row.selected_probability),
          0,
        ) / matches.length
      : null;
    const actualAccuracy = matches.length ? correct / matches.length : null;
    return {
      ...definition,
      settled: matches.length,
      correct,
      predictedAverage:
        predictedAverage === null ? null : roundedMetric(predictedAverage),
      actualAccuracy:
        actualAccuracy === null ? null : roundedMetric(actualAccuracy),
      gap:
        actualAccuracy === null
          ? null
          : roundedMetric(actualAccuracy - predictedAverage),
      ...accuracyEvidence(correct, matches.length),
    };
  });
  return {
    settled: eligible.length,
    bins,
  };
}

function marketMetrics(rows, market) {
  return market === "goalsPair"
    ? goalPairMetrics(rows)
    : market === "goalMultiple"
      ? goalMultipleMetrics(rows)
    : groupMetrics(rows.filter((row) => row.market === market));
}

const MARKET_OUTCOME_LABELS = MARKET_LABELS;

function sameLabels(left, right) {
  const leftLabels = [...new Set(left.map(String))].sort();
  const rightLabels = [...new Set(right.map(String))].sort();
  return (
    leftLabels.length === rightLabels.length &&
    leftLabels.every((label, index) => label === rightLabels[index])
  );
}

function oddsBenchmarkEntry(row) {
  const labels = MARKET_OUTCOME_LABELS[row.market];
  const odds = parseJson(row.odds_json, []).map(Number);
  if (
    !labels ||
    odds.length !== labels.length ||
    odds.some((odd) => !Number.isFinite(odd) || odd <= 0) ||
    row.status !== "settled" ||
    row.correct === null ||
    !strictSingleRow(row)
  ) {
    return null;
  }
  const shortest = Math.min(...odds);
  const oddsLabels = labels.filter(
    (_, index) => Math.abs(odds[index] - shortest) <= 1e-9,
  );
  const modelLabels = parseJson(row.top_labels_json, []).map(String);
  const actual = String(row.actual_result);
  return {
    market: row.market,
    scope: rowUsesSameLeague(row) ? "sameLeague" : "all",
    fixtureId: String(row.match_id),
    sourceFile: row.settled_source_file || row.history_source_file || "unknown",
    order:
      Number(row.settled_source_row) || Date.parse(row.captured_at || "") ||
      Number(row.id || 0),
    modelCorrect: modelLabels.includes(actual),
    oddsCorrect: oddsLabels.includes(actual),
    directionsAgree: sameLabels(modelLabels, oddsLabels),
  };
}

function pairedLiftEvidence(entries) {
  const compared = entries.length;
  if (!compared) {
    return {
      lift: null,
      liftLow: null,
      liftHigh: null,
      liftStatus: "empty",
      liftMethod: "fixture-chronological-block-bootstrap",
      liftIterations: 0,
      liftBlockSize: 20,
      liftImprovementProbability: null,
    };
  }
  const bootstrap = blockBootstrapFixtureMean(
    entries.map((entry) => ({
      sourceFile: entry.sourceFile,
      fixtureId: entry.fixtureId,
      market: entry.market,
      order: entry.order,
      value: Number(entry.modelCorrect) - Number(entry.oddsCorrect),
    })),
  );
  const lift = bootstrap.mean;
  const low = bootstrap.lower;
  const high = bootstrap.upper;
  return {
    lift: roundedMetric(lift),
    liftLow: roundedMetric(low),
    liftHigh: roundedMetric(high),
    liftMethod: "fixture-chronological-block-bootstrap",
    liftIterations: bootstrap.iterations,
    liftBlockSize: bootstrap.blockSize,
    liftImprovementProbability: roundedMetric(
      bootstrap.improvementProbability,
    ),
    liftStatus:
      bootstrap.fixtures < 20
        ? "insufficient"
        : bootstrap.status,
  };
}

function benchmarkSummary(entries) {
  const compared = entries.length;
  const modelCorrect = entries.filter((entry) => entry.modelCorrect).length;
  const oddsCorrect = entries.filter((entry) => entry.oddsCorrect).length;
  const disagreements = entries.filter((entry) => !entry.directionsAgree);
  const disagreementModelCorrect = disagreements.filter(
    (entry) => entry.modelCorrect,
  ).length;
  const disagreementOddsCorrect = disagreements.filter(
    (entry) => entry.oddsCorrect,
  ).length;
  return {
    compared,
    fixtures: new Set(entries.map(entry => entry.fixtureId)).size,
    modelCorrect,
    oddsCorrect,
    modelAccuracy: compared ? roundedMetric(modelCorrect / compared) : null,
    oddsAccuracy: compared ? roundedMetric(oddsCorrect / compared) : null,
    directionsAgree: entries.filter((entry) => entry.directionsAgree).length,
    directionsDiffer: disagreements.length,
    disagreementModelCorrect,
    disagreementOddsCorrect,
    netWins: modelCorrect - oddsCorrect,
    disagreementNetWins:
      disagreementModelCorrect - disagreementOddsCorrect,
    ...pairedLiftEvidence(entries),
  };
}

function oddsBenchmarkMetrics(rows) {
  const entries = rows.map(oddsBenchmarkEntry).filter(Boolean);
  const byMarketScope = Object.fromEntries(
    Object.keys(MARKET_OUTCOME_LABELS).map((market) => [
      market,
      {
        all: benchmarkSummary(
          entries.filter(
            (entry) => entry.market === market && entry.scope === "all",
          ),
        ),
        sameLeague: benchmarkSummary(
          entries.filter(
            (entry) =>
              entry.market === market && entry.scope === "sameLeague",
          ),
        ),
      },
    ]),
  );
  return {
    overall: benchmarkSummary(entries),
    byMarketScope,
  };
}

const DIAGNOSTIC_ODDS_BANDS = [
  { label: "1.75及以下", from: 0, to: 1.7500001 },
  { label: "1.76–2.25", from: 1.7500001, to: 2.2500001 },
  { label: "2.26–3.00", from: 2.2500001, to: 3.0000001 },
  { label: "3.01以上", from: 3.0000001, to: Infinity },
];

function diagnosisSummary(rows) {
  const settled = rows.length;
  const correct = rows.filter((row) => Boolean(row.correct)).length;
  const misses = settled - correct;
  return {
    settled,
    correct,
    misses,
    accuracy: settled ? roundedMetric(correct / settled) : null,
    missRate: settled ? roundedMetric(misses / settled) : null,
    ...accuracyEvidence(correct, settled),
  };
}

function shortestOddsLabels(labels, odds) {
  const values = Array.isArray(odds) ? odds.map(Number) : [];
  if (
    !Array.isArray(labels) ||
    values.length !== labels.length ||
    values.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    return null;
  }
  const shortest = Math.min(...values);
  return labels.filter(
    (_, index) => Math.abs(values[index] - shortest) <= 1e-9,
  );
}

function confusionMarketMetrics(rows, market) {
  const labels = MARKET_OUTCOME_LABELS[market] || [];
  const matrix = labels.map(() => labels.map(() => 0));
  const eligible = rows.filter(
    (row) =>
      row.market === market &&
      row.status === "settled" &&
      labels.includes(String(row.actual_result)),
  );
  let ambiguous = 0;
  const entries = [];
  for (const row of eligible) {
    const predictedLabels = parseJson(row.top_labels_json, []).map(String);
    if (predictedLabels.length !== 1 || !labels.includes(predictedLabels[0])) {
      ambiguous += 1;
      continue;
    }
    const predicted = predictedLabels[0];
    const actual = String(row.actual_result);
    const predictedIndex = labels.indexOf(predicted);
    const actualIndex = labels.indexOf(actual);
    matrix[predictedIndex][actualIndex] += 1;
    entries.push({ predicted, actual, predictedIndex, actualIndex });
  }
  const errorCounts = new Map();
  for (const entry of entries.filter(({ predicted, actual }) => predicted !== actual)) {
    const key = `${entry.predicted}\u0000${entry.actual}`;
    errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
  }
  const topErrors = [...errorCounts.entries()]
    .map(([key, count]) => {
      const [predicted, actual] = key.split("\u0000");
      return { predicted, actual, count };
    })
    .sort(
      (left, right) =>
        right.count - left.count ||
        labels.indexOf(left.predicted) - labels.indexOf(right.predicted) ||
        labels.indexOf(left.actual) - labels.indexOf(right.actual),
    )
    .slice(0, 6);
  const correct = entries.filter(
    ({ predicted, actual }) => predicted === actual,
  ).length;
  const differences = entries.map(
    ({ predictedIndex, actualIndex }) => actualIndex - predictedIndex,
  );
  return {
    labels,
    settled: eligible.length,
    singlePredictions: entries.length,
    ambiguous,
    correct,
    accuracy: entries.length ? roundedMetric(correct / entries.length) : null,
    matrix,
    maxCell: Math.max(0, ...matrix.flat()),
    topErrors,
    bias:
      market === "goals"
        ? {
            predictedLow: differences.filter((difference) => difference > 0).length,
            exact: differences.filter((difference) => difference === 0).length,
            predictedHigh: differences.filter((difference) => difference < 0).length,
            offByOne: differences.filter(
              (difference) => Math.abs(difference) === 1,
            ).length,
            far: differences.filter((difference) => Math.abs(difference) >= 2)
              .length,
          }
        : null,
    ...accuracyEvidence(correct, entries.length),
  };
}

function errorDiagnosisMetrics(rows) {
  const eligible = rows.filter(
    (row) =>
      MARKET_OUTCOME_LABELS[row.market] &&
      row.status === "settled" &&
      row.correct !== null &&
      strictSingleRow(row),
  );
  const normalized = eligible.map((row) => ({
    row,
    correct: row.correct === 1,
  }));
  const byMarket = Object.fromEntries(
    Object.keys(MARKET_OUTCOME_LABELS).map((market) => [
      market,
      diagnosisSummary(
        normalized.filter(({ row }) => row.market === market),
      ),
    ]),
  );
  const byOddsBand = DIAGNOSTIC_ODDS_BANDS.map((band) => ({
    ...band,
    ...diagnosisSummary(
      normalized.filter(({ row }) => {
        const odds = Number(row.selected_odds);
        return Number.isFinite(odds) && odds >= band.from && odds < band.to;
      }),
    ),
  }));

  const leagueGroups = new Map();
  for (const entry of normalized) {
    const league = String(entry.row.league || "联赛未知");
    if (!leagueGroups.has(league)) leagueGroups.set(league, []);
    leagueGroups.get(league).push(entry);
  }
  const byLeague = [...leagueGroups.entries()]
    .map(([label, entries]) => ({ label, ...diagnosisSummary(entries) }))
    .sort(
      (left, right) =>
        right.misses - left.misses ||
        Number(right.missRate || 0) - Number(left.missRate || 0) ||
        right.settled - left.settled ||
        left.label.localeCompare(right.label, "zh-CN"),
    )
    .slice(0, 8);

  const benchmarkEntries = eligible
    .map(oddsBenchmarkEntry)
    .filter(Boolean)
    .map((entry) => ({
      correct: entry.modelCorrect,
      directionsAgree: entry.directionsAgree,
    }));
  const movementEntries = [];
  for (const entry of normalized) {
    const labels = MARKET_OUTCOME_LABELS[entry.row.market];
    const settings = parseJson(entry.row.settings_json, {});
    const initialLabels = shortestOddsLabels(
      labels,
      settings.diagnostics?.initialOdds,
    );
    const finalLabels = shortestOddsLabels(
      labels,
      parseJson(entry.row.odds_json, []),
    );
    if (!initialLabels || !finalLabels) continue;
    movementEntries.push({
      correct: entry.correct,
      changed: !sameLabels(initialLabels, finalLabels),
    });
  }

  return {
    overall: diagnosisSummary(normalized),
    byMarket,
    byOddsBand,
    byLeague,
    oddsDirection: {
      available: benchmarkEntries.length,
      unavailable: eligible.length - benchmarkEntries.length,
      same: diagnosisSummary(
        benchmarkEntries.filter((entry) => entry.directionsAgree),
      ),
      different: diagnosisSummary(
        benchmarkEntries.filter((entry) => !entry.directionsAgree),
      ),
    },
    movementDirection: {
      available: movementEntries.length,
      unavailable: eligible.length - movementEntries.length,
      stable: diagnosisSummary(
        movementEntries.filter((entry) => !entry.changed),
      ),
      changed: diagnosisSummary(
        movementEntries.filter((entry) => entry.changed),
      ),
    },
    confusion: Object.fromEntries(
      Object.keys(MARKET_OUTCOME_LABELS).map((market) => [
        market,
        confusionMarketMetrics(rows, market),
      ]),
    ),
  };
}

function scopePolicyFamily(policyVersion) {
  return String(policyVersion || "").replace(
    /:(?:all-leagues|same-league)$/,
    "",
  );
}

function scopePairSummary(pairs) {
  const disagreements = pairs.filter((pair) => !pair.directionsAgree);
  const allCorrect = pairs.filter((pair) => pair.all.correct).length;
  const sameLeagueCorrect = pairs.filter(
    (pair) => pair.sameLeague.correct,
  ).length;
  const disagreementAllCorrect = disagreements.filter(
    (pair) => pair.all.correct,
  ).length;
  const disagreementSameLeagueCorrect = disagreements.filter(
    (pair) => pair.sameLeague.correct,
  ).length;
  return {
    paired: pairs.length,
    directionsAgree: pairs.filter((pair) => pair.directionsAgree).length,
    directionsDiffer: disagreements.length,
    allCorrect,
    sameLeagueCorrect,
    allAccuracy: pairs.length ? roundedMetric(allCorrect / pairs.length) : null,
    sameLeagueAccuracy: pairs.length
      ? roundedMetric(sameLeagueCorrect / pairs.length)
      : null,
    disagreementAllCorrect,
    disagreementSameLeagueCorrect,
    sameLeagueNetWins:
      disagreementSameLeagueCorrect - disagreementAllCorrect,
  };
}

function pairedScopeMetrics(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (
      !MARKET_OUTCOME_LABELS[row.market] ||
      row.status !== "settled" ||
      row.correct === null ||
      !strictSingleRow(row)
    ) {
      continue;
    }
    const key = `${row.match_id}:${row.market}`;
    if (!grouped.has(key)) grouped.set(key, {});
    const scope = rowUsesSameLeague(row) ? "sameLeague" : "all";
    if (!grouped.get(key)[scope]) grouped.get(key)[scope] = row;
  }
  const pairs = [];
  for (const group of grouped.values()) {
    const all = group.all;
    const sameLeague = group.sameLeague;
    if (!all || !sameLeague) continue;
    if (
      Number(all.handicap) !== Number(sameLeague.handicap) ||
      String(all.actual_result) !== String(sameLeague.actual_result) ||
      scopePolicyFamily(all.policy_version) !==
        scopePolicyFamily(sameLeague.policy_version)
    ) {
      continue;
    }
    pairs.push({
      market: all.market,
      all: { correct: all.correct === 1 },
      sameLeague: { correct: sameLeague.correct === 1 },
      directionsAgree: sameLabels(
        parseJson(all.top_labels_json, []),
        parseJson(sameLeague.top_labels_json, []),
      ),
    });
  }
  return {
    overall: scopePairSummary(pairs),
    byMarket: Object.fromEntries(
      Object.keys(MARKET_OUTCOME_LABELS).map((market) => [
        market,
        scopePairSummary(pairs.filter((pair) => pair.market === market)),
      ]),
    ),
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



function rowMatchesCurrentAlgorithm(row, options, currentVersions) {
  // Explicit algorithm identities must never fall through to a family match.
  if (row.algorithm_version) return currentVersions.has(String(row.algorithm_version));
  if (currentVersions.has(String(row.policy_version || ""))) return true;

  return false;
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
  if (mode === "unknown") return rows.filter(row => !row.algorithm_version);
  if (mode === "current" && currentVersions.size) {
    return rows.filter((row) =>
      rowMatchesCurrentAlgorithm(row, options, currentVersions),
    );
  }
  if (mode === "legacy" && currentVersions.size) {
    return rows.filter(
      (row) => !rowMatchesCurrentAlgorithm(row, options, currentVersions),
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
    if (options.market && options.market !== "all" && row.market !== options.market) {
      return false;
    }
    if (options.scope === "global" && rowUsesSameLeague(row)) return false;
    if (options.scope === "same" && !rowUsesSameLeague(row)) return false;
    if (options.league && options.league !== "all" && row.league !== options.league) {
      return false;
    }
    if (options.predicted) {
      const labels = parseJson(row.top_labels_json, []).map(String);
      if (labels.length !== 1 || labels[0] !== String(options.predicted)) {
        return false;
      }
    }
    if (options.actual && String(row.actual_result) !== String(options.actual)) {
      return false;
    }
    const date = ledgerCalendarDate(row.captured_at);
    if (from && date < from) return false;
    if (to && date > to) return false;
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
  if (!columns.has("algorithm_version")) {
    db.exec("ALTER TABLE prediction_ledger ADD COLUMN algorithm_version TEXT");
  }
  if (!columns.has("data_version")) {
    db.exec("ALTER TABLE prediction_ledger ADD COLUMN data_version TEXT");
  }
  if (!columns.has("validation_status")) {
    db.exec("ALTER TABLE prediction_ledger ADD COLUMN validation_status TEXT");
  }
  if (!columns.has("selection_count")) {
    db.exec("ALTER TABLE prediction_ledger ADD COLUMN selection_count INTEGER");
  }
  if (!columns.has("stake_units")) {
    db.exec("ALTER TABLE prediction_ledger ADD COLUMN stake_units REAL");
  }
  if (!columns.has("settlement_rule")) {
    db.exec("ALTER TABLE prediction_ledger ADD COLUMN settlement_rule TEXT");
  }
  migrateGoalMultipleMarket(db);
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
      settings_json, algorithm_version, data_version, validation_status
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
        selection_count = ?,
        stake_units = ?,
        settlement_rule = ?,
        settled_source_file = ?,
        settled_source_row = ?,
        settled_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const byId = db.prepare(`
    SELECT * FROM prediction_ledger WHERE id = ? AND valid = 1
  `);
  const settledForAccounting = db.prepare(`
    SELECT * FROM prediction_ledger
    WHERE status = 'settled' AND valid = 1
      AND COALESCE(settlement_rule, '') NOT IN (?, ?, ?)
  `);
  const updateAccounting = db.prepare(`
    UPDATE prediction_ledger
    SET correct = ?,
        simulated_return = ?,
        simulated_profit = ?,
        selection_count = ?,
        stake_units = ?,
        settlement_rule = ?
    WHERE id = ?
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
        algorithm_version = ?,
        data_version = ?,
        validation_status = ?,
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
        existing.algorithm_version !== (snapshot.algorithmVersion || null) ||
        existing.data_version !== (snapshot.dataVersion || null) ||
        existing.validation_status !== (snapshot.validationStatus || null) ||
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
        snapshot.algorithmVersion || null,
        snapshot.dataVersion || snapshot.sourceUpdatedAt || null,
        snapshot.validationStatus || null,
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
      snapshot.algorithmVersion || null,
      snapshot.dataVersion || snapshot.sourceUpdatedAt || null,
      snapshot.validationStatus || null,
    );
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

  function refreshHistoricalAccounting() {
    const legacy = settledForAccounting.all(
      SETTLEMENT_RULE_VERSION,
      "metrics-only",
      "no-prediction-full-cover",
    );
    if (!legacy.length) return 0;
    return transaction(() => {
      let updated = 0;
      for (const row of legacy) {
        const accounting = selectionAccounting(row);
        const correct = accounting.noPrediction
          ? null
          : accounting.covered
            ? 1
            : 0;
        const result = updateAccounting.run(
          correct,
          accounting.simulatedReturn,
          accounting.simulatedProfit,
          accounting.selectionCount,
          accounting.stakeUnits,
          accounting.settlementRule,
          row.id,
        );
        updated += Number(result.changes || 0);
      }
      return updated;
    });
  }

  function settleRow(id, result) {
    const row = byId.get(id);
    if (!row || row.status !== "pending") return { changes: 0 };
    const accounting = selectionAccounting(
      { ...row, status: "settled" },
      result.actualResult,
    );
    const correct = accounting.noPrediction
      ? null
      : accounting.covered
        ? 1
        : 0;
    return settle.run(
      result.actualResult,
      result.score || null,
      correct,
      accounting.simulatedReturn,
      accounting.simulatedProfit,
      accounting.selectionCount,
      accounting.stakeUnits,
      accounting.settlementRule,
      result.sourceFile,
      result.sourceRow,
      result.settledAt,
      id,
    );
  }

  refreshHistoricalAccounting();

  function summary(options = {}) {
    const all = allRows.all();
    const scopedRows = policyRows(all, options);
    const rows = options.applyFiltersToSummary
      ? filterRows(scopedRows, options)
      : scopedRows;
    const fixtures = new Map();
    for (const row of rows) {
      if (!fixtures.has(row.match_id)) fixtures.set(row.match_id, []);
      fixtures.get(row.match_id).push(row);
    }
    const fixtureRows = [...fixtures.values()];
    const coreRows = rows.filter((row) => row.market !== "goalMultiple");
    const coreFixtures = new Map();
    for (const row of coreRows) {
      if (!coreFixtures.has(row.match_id)) coreFixtures.set(row.match_id, []);
      coreFixtures.get(row.match_id).push(row);
    }
    const coreFixtureRows = [...coreFixtures.values()];
    const byReliability = Object.fromEntries(
      ["recommended", "cautious", "skip"].map((level) => [
        level,
        groupMetrics(rows.filter((row) => row.reliability_level === level)),
      ]),
    );
    const markets = ["spf", "hhad", "goals", "goalsPair", "goalMultiple"];
    const byMarket = Object.fromEntries(
      markets.map((market) => [market, marketMetrics(rows, market)]),
    );
    const byScope = {
      all: groupMetrics(rows.filter((row) => !rowUsesSameLeague(row))),
      sameLeague: groupMetrics(rows.filter(rowUsesSameLeague)),
    };
    const coreByScope = {
      all: groupMetrics(coreRows.filter((row) => !rowUsesSameLeague(row))),
      sameLeague: groupMetrics(coreRows.filter(rowUsesSameLeague)),
    };
    const byMarketScope = Object.fromEntries(
      markets.map((market) => [
        market,
        {
          all: marketMetrics(
            rows.filter((row) => !rowUsesSameLeague(row)),
            market,
          ),
          sameLeague: marketMetrics(rows.filter(rowUsesSameLeague), market),
        },
      ]),
    );
    const settled = rows.filter((row) => row.status === "settled").length;
    const coreSettledFixtures = coreFixtureRows.filter((fixture) =>
      fixture.every((row) => row.status === "settled"),
    ).length;
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
      recordContext: {
        all: all.length,
        selectedPolicy: scopedRows.length,
        unknown: policyRows(all, { ...options, policyVersion: "unknown" }).length,
      },
      totals: {
        fixtures: fixtureRows.length,
        pendingFixtures: fixtureRows.filter((fixture) =>
          fixture.some((row) => row.status === "pending"),
        ).length,
        settledFixtures: fixtureRows.filter((fixture) =>
          fixture.every((row) => row.status === "settled"),
        ).length,
        coreFixtures: coreFixtureRows.length,
        corePendingFixtures: coreFixtureRows.filter((fixture) =>
          fixture.some((row) => row.status === "pending"),
        ).length,
        coreSettledFixtures,
        corePending: coreRows.filter((row) => row.status === "pending").length,
        coreSettled: coreRows.filter((row) => row.status === "settled").length,
        fixtureSampleLevel: sampleLevelForCount(coreSettledFixtures),
        snapshots: rows.length,
        pending: rows.filter((row) => row.status === "pending").length,
        settled,
        recommendedCoverage: settled
          ? recommendedSettled / settled
          : null,
      },
      byReliability,
      overall: groupMetrics(rows),
      byMarket,
      byScope,
      coreByScope,
      byMarketScope,
      calibration: calibrationMetrics(rows),
      calibrationByScope: {
        all: calibrationMetrics(rows.filter((row) => !rowUsesSameLeague(row))),
        sameLeague: calibrationMetrics(rows.filter(rowUsesSameLeague)),
      },
      oddsBenchmark: oddsBenchmarkMetrics(rows),
      scopeComparison: pairedScopeMetrics(rows),
      errorDiagnosis: errorDiagnosisMetrics(rows),
      performanceEvents: performanceEvents(rows),
      filtered: {
        ...filteredMetrics,
        fixtures: filteredFixtures.size,
        pendingFixtures: [...filteredFixtures.values()].filter((fixture) =>
          fixture.some((row) => row.status === "pending"),
        ).length,
        byMarket: Object.fromEntries(
          ["spf", "hhad", "goals", "goalMultiple"].map((market) => [
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
        policyVersions: [...new Set(all.map((row) => row.policy_version))],
      },
    };
  }

  return {
    record,
    pending: () => pending.all(),
    settle: settleRow,
    transaction,
    refreshHistoricalAccounting,
    summary,
    close: () => db.close(),
  };
}
