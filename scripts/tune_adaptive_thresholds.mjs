import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tuneAdaptiveMinimumSamples } from "../lib/adaptive-threshold.mjs";
import { createDataStore } from "../lib/database.mjs";
import {
  OUTCOME_LABELS,
} from "../lib/predictor.mjs";
import { applyZeroCellFloor } from "../lib/smoothing.mjs";
import {
  buildThreeWayEvents,
  threeWaySamplesForThreshold,
} from "../lib/three-way-backtest.mjs";
import { GOAL_MATCHING_VERSION } from "../lib/goal-zero-odds.mjs";
import { THREE_WAY_MATCHING_VERSION } from "../lib/three-way-matching.mjs";
import { FORMAL_PRODUCTION_THRESHOLDS } from "../lib/reliability-validation.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const OUTPUT_PATH =
  process.env.BETWIN_ADAPTIVE_CONFIG_PATH ||
  path.join(ROOT, "data", "adaptive-config.json");
const THRESHOLDS = {
  spf: [0.03, 0.05, 0.07],
  hhad: [0.03, 0.05, 0.07],
};
const MINIMUMS = {
  spf: [30, 50, 100, 150, 200],
  hhad: [30, 50, 100, 150, 200],
};
const WARMUP = 500;
const VALIDATION_FRACTION = 0.2;

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
  const strategy = result.selected.strategy;
  if (strategy) {
    console.log(
      "独立投注门禁：基线ROI " +
        percentage(strategy.baseline.roi) +
        " → 候选ROI " +
        percentage(strategy.candidate.roi) +
        "；差值 " +
        percentage(strategy.roiDelta) +
        "；" +
        (strategy.passed ? "通过" : "未通过") +
        "（" +
        strategy.reason +
        "）",
    );
  }
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

const store = createDataStore(DATABASE_PATH);
try {
  const counts = store.getCounts();
  const sourceUpdatedAt = store.getHistoricalSourceUpdatedAt();
  const productionThresholds = { ...FORMAL_PRODUCTION_THRESHOLDS };
  const spfHistory = store.getSpfHistory();
  const hhadHistory = store.getHhadHistory();
  const pairedHistory = store.getPairedSpfHhadHistory();
  const events = buildThreeWayEvents({
    spfHistory,
    hhadHistory,
    pairedHistory,
  });
  const marketOptions = (market) => ({
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    distance: () => Infinity,
    targetEligible: (target) => Boolean(target[market]),
    actualForTarget: (target) => target[market]?.result,
    oddsForTarget: (target) => target[market]?.odds,
    sampleResolver: (target, priorRows, threshold) =>
      threeWaySamplesForThreshold(
        target,
        priorRows,
        market,
        threshold,
        threshold,
      ),
    outcomeForSample: (row) => row.result,
    probabilityResolver: (counts) =>
      applyZeroCellFloor(counts).probabilities,
    objective: "accuracy",
  });
  const spf = tune(events, "spf", productionThresholds, marketOptions("spf"));
  const hhad = tune(
    events,
    "hhad",
    productionThresholds,
    marketOptions("hhad"),
  );
  const goals = {
    enabled: false,
    objective: "top-two",
    thresholds: [],
    selected: null,
    productionManaged: true,
    matchingVersion: GOAL_MATCHING_VERSION,
    gate: {
      passed: false,
      reason:
        "总进球生产模型使用固定0球赔率窗口和综合距离权重，不再使用旧八档概率阈值阶梯；动态阈值功能不适用",
    },
  };
  const config = {
    version: 1,
    generatedAt: new Date().toISOString(),
    candidateOnly: true,
    runtimeEnabled: false,
    data: {
      database: path.basename(DATABASE_PATH),
      verifiedMatches: counts.verifiedHistory,
      sourceUpdatedAt,
      spfHistory: spfHistory.length,
      hhadHistory: hhadHistory.length,
      pairedHistory: pairedHistory.length,
      thresholdSource: "locked-formal-production-rules",
      goalMatchingVersion: GOAL_MATCHING_VERSION,
    },
    methodology: {
      matchingVersion: THREE_WAY_MATCHING_VERSION,
      goalMatchingVersion: GOAL_MATCHING_VERSION,
      ordering:
        "每个来源文件按source_row逐场回测，每场只使用它之前的数据",
      selection:
        "前80%选择最低样本数，最新20%只验证；调参与验证均优于固定范围才启用",
      matching:
        "胜平负与让球同时存在时按相同动态范围联合匹配，联合为0才分别回退；让球始终要求相同盘口；概率使用正式防零层",
      fallback:
        "从最严格范围开始，达到最低样本数立即停止；所有范围均不足时使用最大范围",
      bettingGate:
        "投注策略与概率门禁分开：并列方向按覆盖数量计成本，覆盖全部结果视为无预测；最新20%按共同比赛计算ROI及连续区块Bootstrap区间，只作离线证据",
      goalObjective:
        "总进球固定0球窗口不参与旧阈值阶梯调参，保持生产匹配器管理",
    },
    productionThresholds,
    markets: { spf, hhad, goals },
  };
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(
    "已按行顺序分析统一历史比赛 " +
      events.length.toLocaleString() +
      " 场",
  );
  printResult("胜平负", "spf", spf);
  printResult("让球胜平负", "hhad", hhad);
  printResult("总进球双选", "goals", goals);
  console.log("\n配置已写入：" + OUTPUT_PATH);
} finally {
  store.close();
}
