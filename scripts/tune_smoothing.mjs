import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import {
  GOAL_LABELS,
  OUTCOME_LABELS,
  goalDistance,
  spfDistance,
} from "../lib/predictor.mjs";
import { tuneHistoricalSmoothing } from "../lib/smoothing-tuning.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const OUTPUT_PATH =
  process.env.BETWIN_SMOOTHING_CONFIG_PATH ||
  path.join(ROOT, "data", "smoothing-config.json");
const THRESHOLDS = { spf: 0.07, hhad: 0.07, goals: 0.015 };
const STRENGTHS = [1, 2, 3, 5, 8, 12, 20];
const WARMUP = 500;
const VALIDATION_FRACTION = 0.2;
const RELAXED_MULTIPLIER = 2;
const MIN_LOCALIZED_SAMPLES = 30;

function common(row, sourceFile, sourceRow) {
  return {
    sourceFile,
    sourceRow,
    league: row.league,
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

function tune(rows, market, options) {
  return tuneHistoricalSmoothing(rows, {
    threshold: THRESHOLDS[market],
    strengths: STRENGTHS,
    warmup: WARMUP,
    validationFraction: VALIDATION_FRACTION,
    relaxedMultiplier: RELAXED_MULTIPLIER,
    minLocalizedSamples: MIN_LOCALIZED_SAMPLES,
    ...options,
  });
}

function percentage(value) {
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function printResult(label, result) {
  const comparison = result.selected.validationComparison;
  console.log(`\n${label}`);
  console.log(
    `候选先验强度 ${result.candidateStrength} / 生产强度 ${result.strength} / ` +
      `${result.gate.passed ? "已启用" : "仅参考"}`,
  );
  console.log(
    `最新20%共同样本 ${comparison.evaluated.toLocaleString()} 场：` +
      `命中率 ${percentage(comparison.baseline.accuracy)} → ${percentage(comparison.candidate.accuracy)}；` +
      `LogLoss ${comparison.baseline.logLoss.toFixed(4)} → ${comparison.candidate.logLoss.toFixed(4)}；` +
      `Brier ${comparison.baseline.brier.toFixed(4)} → ${comparison.candidate.brier.toFixed(4)}`,
  );
  const significance = result.selected.significance;
  if (significance.metrics) {
    console.log(
      `95%区间：命中 ${significance.metrics.accuracy.lower.toFixed(4)}～${significance.metrics.accuracy.upper.toFixed(4)}；` +
        `LogLoss ${significance.metrics.logLoss.lower.toFixed(4)}～${significance.metrics.logLoss.upper.toFixed(4)}；` +
        `Brier ${significance.metrics.brier.lower.toFixed(4)}～${significance.metrics.brier.upper.toFixed(4)}`,
    );
  }
  console.log(result.gate.reason);
}

const store = createDataStore(DATABASE_PATH);
try {
  const history = store.getVerifiedHistory();
  const spf = tune(spfRows(history), "spf", {
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    distance: (left, right) => spfDistance(left.odds, right.odds),
  });
  const hhad = tune(hhadRows(history), "hhad", {
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    distance: (left, right) => spfDistance(left.odds, right.odds),
    compatible: (left, right) => left.handicap === right.handicap,
  });
  const goals = tune(goalRows(history), "goals", {
    labels: GOAL_LABELS,
    outcomeField: "goals",
    distance: (left, right) => goalDistance(left.odds, right.odds),
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
        "每个来源文件按 source_row 从小到大，每场只使用其之前的历史数据",
      warmup: WARMUP,
      validationFraction: VALIDATION_FRACTION,
      selection:
        "前80%选择历史先验强度，最新20%只做独立门禁；未通过则生产继续使用原始历史占比",
      prior:
        "同联赛宽赔率带样本足够时优先；否则依次回退到全联赛宽赔率带、同联赛全部历史、全部历史基础分布",
      formula: "(原始场次数 + 先验强度 × 历史先验概率) / (原始样本数 + 先验强度)",
      fallback:
        "原始相似样本为0时仍不预测；平滑结果不允许作为赔率概率兜底",
      gate:
        "调参段和验证段均须改善 Log Loss、Brier 且命中率不下降，并通过95%连续区块Bootstrap",
      marketsIndependent: true,
    },
    searchSpace: {
      strengths: STRENGTHS,
      thresholds: THRESHOLDS,
      relaxedMultiplier: RELAXED_MULTIPLIER,
      minLocalizedSamples: MIN_LOCALIZED_SAMPLES,
    },
    markets: { spf, hhad, goals },
  };

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`已分析统一历史比赛 ${history.length.toLocaleString()} 场`);
  printResult("胜平负", spf);
  printResult("让球胜平负", hhad);
  printResult("总进球", goals);
  console.log(`\n配置已写入：${OUTPUT_PATH}`);
} finally {
  store.close();
}
