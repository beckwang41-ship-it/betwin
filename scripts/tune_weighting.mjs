import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import {
  GOAL_LABELS,
  OUTCOME_LABELS,
  goalDistance,
  spfDistance,
} from "../lib/predictor.mjs";
import { tuneSimilarityWeighting } from "../lib/weighting-tuning.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const OUTPUT_PATH =
  process.env.BETWIN_WEIGHTING_CONFIG_PATH ||
  path.join(ROOT, "data", "weighting-config.json");
const THRESHOLD_CONFIG_PATH = path.join(ROOT, "data", "model-config.json");
const DEFAULT_THRESHOLDS = { spf: 0.07, hhad: 0.07, goals: 0.015 };
const FLOORS = [0.1, 0.2, 0.35, 0.5, 0.65, 0.8];
const POWERS = [1, 2, 3];
const CANDIDATES = FLOORS.flatMap((floor) =>
  POWERS.map((power) => ({
    id: `floor-${floor}-power-${power}`,
    floor,
    power,
  })),
);
const WARMUP = 500;
const VALIDATION_FRACTION = 0.2;

function loadThresholds(history, sourceUpdatedAt) {
  try {
    const config = JSON.parse(readFileSync(THRESHOLD_CONFIG_PATH, "utf8"));
    const current =
      config.data?.verifiedMatches === history.length &&
      config.data?.sourceUpdatedAt === sourceUpdatedAt;
    if (!current) return DEFAULT_THRESHOLDS;
    return Object.fromEntries(
      ["spf", "hhad", "goals"].map((market) => [
        market,
        Number(config.markets?.[market]?.threshold) ||
          DEFAULT_THRESHOLDS[market],
      ]),
    );
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

function common(row, sourceFile, sourceRow) {
  return {
    sourceFile,
    sourceRow,
    league: row.league,
    home: row.home,
    away: row.away,
  };
}

function spfRows(history) {
  return history.map((row) => ({
    ...common(row, row.spfSourceFile, row.spfSourceRow),
    result: row.spf.result,
    odds: row.spf.odds,
  }));
}

function hhadRows(history) {
  return history.map((row) => ({
    ...common(row, row.spfSourceFile, row.spfSourceRow),
    handicap: row.hhad.handicap,
    result: row.hhad.result,
    odds: row.hhad.odds,
  }));
}

function goalRows(history) {
  return history.map((row) => ({
    ...common(row, row.goalSourceFile, row.goalSourceRow),
    goals: row.goals,
    odds: row.goalMarket.odds,
  }));
}

function tune(rows, options) {
  return tuneSimilarityWeighting(rows, {
    candidates: CANDIDATES,
    warmup: WARMUP,
    validationFraction: VALIDATION_FRACTION,
    ...options,
  });
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function printMarket(label, result) {
  const selected = result.selected;
  const baseline = result.baseline;
  console.log(`\n${label}`);
  console.log(
    `较早调参段：等权 命中 ${percent(baseline.tuning.accuracy)} / LogLoss ${baseline.tuning.logLoss.toFixed(4)} / Brier ${baseline.tuning.brier.toFixed(4)}`,
  );
  console.log(
    `候选方案：${selected.uniform ? "等权" : `最低权重 ${percent(selected.floor)}、衰减 ${selected.power}`}；命中 ${percent(selected.tuning.accuracy)} / LogLoss ${selected.tuning.logLoss.toFixed(4)} / Brier ${selected.tuning.brier.toFixed(4)}`,
  );
  console.log(
    `最新验证段：等权 命中 ${percent(baseline.validation.accuracy)} / LogLoss ${baseline.validation.logLoss.toFixed(4)} / Brier ${baseline.validation.brier.toFixed(4)}`,
  );
  console.log(
    `候选验证：命中 ${percent(selected.validation.accuracy)} / LogLoss ${selected.validation.logLoss.toFixed(4)} / Brier ${selected.validation.brier.toFixed(4)}`,
  );
  if (selected.significance?.metrics) {
    const metrics = selected.significance.metrics;
    const interval = (metric) =>
      `${metric.lower >= 0 ? "+" : ""}${metric.lower.toFixed(4)} ～ ${metric.upper >= 0 ? "+" : ""}${metric.upper.toFixed(4)}`;
    console.log(
      `95%区间（${selected.significance.iterations.toLocaleString()} 次、连续 ${selected.significance.blockSize} 场区块）：` +
        `命中 ${interval(metrics.accuracy)}；` +
        `LogLoss ${interval(metrics.logLoss)}；` +
        `Brier ${interval(metrics.brier)}`,
    );
  }
  console.log(
    `${result.gate.passed ? "验证通过，生产启用距离加权" : "验证未通过，生产使用等权统计"}：${result.gate.reason}`,
  );
}

const store = createDataStore(DATABASE_PATH);
try {
  const history = store.getVerifiedHistory();
  const sourceUpdatedAt = store.getSourceUpdatedAt();
  const thresholds = loadThresholds(history, sourceUpdatedAt);
  const spf = tune(spfRows(history), {
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    tolerance: thresholds.spf,
    distance: (left, right) => spfDistance(left.odds, right.odds),
  });
  const hhad = tune(hhadRows(history), {
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    tolerance: thresholds.hhad,
    distance: (left, right) => spfDistance(left.odds, right.odds),
    compatible: (left, right) => left.handicap === right.handicap,
  });
  const goals = tune(goalRows(history), {
    labels: GOAL_LABELS,
    outcomeField: "goals",
    tolerance: thresholds.goals,
    distance: (left, right) => goalDistance(left.odds, right.odds),
  });
  const config = {
    version: 2,
    generatedAt: new Date().toISOString(),
    data: {
      database: path.basename(DATABASE_PATH),
      verifiedMatches: history.length,
      sourceUpdatedAt,
    },
    methodology: {
      ordering: "每个来源文件按 source_row 递增，每场只使用此前记录",
      warmup: WARMUP,
      tuningFraction: 1 - VALIDATION_FRACTION,
      validationFraction: VALIDATION_FRACTION,
      selection:
        "仅在较早80%选择最低权重与衰减幂次，最新20%不参与选择",
      gate:
        "最新验证段 Log Loss、Brier 必须同时优于等权统计且命中率不得下降，并通过95%连续区块Bootstrap",
      significance:
        "最新20%按连续20场为区块重采样1,000次；Log Loss和Brier区间上界须小于0，命中率区间下界须不小于0",
      fallback: "门禁未通过则生产环境自动使用等权历史占比",
      marketsIndependent: true,
    },
    searchSpace: {
      floors: FLOORS,
      powers: POWERS,
      thresholds,
    },
    markets: { spf, hhad, goals },
  };

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`已分析统一历史比赛 ${history.length.toLocaleString()} 场`);
  printMarket("胜平负", spf);
  printMarket("让球胜平负", hhad);
  printMarket("总进球", goals);
  console.log(`\n配置已写入：${OUTPUT_PATH}`);
} finally {
  store.close();
}
