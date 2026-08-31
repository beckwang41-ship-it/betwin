import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const OUTPUT_PATH =
  process.env.BETWIN_STRATEGY_GATE_REPORT_PATH ||
  path.join(ROOT, "data", "strategy-gate-report.json");

function load(name) {
  return JSON.parse(readFileSync(path.join(ROOT, "data", name), "utf8"));
}

function strategyView(strategy) {
  if (!strategy) return null;
  return {
    status: strategy.status,
    passed: Boolean(strategy.passed),
    positiveEdge: Boolean(strategy.positiveEdge),
    evaluated: strategy.evaluated,
    candidate: strategy.candidate,
    baseline: strategy.baseline,
    roiDelta: strategy.roiDelta,
    intervals: strategy.intervals,
    improvementProbability: strategy.improvementProbability,
    reason:
      strategy.status === "uncertain"
        ? "候选相对基线的ROI提升区间包含0"
        : strategy.reason,
  };
}

function adaptiveView(value = {}) {
  return {
    probabilityGatePassed: Boolean(value.gate?.passed),
    selectedMinimumSamples: value.selected?.minSamples ?? null,
    selectedStrategy: strategyView(value.selected?.strategy),
    bettingPromotionEligible: Boolean(
      value.gate?.passed && value.selected?.strategy?.passed,
    ),
    candidates: (value.candidates || []).map((candidate) => ({
      minSamples: candidate.minSamples,
      selected: candidate.minSamples === value.selected?.minSamples,
      strategy: strategyView(candidate.strategy),
    })),
  };
}

function movementView(value = {}) {
  return {
    probabilityGatePassed: Boolean(value.gate?.passed),
    selectedWeight: value.selected?.baseline
      ? 0
      : value.selected?.weight ?? null,
    selectedStrategy: strategyView(value.selected?.strategy),
    bettingPromotionEligible: Boolean(
      value.gate?.passed && value.selected?.strategy?.passed,
    ),
    candidates: (value.candidates || []).map((candidate) => ({
      weight: candidate.weight,
      selected:
        !value.selected?.baseline &&
        candidate.weight === value.selected?.weight,
      strategy: strategyView(candidate.strategy),
    })),
  };
}

function weightingView(value = {}) {
  return {
    probabilityGatePassed: Boolean(value.gate?.passed),
    selectedParameters: value.selected
      ? {
          floor: value.selected.floor ?? 1,
          power: value.selected.power ?? 1,
          coreRatio: 0.5,
        }
      : null,
    selectedStrategy: strategyView(value.selected?.strategy),
    bettingPromotionEligible: Boolean(
      value.gate?.passed && value.selected?.strategy?.passed,
    ),
    candidates: (value.candidates || []).map((candidate) => ({
      floor: candidate.floor,
      power: candidate.power,
      selected:
        candidate.floor === value.selected?.floor &&
        candidate.power === value.selected?.power,
      strategy: strategyView(candidate.strategy),
    })),
  };
}

const adaptive = load("adaptive-config.json");
const weighting = load("weighting-config.json");
const movement = load("movement-config.json");
const store = createDataStore(DATABASE_PATH);
try {
  const counts = store.getCounts();
  const sourceUpdatedAt = store.getHistoricalSourceUpdatedAt();
  const artifactCurrent = (config) =>
    config.data?.verifiedMatches === counts.verifiedHistory &&
    config.data?.sourceUpdatedAt === sourceUpdatedAt;
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    reportOnly: true,
    affectsProduction: false,
    data: {
      database: path.basename(DATABASE_PATH),
      verifiedMatches: counts.verifiedHistory,
      sourceUpdatedAt,
    },
    methodology: {
      separation:
        "概率质量门禁与投注策略门禁分别报告；负ROI不否定概率模型，ROI改善也不能绕过概率门禁",
      accounting:
        "按模型并列首选的覆盖数量计成本；覆盖全部结果视为无预测；回报使用目标比赛对应终赔",
      comparison:
        "候选与固定生产基线只比较同一批验证比赛，按来源文件和source_row保持时间顺序",
      uncertainty:
        "最新20%采用连续20场区块Bootstrap 1,000次；ROI差值区间整体高于0才通过投注门禁",
      positiveEdge:
        "只有候选ROI自身95%区间下界高于0才标记正收益证据；当前验证段已被反复查看，不能当未来独立证明",
      production:
        "本报告只提供离线证据，任何候选通过后仍需新的前瞻样本和用户明确批准",
    },
    artifacts: {
      adaptive: {
        generatedAt: adaptive.generatedAt,
        current: artifactCurrent(adaptive),
      },
      weighting: {
        generatedAt: weighting.generatedAt,
        current: artifactCurrent(weighting),
      },
      movement: {
        generatedAt: movement.generatedAt,
        current: artifactCurrent(movement),
      },
    },
    modules: {
      adaptive: Object.fromEntries(
        ["spf", "hhad", "goals"].map((market) => [
          market,
          adaptiveView(adaptive.markets?.[market]),
        ]),
      ),
      weighting: Object.fromEntries(
        ["spf", "hhad", "goals"].map((market) => [
          market,
          weightingView(weighting.markets?.[market]),
        ]),
      ),
      movement: Object.fromEntries(
        ["spf", "hhad", "goals"].map((market) => [
          market,
          movementView(movement.markets?.[market]),
        ]),
      ),
    },
  };
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`投注策略门禁报告已写入：${OUTPUT_PATH}`);
  for (const moduleName of ["adaptive", "weighting", "movement"]) {
    for (const market of ["spf", "hhad", "goals"]) {
      const value = report.modules[moduleName][market];
      if (!value.selectedStrategy) continue;
      console.log(
        `${moduleName}/${market}：概率门禁${
          value.probabilityGatePassed ? "通过" : "未通过"
        }；投注门禁${value.selectedStrategy.passed ? "通过" : "未通过"}；` +
          `ROI差值 ${(value.selectedStrategy.roiDelta * 100).toFixed(2)}pp`,
      );
    }
  }
} finally {
  store.close();
}
