import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tuneAdaptiveMinimumSamples } from "../lib/adaptive-threshold.mjs";
import { createDataStore } from "../lib/database.mjs";
import {
  GOAL_LABELS,
  OUTCOME_LABELS,
  goalDistance,
  spfDistance,
} from "../lib/predictor.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const MODEL_CONFIG_PATH = path.join(ROOT, "data", "model-config.json");
const OUTPUT_PATH =
  process.env.BETWIN_ADAPTIVE_CONFIG_PATH ||
  path.join(ROOT, "data", "adaptive-config.json");
const THRESHOLDS = {
  spf: [0.03, 0.05, 0.07, 0.1],
  hhad: [0.03, 0.05, 0.07, 0.1],
  goals: [0.005, 0.01, 0.015, 0.02],
};
const MINIMUMS = {
  spf: [30, 50, 100, 150, 200],
  hhad: [30, 50, 100, 150, 200],
  goals: [100, 300, 500, 800, 1000],
};
const DEFAULT_THRESHOLDS = {
  spf: 0.1,
  hhad: 0.1,
  goals: 0.015,
};
const WARMUP = 500;
const VALIDATION_FRACTION = 0.2;

function loadProductionThresholds() {
  try {
    const config = JSON.parse(readFileSync(MODEL_CONFIG_PATH, "utf8"));
    return Object.fromEntries(
      Object.entries(DEFAULT_THRESHOLDS).map(([market, fallback]) => {
        const threshold = Number(config.markets?.[market]?.threshold);
        return [
          market,
          Number.isFinite(threshold) && threshold > 0
            ? threshold
            : fallback,
        ];
      }),
    );
  } catch {
    return { ...DEFAULT_THRESHOLDS };
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

function tune(rows, market, productionThresholds, options) {
  return tuneAdaptiveMinimumSamples(rows, {
    thresholds: THRESHOLDS[market],
    minSampleCandidates: MINIMUMS[market],
    baselineThreshold: productionThresholds[market],
    warmup: WARMUP,
    validationFraction: VALIDATION_FRACTION,
    ...options,
  });
}

function percentage(value) {
  return (Number(value || 0) * 100).toFixed(2) + "%";
}

function thresholdText(value, market) {
  return market === "goals"
    ? (Number(value) * 100).toFixed(1) + "pp"
    : "±" + (Number(value) * 100).toFixed(0) + "%";
}

function printResult(label, market, result) {
  console.log("\n" + label);
  if (!result.selected) {
    console.log("未采用：" + result.gate.reason);
    return;
  }
  const metric =
    result.objective === "top-two" ? "双选覆盖率" : "命中率";
  const tuning = result.selected.tuningComparison;
  const validation = result.selected.validationComparison;
  console.log(
    "候选最低样本 " +
      result.selected.minSamples +
      " 场 / 范围 " +
      result.thresholds
        .map((value) => thresholdText(value, market))
        .join(" → "),
  );
  console.log(
    "调参段" +
      metric +
      " " +
      percentage(tuning.baseline[result.objective === "top-two" ? "topTwoCoverage" : "accuracy"]) +
      " → " +
      percentage(tuning.adaptive[result.objective === "top-two" ? "topTwoCoverage" : "accuracy"]) +
      "；LogLoss差 " +
      tuning.delta.logLoss.toFixed(4),
  );
  console.log(
    "验证段" +
      metric +
      " " +
      percentage(validation.baseline[result.objective === "top-two" ? "topTwoCoverage" : "accuracy"]) +
      " → " +
      percentage(validation.adaptive[result.objective === "top-two" ? "topTwoCoverage" : "accuracy"]) +
      "；LogLoss差 " +
      validation.delta.logLoss.toFixed(4),
  );
  console.log((result.enabled ? "已采用：" : "未采用：") + result.gate.reason);
}

const productionThresholds = loadProductionThresholds();
const store = createDataStore(DATABASE_PATH);
try {
  const history = store.getVerifiedHistory();
  const spf = tune(spfRows(history), "spf", productionThresholds, {
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    distance: (left, right) => spfDistance(left.odds, right.odds),
    objective: "accuracy",
  });
  const hhad = tune(hhadRows(history), "hhad", productionThresholds, {
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    distance: (left, right) => spfDistance(left.odds, right.odds),
    compatible: (left, right) => left.handicap === right.handicap,
    objective: "accuracy",
  });
  const goals = tune(goalRows(history), "goals", productionThresholds, {
    labels: GOAL_LABELS,
    outcomeField: "goals",
    distance: (left, right) => goalDistance(left.odds, right.odds),
    objective: "top-two",
  });
  const config = {
    version: 1,
    generatedAt: new Date().toISOString(),
    data: {
      database: path.basename(DATABASE_PATH),
      verifiedMatches: history.length,
      sourceUpdatedAt: store.getSourceUpdatedAt(),
    },
    methodology: {
      ordering:
        "每个来源文件按source_row逐场回测，每场只使用它之前的数据",
      selection:
        "前80%选择最低样本数，最新20%只验证；调参与验证均优于固定范围才启用",
      fallback:
        "从最严格范围开始，达到最低样本数立即停止；所有范围均不足时使用最大范围",
      goalObjective:
        "总进球以双选覆盖率为目标，同时要求Log Loss和Brier改善",
    },
    productionThresholds,
    markets: { spf, hhad, goals },
  };
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(
    "已按行顺序分析统一历史比赛 " +
      history.length.toLocaleString() +
      " 场",
  );
  printResult("胜平负", "spf", spf);
  printResult("让球胜平负", "hhad", hhad);
  printResult("总进球双选", "goals", goals);
  console.log("\n配置已写入：" + OUTPUT_PATH);
} finally {
  store.close();
}
