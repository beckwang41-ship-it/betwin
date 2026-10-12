import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { tuneGoalBandModel } from "../lib/goal-zero-odds.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const OUTPUT_PATH =
  process.env.BETWIN_GOAL_ZERO_REPORT_PATH ||
  path.join(ROOT, "data", "goal-zero-odds-report.json");
const LEGACY_TOLERANCE = 0.02;

function percentage(value) {
  return (Number(value || 0) * 100).toFixed(2) + "%";
}

function priceText(value, fallback) {
  return value === null ? fallback : Number(value).toFixed(2);
}

const store = createDataStore(DATABASE_PATH);
try {
  const history = store.getGoalHistory().map((row) => ({
    sourceFile: row.sourceFile,
    sourceRow: row.sourceRow,
    league: row.league,
    goals: row.goals,
    odds: row.odds,
  }));
  const sourceCounts = new Map();
  for (const row of history) {
    sourceCounts.set(row.sourceFile, (sourceCounts.get(row.sourceFile) || 0) + 1);
  }
  const [trainingSource, trainingRows] = [...sourceCounts.entries()]
    .sort((left, right) => right[1] - left[1])[0];
  const rows = history.filter((row) => row.sourceFile === trainingSource);
  console.warn(`旧研究协议：仅分析数据库来源 ${trainingSource} 的 ${trainingRows} 场，排除 ${history.length - trainingRows} 场；不是全库统计，不参与生产预测。`);
  const result = tuneGoalBandModel(rows, {
    legacyTolerance: LEGACY_TOLERANCE,
  });
  const report = {
    version: 1,
    reportOnly: true,
    affectsProduction: false,
    generatedAt: new Date().toISOString(),
    data: {
      database: path.basename(DATABASE_PATH),
      verifiedMatches: history.length,
      sourceUpdatedAt: store.getHistoricalSourceUpdatedAt(),
      trainingSource,
      trainingRows,
      excludedTrainingRows: history.length - trainingRows,
    },
    methodology: {
      purpose: "历史区间统计与旧模型对照；不参与网页生产预测",
      feature: "竞彩0球原始赔率",
      zeroOddsGate: "参照n52goalfx.py V7：历史0球赔率与本场绝对差不超过3.00",
      intervals: "五个固定区间仅用于按本场赔率环境选择七项距离策略，不作为相似赔率范围",
      distance: "通过0球±3.00门槛后，比较1球至7+球去水概率的最大绝对差",
      tuning: "中间20%为每个本场赔率环境选择七项赔率距离，未重复通过时仅使用0球±3.00近邻",
      validation: "最新20%只验证，不参与区间和距离选择",
      baseline: `原八档去水概率逐档最大差模型（${(LEGACY_TOLERANCE * 100).toFixed(1)}pp，仅作历史对照）`,
      production:
        "网页生产规则固定为全部联赛0球赔率±2.00、同联赛±2.50，并使用综合距离指数加权；本报告不能修改该规则",
    },
    statistics: result,
  };
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(
    `已使用数据库 ${trainingSource} 的 ${trainingRows.toLocaleString()} 场比赛生成0球赔率区间统计`,
  );
  console.log("注意：这是研究报告，不会改变网页生产预测规则");
  console.log(`使用 ${result.intervals.length} 个连续区间：`);
  for (const interval of result.intervals) {
    const leaders = Object.entries(interval.probabilities)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 2)
      .map(([label, probability]) => `${label}球 ${percentage(probability)}`)
      .join(" / ");
    console.log(
      `- ${interval.id}: ${priceText(interval.lower, "最低")} ～ ${priceText(interval.upper, "最高")}，` +
        `${interval.samples} 场，${result.policies[interval.id].enabled ? `0球±3.00且七项距离 ${(result.policies[interval.id].threshold * 100).toFixed(2)}pp` : "仅使用0球±3.00近邻"}，高频 ${leaders}`,
    );
  }
  const metric = (name, key) =>
    `${name} ${percentage(result.validation.legacy[key])} → ${percentage(result.validation.candidate[key])}`;
  console.log(
    `最新20%：${metric("双选覆盖率", "topTwoCoverage")}；` +
      `LogLoss ${result.validation.legacy.logLoss.toFixed(4)} → ${result.validation.candidate.logLoss.toFixed(4)}；` +
      `Brier ${result.validation.legacy.brier.toFixed(4)} → ${result.validation.candidate.brier.toFixed(4)}`,
  );
  console.log(`${result.enabled ? "旧候选通过" : "旧候选未通过"}：${result.gate.reason}`);
  console.log(`统计报告已写入：${OUTPUT_PATH}`);
} finally {
  store.close();
}
