import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { tuneMovementCorrection } from "../lib/movement-tuning.mjs";
import { GOAL_LABELS, OUTCOME_LABELS } from "../lib/predictor.mjs";
import { adjustedThreeWayMarketPrior } from "../lib/smoothing.mjs";
import {
  buildThreeWayEvents,
  threeWaySamplesForThreshold,
} from "../lib/three-way-backtest.mjs";
import { THREE_WAY_MATCHING_VERSION } from "../lib/three-way-matching.mjs";
import { FORMAL_PRODUCTION_THRESHOLDS } from "../lib/reliability-validation.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const SMOOTHING_CONFIG_PATH = path.join(
  ROOT,
  "data",
  "smoothing-config.json",
);
const OUTPUT_PATH =
  process.env.BETWIN_MOVEMENT_CONFIG_PATH ||
  path.join(ROOT, "data", "movement-config.json");
const WEIGHTS = [0.025, 0.05, 0.075, 0.1, 0.15, 0.2];
const WARMUP = 500;
const VALIDATION_FRACTION = 0.2;

function loadSmoothingPolicies(verifiedMatches, sourceUpdatedAt, thresholds) {
  try {
    const config = JSON.parse(readFileSync(SMOOTHING_CONFIG_PATH, "utf8"));
    const configuredThresholds = config.searchSpace?.thresholds || {};
    const thresholdChanged = ["spf", "hhad"].some(
      (market) =>
        Math.abs(
          Number(configuredThresholds[market]) - Number(thresholds[market]),
        ) > 1e-12,
    );
    const current =
      config.data?.verifiedMatches === verifiedMatches &&
      config.data?.sourceUpdatedAt === sourceUpdatedAt &&
      config.methodology?.matchingVersion === THREE_WAY_MATCHING_VERSION &&
      !thresholdChanged;
    if (!current) return {};
    return Object.fromEntries(
      ["spf", "hhad", "goals"].map((market) => {
        const value = config.markets?.[market] || {};
        const enabled = Boolean(
          value.gate?.passed && value.production?.enabled,
        );
        return [market, enabled ? value.production : null];
      }),
    );
  } catch {
    return {};
  }
}

function productionSmoothing(policy, odds, market) {
  if (!policy || policy.priorMode !== "adjusted-market") return {};
  const prior = adjustedThreeWayMarketPrior(odds, market);
  if (!prior) return {};
  return {
    smoothing: {
      ...policy,
      enabled: true,
      validated: true,
      prior,
    },
  };
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
    if (selected.strategy) {
      console.log(
        `独立投注门禁：基线ROI ${pct(selected.strategy.baseline.roi)} → ` +
          `候选ROI ${pct(selected.strategy.candidate.roi)}；` +
          `差值 ${pct(selected.strategy.roiDelta)}；` +
          `${selected.strategy.passed ? "通过" : "未通过"}（${selected.strategy.reason}）`,
      );
    }
  }
  console.log(
    `${result.gate.passed ? "门禁通过" : "门禁未通过"}：${result.gate.reason}`,
  );
}

const store = createDataStore(DATABASE_PATH);
try {
  const counts = store.getCounts();
  const spfHistory = store.getSpfHistory();
  const hhadHistory = store.getHhadHistory();
  const pairedHistory = store.getPairedSpfHhadHistory();
  const goalsHistory = store.getGoalHistory();
  const sourceUpdatedAt = store.getHistoricalSourceUpdatedAt();
  const thresholds = { ...FORMAL_PRODUCTION_THRESHOLDS };
  const smoothingPolicies = loadSmoothingPolicies(
    counts.verifiedHistory,
    sourceUpdatedAt,
    thresholds,
  );
  const threeWayEvents = buildThreeWayEvents({
    spfHistory,
    hhadHistory,
    pairedHistory,
  });
  const threeWayOptions = (market) => ({
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    targetEligible: (target) => Boolean(target[market]),
    actualForTarget: (target) => target[market]?.result,
    oddsForTarget: (target) => target[market]?.odds,
    initialOddsForTarget: (target) => target[market]?.initialOdds,
    sampleResolver: (target, history) =>
      threeWaySamplesForThreshold(
        target,
        history,
        market,
        thresholds[market],
        thresholds[market === "spf" ? "hhad" : "spf"],
      ),
    predictionOptionsResolver: (target) =>
      productionSmoothing(
        smoothingPolicies[market],
        target[market]?.odds,
        market,
      ),
  });
  const spf = tune(threeWayEvents, "spf", thresholds.spf, threeWayOptions("spf"));
  const hhad = tune(
    threeWayEvents,
    "hhad",
    thresholds.hhad,
    threeWayOptions("hhad"),
  );
  const goals = tune(goalsHistory, "goals", thresholds.goals, {
    labels: GOAL_LABELS,
    outcomeField: "goals",
  });

  const config = {
    version: 3,
    generatedAt: new Date().toISOString(),
    candidateOnly: true,
    runtimeEnabled: false,
    data: {
      database: path.basename(DATABASE_PATH),
      verifiedMatches: counts.verifiedHistory,
      spfHistory: counts.spfHistory,
      hhadHistory: counts.hhadHistory,
      pairedHistory: pairedHistory.length,
      goalHistory: counts.goalHistory,
      sourceUpdatedAt,
    },
    methodology: {
      matchingVersion: THREE_WAY_MATCHING_VERSION,
      ordering:
        "每个来源文件按 source_row 从小到大，每场只使用其之前的历史数据",
      warmup: WARMUP,
      validationFraction: VALIDATION_FRACTION,
      selection:
        "前80%选择固定走势修正比例，最新20%只做独立门禁",
      matching:
        "胜平负与让球胜平负复用生产联合匹配：两者齐全且联合池有样本时共同筛选，否则回退单市场；总进球独立匹配",
      baseline:
        "以当前生产基础预测为基线；已通过门禁的平滑会先应用，再评估走势固定修正比例的增量价值",
      gate:
        "调参段和验证段均须改善 Log Loss、Brier 且命中率不下降，并通过95%连续区块Bootstrap",
      bettingGate:
        "投注策略与概率门禁分开：按模型并列首选的实际注数计成本，在最新20%共同比赛上计算ROI及连续区块Bootstrap区间；只作离线证据，不自动改变生产",
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
  console.log(
    `已按行顺序分析胜平负 ${spfHistory.length.toLocaleString()} 场、` +
      `让球 ${hhadHistory.length.toLocaleString()} 场、` +
      `成对 ${pairedHistory.length.toLocaleString()} 场、` +
      `进球数 ${goalsHistory.length.toLocaleString()} 场`,
  );
  printResult("胜平负走势", spf);
  printResult("让球胜平负走势", hhad);
  printResult("总进球走势", goals);
  console.log(`\n配置已写入：${OUTPUT_PATH}`);
} finally {
  store.close();
}
