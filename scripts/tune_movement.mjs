import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { tuneMovementCorrection } from "../lib/movement-tuning.mjs";
import { GOAL_LABELS, OUTCOME_LABELS } from "../lib/predictor.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const THRESHOLD_CONFIG_PATH = path.join(ROOT, "data", "model-config.json");
const OUTPUT_PATH =
  process.env.BETWIN_MOVEMENT_CONFIG_PATH ||
  path.join(ROOT, "data", "movement-config.json");
const DEFAULT_THRESHOLDS = { spf: 0.07, hhad: 0.07, goals: 0.015 };
const WEIGHTS = [0.025, 0.05, 0.075, 0.1, 0.15, 0.2];
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
    initialOdds: row.spf.initialOdds,
    odds: row.spf.odds,
  }));
}

function hhadRows(history) {
  return history.map((row) => ({
    ...common(row, row.spfSourceFile, row.spfSourceRow),
    handicap: row.hhad.handicap,
    result: row.hhad.result,
    initialOdds: row.hhad.initialOdds,
    odds: row.hhad.odds,
  }));
}

function goalRows(history) {
  return history.map((row) => ({
    ...common(row, row.goalSourceFile, row.goalSourceRow),
    goals: row.goals,
    initialOdds: row.goalMarket.initialOdds,
    odds: row.goalMarket.odds,
  }));
}

function tune(rows, market, threshold, options) {
  return tuneMovementCorrection(rows, {
    market,
    tolerance: threshold,
    weights: WEIGHTS,
    warmup: WARMUP,
    validationFraction: VALIDATION_FRACTION,
    ...options,
  });
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function printResult(label, result) {
  const selected = result.selected;
  console.log(`\n${label}`);
  console.log(
    `候选修正比例 ${pct(selected.weight)} / ` +
      `生产采用 ${pct(result.production.fixedWeight)}`,
  );
  console.log(
    `可验证走势覆盖率：调参 ${pct(selected.tuning.coverage)} / ` +
      `验证 ${pct(selected.validation.coverage)}；` +
      `验证段中位走势样本 ${selected.validation.medianMovementSamples.toLocaleString()} 场`,
  );
  if (!selected.baseline) {
    console.log(
      `调参段 ${selected.tuning.evaluated.toLocaleString()} 场：` +
        `命中率 ${pct(result.baseline.tuning.accuracy)} → ${pct(selected.tuning.accuracy)}；` +
        `LogLoss ${result.baseline.tuning.logLoss.toFixed(4)} → ${selected.tuning.logLoss.toFixed(4)}；` +
        `Brier ${result.baseline.tuning.brier.toFixed(4)} → ${selected.tuning.brier.toFixed(4)}`,
    );
    console.log(
      `验证段 ${selected.validation.evaluated.toLocaleString()} 场：` +
        `命中率 ${pct(result.baseline.validation.accuracy)} → ${pct(selected.validation.accuracy)}；` +
        `LogLoss ${result.baseline.validation.logLoss.toFixed(4)} → ${selected.validation.logLoss.toFixed(4)}；` +
        `Brier ${result.baseline.validation.brier.toFixed(4)} → ${selected.validation.brier.toFixed(4)}`,
    );
    if (selected.significance?.metrics) {
      const interval = (metric) =>
        `${metric.lower >= 0 ? "+" : ""}${metric.lower.toFixed(4)} ～ ${metric.upper >= 0 ? "+" : ""}${metric.upper.toFixed(4)}`;
      console.log(
        `95%区间（${selected.significance.iterations.toLocaleString()} 次、连续 ${selected.significance.blockSize} 场区块）：` +
          `命中 ${interval(selected.significance.metrics.accuracy)}；` +
          `LogLoss ${interval(selected.significance.metrics.logLoss)}；` +
          `Brier ${interval(selected.significance.metrics.brier)}`,
      );
    }
  }
  console.log(
    `${result.gate.passed ? "门禁通过" : "门禁未通过"}：${result.gate.reason}`,
  );
}

const store = createDataStore(DATABASE_PATH);
try {
  const history = store.getVerifiedHistory();
  const sourceUpdatedAt = store.getSourceUpdatedAt();
  const thresholds = loadThresholds(history, sourceUpdatedAt);
  const spf = tune(spfRows(history), "spf", thresholds.spf, {
    labels: OUTCOME_LABELS,
    outcomeField: "result",
  });
  const hhad = tune(hhadRows(history), "hhad", thresholds.hhad, {
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    compatible: (left, right) => left.handicap === right.handicap,
  });
  const goals = tune(goalRows(history), "goals", thresholds.goals, {
    labels: GOAL_LABELS,
    outcomeField: "goals",
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
      ordering:
        "每个来源文件按 source_row 从小到大，每场只使用其之前的历史数据",
      validationFraction: VALIDATION_FRACTION,
      selection:
        "前80%选择固定走势修正比例，最新20%只做独立门禁",
      matching:
        "三个玩法独立；先按已验证终赔阈值取基础样本，再在同一玩法内匹配初赔、终赔及概率变化",
      gate:
        "调参段和验证段均须改善 Log Loss、Brier 且命中率不下降，并通过95%连续区块Bootstrap",
      significance:
        "最新20%按连续20场为区块重采样1,000次；Log Loss和Brier区间上界须小于0，命中率区间下界须不小于0",
      samples:
        "走势匹配找到1场也参与统计；完全没有走势样本时不修正",
    },
    searchSpace: {
      fixedWeights: WEIGHTS,
      thresholds,
    },
    markets: { spf, hhad, goals },
  };

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`已按行顺序分析统一历史比赛 ${history.length.toLocaleString()} 场`);
  printResult("胜平负走势", spf);
  printResult("让球胜平负走势", hhad);
  printResult("总进球走势", goals);
  console.log(`\n配置已写入：${OUTPUT_PATH}`);
} finally {
  store.close();
}
