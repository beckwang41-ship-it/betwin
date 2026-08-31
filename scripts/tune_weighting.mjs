import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { OUTCOME_LABELS } from "../lib/predictor.mjs";
import { GOAL_MATCHING_VERSION } from "../lib/goal-zero-odds.mjs";
import { adjustedThreeWayMarketPrior } from "../lib/smoothing.mjs";
import {
  buildThreeWayEvents,
  threeWaySamplesForThreshold,
} from "../lib/three-way-backtest.mjs";
import { THREE_WAY_MATCHING_VERSION } from "../lib/three-way-matching.mjs";
import { tuneSimilarityWeighting } from "../lib/weighting-tuning.mjs";
import { FORMAL_PRODUCTION_THRESHOLDS } from "../lib/reliability-validation.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const OUTPUT_PATH =
  process.env.BETWIN_WEIGHTING_CONFIG_PATH ||
  path.join(ROOT, "data", "weighting-config.json");
const SMOOTHING_CONFIG_PATH = path.join(
  ROOT,
  "data",
  "smoothing-config.json",
);
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
  if (result.productionManaged) {
    console.log(`\n${label}`);
    console.log(`固定生产权重：${result.gate.reason}`);
    return;
  }
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
    `${result.gate.passed ? "概率门禁通过，仅保存候选" : "概率门禁未通过"}：${result.gate.reason}`,
  );
  if (selected.strategy) {
    console.log(
      `投注ROI门禁：${selected.strategy.passed ? "通过" : "未通过"}（${selected.strategy.reason}）`,
    );
  }
}

const store = createDataStore(DATABASE_PATH);
try {
  const counts = store.getCounts();
  const spfHistory = store.getSpfHistory();
  const hhadHistory = store.getHhadHistory();
  const pairedHistory = store.getPairedSpfHhadHistory();
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
    tolerance: thresholds[market],
    targetEligible: (target) => Boolean(target[market]),
    actualForTarget: (target) => target[market]?.result,
    oddsForTarget: (target) => target[market]?.odds,
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
  const spf = tune(threeWayEvents, threeWayOptions("spf"));
  const hhad = tune(threeWayEvents, threeWayOptions("hhad"));
  const goals = {
    threshold: thresholds.goals,
    selected: null,
    baseline: null,
    candidates: [],
    productionManaged: true,
    matchingVersion: GOAL_MATCHING_VERSION,
    production: {
      enabled: false,
      managedBy: GOAL_MATCHING_VERSION,
    },
    gate: {
      passed: false,
      tuningPassed: false,
      validationPassed: false,
      significancePassed: false,
      reason:
        "总进球生产模型已经固定按综合距离指数衰减；旧floor/power距离权重不再适用，也不会覆盖生产权重",
    },
    sources: [],
  };
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
      goalMatchingVersion: GOAL_MATCHING_VERSION,
    },
    methodology: {
      matchingVersion: THREE_WAY_MATCHING_VERSION,
      goalMatchingVersion: GOAL_MATCHING_VERSION,
      ordering: "每个来源文件按 source_row 递增，每场只使用此前记录",
      warmup: WARMUP,
      tuningFraction: 1 - VALIDATION_FRACTION,
      validationFraction: VALIDATION_FRACTION,
      selection:
        "仅在较早80%选择最低权重与衰减幂次，最新20%不参与选择",
      matching:
        "胜平负与让球胜平负复用生产联合匹配：两者齐全且联合池有样本时共同筛选，否则回退单市场；总进球固定由0球窗口和综合距离指数权重管理，不参与旧floor/power搜索",
      baseline:
        "以当前生产基础预测为基线；已通过门禁的平滑会同时应用于等权和距离加权概率",
      gate:
        "最新验证段 Log Loss、Brier 必须同时优于等权统计且命中率不得下降，并通过95%连续区块Bootstrap",
      significance:
        "最新20%按连续20场为区块重采样1,000次；Log Loss和Brier区间上界须小于0，命中率区间下界须不小于0",
      fallback:
        "候选无论是否通过都不自动上线；生产默认等权，只有独立批准文件同时确认概率门禁、ROI门禁和参数后才可启用",
      marketsIndependent: false,
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
  console.log(
    `已按行顺序分析胜平负 ${spfHistory.length.toLocaleString()} 场、` +
      `让球 ${hhadHistory.length.toLocaleString()} 场、` +
      `成对 ${pairedHistory.length.toLocaleString()} 场、` +
      `进球数 ${counts.goalHistory.toLocaleString()} 场`,
  );
  printMarket("胜平负", spf);
  printMarket("让球胜平负", hhad);
  printMarket("总进球", goals);
  console.log(`\n配置已写入：${OUTPUT_PATH}`);
} finally {
  store.close();
}
