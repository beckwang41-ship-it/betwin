import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import {
  GOAL_LABELS,
  OUTCOME_LABELS,
  weightedDistribution,
} from "../lib/predictor.mjs";
import { GOAL_MATCHING_VERSION } from "../lib/goal-zero-odds.mjs";
import { selectProductionGoalSimilarity } from "../lib/goal-production.mjs";
import { selectHistoricalPrior } from "../lib/smoothing.mjs";
import { THREE_WAY_MATCHING_VERSION } from "../lib/three-way-matching.mjs";
import {
  buildThreeWaySmoothingRows,
  createThreeWaySmoothingResolvers,
} from "../lib/three-way-smoothing.mjs";
import { tuneHistoricalSmoothing } from "../lib/smoothing-tuning.mjs";
import { HISTORY_TIMELINE_VERSION } from "../lib/history-timeline.mjs";
import { SMOOTHING_VALIDATION_VERSION } from "../lib/smoothing-production.mjs";

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

function candidateOnlyResult(result) {
  const candidatePassed = Boolean(result.gate?.passed);
  return {
    ...result,
    strength: 0,
    productionStrength: 0,
    changed: false,
    candidateChanged: candidatePassed,
    production: {
      ...(result.production || {}),
      enabled: false,
      strength: 0,
      referenceStrength: result.candidateStrength,
      candidatePassed,
      candidateStrength: result.candidateStrength,
      reason: candidatePassed
        ? "离线候选已通过门禁，但完整刷新不会自动上线；等待独立人工批准"
        : result.gate?.reason,
    },
    gate: {
      ...(result.gate || {}),
      productionApplied: false,
    },
  };
}

function percentage(value) {
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function printResult(label, result) {
  const comparison = result.selected.validationComparison;
  console.log(`\n${label}`);
  console.log(
    `候选先验强度 ${result.candidateStrength} / 生产强度 ${result.productionStrength} / ` +
      `${result.gate.passed ? "候选通过、等待人工批准" : "候选未通过"}`,
  );
  console.log(
    `校准：ECE ${percentage(comparison.baseline.calibration.expectedCalibrationError)} → ${percentage(comparison.candidate.calibration.expectedCalibrationError)}；` +
      `MCE ${percentage(comparison.baseline.calibration.maximumCalibrationError || 0)} → ${percentage(comparison.candidate.calibration.maximumCalibrationError || 0)}；` +
      `≥75%高概率档偏差 ${percentage(comparison.baseline.calibration.highConfidence.observedAbsoluteGap || 0)} → ${percentage(comparison.candidate.calibration.highConfidence.observedAbsoluteGap || 0)}`,
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
  const counts = store.getCounts();
  const goalHistory = store.getGoalHistory();
  const sourceUpdatedAt = store.getHistoricalSourceUpdatedAt();
  const pools = { spfHistory: store.getSpfHistory(), hhadHistory: store.getHhadHistory(), pairedHistory: store.getPairedSpfHhadHistory() };
  const spf = candidateOnlyResult(tune(buildThreeWaySmoothingRows(pools, "spf"), "spf", {
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    distance: () => Number.POSITIVE_INFINITY,
    ...createThreeWaySmoothingResolvers("spf", {
      spfTolerance: THRESHOLDS.spf,
      hhadTolerance: THRESHOLDS.hhad,
    }),
  }));
  const hhad = candidateOnlyResult(tune(buildThreeWaySmoothingRows(pools, "hhad"), "hhad", {
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    distance: () => Number.POSITIVE_INFINITY,
    ...createThreeWaySmoothingResolvers("hhad", {
      spfTolerance: THRESHOLDS.spf,
      hhadTolerance: THRESHOLDS.hhad,
    }),
  }));
  const goals = candidateOnlyResult(tune(goalHistory, "goals", {
    labels: GOAL_LABELS,
    outcomeField: "goals",
    distance: () => Number.POSITIVE_INFINITY,
    sampleResolver: (target, priorRows) =>
      selectProductionGoalSimilarity(priorRows, target).similar,
    empiricalResolver: (similar) => {
      const weighted = weightedDistribution(
        similar,
        "goals",
        GOAL_LABELS,
        { enabled: true, weightField: "similarityWeight" },
      );
      return {
        probabilities: GOAL_LABELS.map(
          (label) => weighted.probabilities[label],
        ),
        counts: GOAL_LABELS.map(
          (label) => weighted.weightedCounts[label],
        ),
      };
    },
    priorResolver: (priorRows, target, options) =>
      selectHistoricalPrior(priorRows, target, {
        labels: GOAL_LABELS,
        outcomeField: "goals",
        distance: (left, right) =>
          Math.abs(Number(left.odds?.[0]) - Number(right.odds?.[0])),
        relaxedTolerance: 2 * Number(options.relaxedMultiplier || 2),
        minLocalizedSamples: options.minLocalizedSamples,
      }),
  }));

  const config = {
    version: 2,
    generatedAt: new Date().toISOString(),
    candidateOnly: true,
    runtimeEnabled: false,
    data: {
      timelineVersion: HISTORY_TIMELINE_VERSION,
      validationVersion: SMOOTHING_VALIDATION_VERSION,
      database: path.basename(DATABASE_PATH),
      verifiedMatches: counts.verifiedHistory,
      goalHistory: counts.goalHistory,
      sourceUpdatedAt,
      matchingVersion: THREE_WAY_MATCHING_VERSION,
      goalMatchingVersion: GOAL_MATCHING_VERSION,
    },
    methodology: {
      matchingVersion: THREE_WAY_MATCHING_VERSION,
      goalMatchingVersion: GOAL_MATCHING_VERSION,
      ordering:
        "旧累加来源按各自旧顺序回放；每日增量按数据库批次，整批预测后才进入训练，旧来源作为初始池；统一切分且不拆批次",
      warmup: WARMUP,
      validationFraction: VALIDATION_FRACTION,
      selection:
        "按时间代理序列前80%选择强度、后20%检验，不拆批次；旧末段已被多次观察，本次属于研究复核而非全新独立测试；不自动上线",
      promotion:
        "生产启用状态由独立的smoothing-production.json人工批准记录管理，数据库刷新不会覆写批准文件",
      threeWayMatching:
        "双盘口使用配对历史联合匹配，联合为0不回退；缺少一个盘口才单盘口匹配；先验使用该玩法全部可用历史，包括未配对记录",
      prior:
        "同联赛宽赔率带样本足够时优先；否则依次回退到全联赛宽赔率带、同联赛全部历史、全部历史基础分布",
      formula: "(原始场次数 + 先验强度 × 历史先验概率) / (原始样本数 + 先验强度)",
      fallback:
        "原始相似样本为0时仍不预测；平滑结果不允许作为赔率概率兜底",
      gate:
        "调参段和验证段均须改善 Log Loss、Brier、ECE，命中率不下降，MCE和≥75%高概率档偏差不恶化，并通过95%连续区块Bootstrap",
      marketsIndependent: true,
      goalMatching:
        "总进球基线复用生产0球赔率±2.00窗口和综合距离指数权重；平滑先验的宽窗口只作候选验证",
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
