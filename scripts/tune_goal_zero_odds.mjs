import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { tuneGoalBandModel } from "../lib/goal-zero-odds.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const MODEL_CONFIG_PATH = path.join(ROOT, "data", "model-config.json");
const OUTPUT_PATH =
  process.env.BETWIN_GOAL_ZERO_CONFIG_PATH ||
  path.join(ROOT, "data", "goal-zero-odds-config.json");

function baselineTolerance() {
  try {
    const config = JSON.parse(readFileSync(MODEL_CONFIG_PATH, "utf8"));
    const value = Number(config.markets?.goals?.threshold);
    return Number.isFinite(value) && value > 0 ? value : 0.02;
  } catch {
    return 0.02;
  }
}

function percentage(value) {
  return (Number(value || 0) * 100).toFixed(2) + "%";
}

function priceText(value, fallback) {
  return value === null ? fallback : Number(value).toFixed(2);
}

const store = createDataStore(DATABASE_PATH);
try {
  const history = store.getVerifiedHistory().map((row) => ({
    sourceFile: row.goalSourceFile,
    sourceRow: row.goalSourceRow,
    league: row.league,
    goals: row.goals,
    odds: row.goalMarket.odds,
  }));
  const sourceCounts = new Map();
  for (const row of history) {
    sourceCounts.set(row.sourceFile, (sourceCounts.get(row.sourceFile) || 0) + 1);
  }
  const [trainingSource, trainingRows] = [...sourceCounts.entries()]
    .sort((left, right) => right[1] - left[1])[0];
  const rows = history.filter((row) => row.sourceFile === trainingSource);
  const result = tuneGoalBandModel(rows, {
    legacyTolerance: baselineTolerance(),
  });
  const config = {
    version: 2,
    generatedAt: new Date().toISOString(),
    data: {
      database: path.basename(DATABASE_PATH),
      verifiedMatches: history.length,
      sourceUpdatedAt: store.getSourceUpdatedAt(),
      trainingSource,
      trainingRows,
      excludedTrainingRows: history.length - trainingRows,
    },
    methodology: {
      feature: "竞彩0球原始赔率",
      intervals: "0球赔率固定分为五个连续且不重叠的进球环境区间",
      distance: "区间内比较1球至7+球去水概率的最大绝对差，不再用0球赔率计算距离",
      tuning: "中间20%为每个区间选择七项赔率距离，未重复通过的区间使用整段历史",
      validation: "最新20%只验证，不参与区间和距离选择",
      baseline: "原八档去水概率逐档最大差模型",
    },
    model: result,
  };
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(
    `已使用 ${trainingSource} 的 ${trainingRows.toLocaleString()} 场比赛学习0球赔率区间`,
  );
  console.log(`使用 ${result.intervals.length} 个连续区间：`);
  for (const interval of result.intervals) {
    const leaders = Object.entries(interval.probabilities)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 2)
      .map(([label, probability]) => `${label}球 ${percentage(probability)}`)
      .join(" / ");
    console.log(
      `- ${interval.id}: ${priceText(interval.lower, "最低")} ～ ${priceText(interval.upper, "最高")}，` +
        `${interval.samples} 场，${result.policies[interval.id].enabled ? `七项距离 ${(result.policies[interval.id].threshold * 100).toFixed(2)}pp` : "使用整段历史"}，高频 ${leaders}`,
    );
  }
  const metric = (name, key) =>
    `${name} ${percentage(result.validation.legacy[key])} → ${percentage(result.validation.candidate[key])}`;
  console.log(
    `最新20%：${metric("双选覆盖率", "topTwoCoverage")}；` +
      `LogLoss ${result.validation.legacy.logLoss.toFixed(4)} → ${result.validation.candidate.logLoss.toFixed(4)}；` +
      `Brier ${result.validation.legacy.brier.toFixed(4)} → ${result.validation.candidate.brier.toFixed(4)}`,
  );
  console.log(`${result.enabled ? "已通过" : "未通过"}：${result.gate.reason}`);
  console.log(`配置已写入：${OUTPUT_PATH}`);
} finally {
  store.close();
}
