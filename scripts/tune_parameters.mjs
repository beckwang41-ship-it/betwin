import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { tuneMarketThreshold } from "../lib/parameter-tuning.mjs";
import {
  GOAL_LABELS,
  OUTCOME_LABELS,
  goalDistance,
  spfDistance,
} from "../lib/predictor.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const OUTPUT_PATH =
  process.env.BETWIN_MODEL_CONFIG_PATH ||
  path.join(ROOT, "data", "model-config.json");

const DEFAULT_THRESHOLDS = {
  spf: 0.07,
  hhad: 0.07,
  goals: 0.015,
};
function loadCurrentThresholds() {
  try {
    const previous = JSON.parse(readFileSync(OUTPUT_PATH, "utf8"));
    return Object.fromEntries(
      Object.entries(DEFAULT_THRESHOLDS).map(([market, fallback]) => {
        const value = Number(previous.markets?.[market]?.threshold);
        return [market, Number.isFinite(value) && value > 0 ? value : fallback];
      }),
    );
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}
const CURRENT_THRESHOLDS = loadCurrentThresholds();
const SEARCH_SPACE = {
  spf: [0.03, 0.05, 0.07, 0.1],
  hhad: [0.03, 0.05, 0.07, 0.1],
  goals: [0.005, 0.01, 0.015, 0.02],
};
const WARMUP = 500;
const VALIDATION_FRACTION = 0.2;

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

function tune(rows, market, options) {
  return tuneMarketThreshold(rows, {
    tolerances: SEARCH_SPACE[market],
    currentTolerance: CURRENT_THRESHOLDS[market],
    warmup: WARMUP,
    validationFraction: VALIDATION_FRACTION,
    ...options,
  });
}

function percentage(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function thresholdText(value, market) {
  return market === "goals"
    ? `${(value * 100).toFixed(1)}pp`
    : `±${(value * 100).toFixed(0)}%`;
}

function printMetrics(prefix, comparison) {
  if (!comparison) return;
  const { candidate, baseline, delta } = comparison;
  console.log(
    `${prefix}共同样本 ${comparison.evaluated.toLocaleString()} 场：` +
      `命中率 ${percentage(baseline.accuracy)} → ${percentage(candidate.accuracy)}；` +
      `LogLoss ${baseline.logLoss.toFixed(4)} → ${candidate.logLoss.toFixed(4)}；` +
      `Brier ${baseline.brier.toFixed(4)} → ${candidate.brier.toFixed(4)}；` +
      `差值 ${delta.logLoss >= 0 ? "+" : ""}${delta.logLoss.toFixed(4)}`,
  );
}

function signed(value, digits = 4) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function printSignificance(significance) {
  if (!significance?.metrics) return;
  const metrics = significance.metrics;
  console.log(
    `95%区间（${significance.iterations.toLocaleString()} 次、连续 ${significance.blockSize} 场区块）：` +
      `命中 ${signed(metrics.accuracy.lower)} ～ ${signed(metrics.accuracy.upper)}；` +
      `LogLoss ${signed(metrics.logLoss.lower)} ～ ${signed(metrics.logLoss.upper)}；` +
      `Brier ${signed(metrics.brier.lower)} ～ ${signed(metrics.brier.upper)}`,
  );
}

function printResult(label, market, result) {
  console.log(`\n${label}`);
  console.log(
    `当前 ${thresholdText(result.currentThreshold, market)} / ` +
      `较早段候选 ${thresholdText(result.candidateThreshold, market)} / ` +
      `生产采用 ${thresholdText(result.threshold, market)}`,
  );
  console.log(
    `候选覆盖率：调参 ${percentage(result.selected.tuning.coverage)} / ` +
      `验证 ${percentage(result.selected.validation.coverage)}；` +
      `验证段中位样本 ${result.selected.validation.medianSamples.toLocaleString()} 场`,
  );
  printMetrics("调参段", result.selected.tuningComparison);
  printMetrics("验证段", result.selected.validationComparison);
  printSignificance(result.selected.significance);
  const decision = result.gate.significancePassed
    ? "严格门禁通过"
    : result.gate.passed
      ? "表现优先采用（观察中）"
      : "未采用";
  console.log(`${decision}：${result.gate.reason}`);
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
    version: 3,
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
        "前80%仅用于从候选阈值中选择；最新20%不参与选择，只做一次独立门禁",
      comparison:
        "候选阈值与当前阈值只在双方都有历史样本的共同比赛上比较，覆盖率另行报告",
      gate:
        "表现优先：调参段与验证段均须改善 Log Loss、Brier 且命中率不下降即可采用；95%连续区块Bootstrap决定标记为严格通过或观察中",
      significance:
        "最新20%按连续20场为区块重采样1,000次；Log Loss和Brier区间上界须小于0，命中率区间下界须不小于0；未通过时不否决跨调参段和验证段均改善的候选，但标记为观察中",
      adoptionPolicy: "performance-first",
      fallback:
        "任意样本数都使用真实历史占比；只有零样本时不预测，不回退赔率概率",
      tieAccuracy:
        "并列最高概率按并列结果数分摊命中分值，避免任意偏向第一个结果",
      marketsIndependent: true,
    },
    searchSpace: SEARCH_SPACE,
    currentThresholds: CURRENT_THRESHOLDS,
    markets: { spf, hhad, goals },
  };

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`已按行顺序分析统一历史比赛 ${history.length.toLocaleString()} 场`);
  printResult("胜平负", "spf", spf);
  printResult("让球胜平负", "hhad", hhad);
  printResult("总进球", "goals", goals);
  console.log(`\n配置已写入：${OUTPUT_PATH}`);
} finally {
  store.close();
}
