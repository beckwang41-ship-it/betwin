import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { tuneMarketThreshold } from "../lib/parameter-tuning.mjs";
import {
  buildThreeWayEvents,
  threeWaySamplesForThreshold,
} from "../lib/three-way-backtest.mjs";
import { THREE_WAY_MATCHING_VERSION } from "../lib/three-way-matching.mjs";
import {
  GOAL_LABELS,
  OUTCOME_LABELS,
  goalDistance,
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
function loadCurrentThresholds({ verifiedMatches, sourceUpdatedAt }) {
  try {
    const previous = JSON.parse(readFileSync(OUTPUT_PATH, "utf8"));
    if (
      previous.data?.verifiedMatches !== verifiedMatches ||
      previous.data?.sourceUpdatedAt !== sourceUpdatedAt ||
      previous.methodology?.matchingVersion !== THREE_WAY_MATCHING_VERSION
    ) {
      return { ...DEFAULT_THRESHOLDS };
    }
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
let currentThresholds = { ...DEFAULT_THRESHOLDS };
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

function goalRows(history) {
  return history.map((row) => ({
    ...common(row, row.sourceFile, row.sourceRow),
    goals: row.goals,
    odds: row.odds,
  }));
}

function tune(rows, market, options) {
  return tuneMarketThreshold(rows, {
    tolerances: SEARCH_SPACE[market],
    currentTolerance: currentThresholds[market],
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
  const verifiedHistory = store.getVerifiedHistory();
  const sourceUpdatedAt = store.getSourceUpdatedAt();
  currentThresholds = loadCurrentThresholds({
    verifiedMatches: verifiedHistory.length,
    sourceUpdatedAt,
  });
  const spfHistory = store.getSpfHistory();
  const hhadHistory = store.getHhadHistory();
  const pairedHistory = store.getPairedSpfHhadHistory();
  const goalsHistory = store.getGoalHistory();
  const threeWayEvents = buildThreeWayEvents({
    spfHistory,
    hhadHistory,
    pairedHistory,
  });
  const spf = tune(threeWayEvents, "spf", {
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    targetEligible: (target) => Boolean(target.spf),
    actualForTarget: (target) => target.spf?.result,
    sampleResolver: (target, history, threshold) =>
      threeWaySamplesForThreshold(
        target,
        history,
        "spf",
        threshold,
        currentThresholds.hhad,
      ),
  });
  const hhad = tune(threeWayEvents, "hhad", {
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    targetEligible: (target) => Boolean(target.hhad),
    actualForTarget: (target) => target.hhad?.result,
    sampleResolver: (target, history, threshold) =>
      threeWaySamplesForThreshold(
        target,
        history,
        "hhad",
        threshold,
        currentThresholds.spf,
      ),
  });
  const goals = tune(goalRows(goalsHistory), "goals", {
    labels: GOAL_LABELS,
    outcomeField: "goals",
    distance: (left, right) => goalDistance(left.odds, right.odds),
  });

  const config = {
    version: 3,
    generatedAt: new Date().toISOString(),
    data: {
      database: path.basename(DATABASE_PATH),
      verifiedMatches: verifiedHistory.length,
      sourceUpdatedAt,
      spfHistory: spfHistory.length,
      hhadHistory: hhadHistory.length,
      pairedSpfHhadHistory: pairedHistory.length,
      goalHistory: goalsHistory.length,
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
      marketsIndependent: false,
      matchingVersion: THREE_WAY_MATCHING_VERSION,
      threeWayMatching:
        "SPF与HHAD同时存在时按两组赔率联合匹配；联合为零时各自回退独立池；缺盘时单市场匹配；Goals始终独立",
    },
    searchSpace: SEARCH_SPACE,
    currentThresholds,
    markets: { spf, hhad, goals },
  };

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(
    `已按来源行顺序分析 SPF ${spfHistory.length.toLocaleString()} / ` +
      `HHAD ${hhadHistory.length.toLocaleString()} / 配对 ${pairedHistory.length.toLocaleString()} / ` +
      `Goals ${goalsHistory.length.toLocaleString()} 场`,
  );
  printResult("胜平负", "spf", spf);
  printResult("让球胜平负", "hhad", hhad);
  printResult("总进球", "goals", goals);
  console.log(`\n配置已写入：${OUTPUT_PATH}`);
} finally {
  store.close();
}
