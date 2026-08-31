// 只读报告：按正式可靠性训练的同一匹配、切分和筛选口径计算投注 ROI。
// 用法：npm run report:reliability-roi
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import {
  buildThreeWayReliabilityObservations,
  reliabilityRuleMatches,
} from "../lib/reliability-tuning.mjs";
import { FORMAL_PRODUCTION_THRESHOLDS } from "../lib/reliability-validation.mjs";
import {
  blockBootstrapStrategyComparison,
  pairedStrategyCase,
  strategyOutcome,
  summarizeStrategy,
} from "../lib/strategy-evaluation.mjs";
import { buildThreeWayEvents } from "../lib/three-way-backtest.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const CONFIG_PATH =
  process.env.BETWIN_RELIABILITY_CONFIG_PATH ||
  path.join(ROOT, "data", "reliability-config.json");
const WARMUP = 500;

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const percent = (value) =>
  value === null || value === undefined
    ? "n/a"
    : `${(value * 100).toFixed(2)}%`;

function selectedStakeDescription(rows) {
  let stakeUnits = 0;
  let winningUnits = 0;
  let oddsSum = 0;
  let impliedSum = 0;
  for (const row of rows) {
    const outcome = strategyOutcome(
      row.probabilities,
      row.odds,
      row.actualIndex,
    );
    if (outcome.noPrediction) continue;
    stakeUnits += outcome.stakeUnits;
    winningUnits += outcome.won ? 1 : 0;
    for (const index of outcome.selected) {
      oddsSum += row.odds[index];
      impliedSum += 1 / row.odds[index];
    }
  }
  return {
    stakeUnits,
    perStakeHitRate: stakeUnits ? winningUnits / stakeUnits : null,
    averageSelectedOdds: stakeUnits ? oddsSum / stakeUnits : null,
    averageSelectedBreakeven: stakeUnits ? impliedSum / stakeUnits : null,
  };
}

function unflaggedSummary(rows, rule) {
  const cases = rows
    .filter((row) => !reliabilityRuleMatches(row, rule))
    .map((row) =>
      pairedStrategyCase(
        row.probabilities,
        null,
        row.odds,
        row.actualIndex,
        { sourceFile: row.sourceFile, order: row.order },
      ),
    );
  return summarizeStrategy(cases, "candidate");
}

const store = createDataStore(DATABASE_PATH);
try {
  const events = buildThreeWayEvents({
    spfHistory: store.getSpfHistory(),
    hhadHistory: store.getHhadHistory(),
    pairedHistory: store.getPairedSpfHhadHistory(),
  });

  for (const market of ["spf", "hhad"]) {
    const node = config.markets?.[market];
    const rule = node?.rule;
    if (!rule) continue;

    const built = buildThreeWayReliabilityObservations(
      events,
      market,
      FORMAL_PRODUCTION_THRESHOLDS,
      { warmup: WARMUP },
    );
    // 与 tuneReliabilityPolicy 一致：先保留无样本目标切 60/20/20，
    // 再在每个时间段内部统计 available 与 selected。
    const observations = built.observations.filter((row) =>
      Number.isFinite(row.correct),
    );
    const testStart = Math.floor(observations.length * 0.8);
    const test = observations.slice(testStart);
    const available = test.filter((row) => row.available);
    const flagged = available.filter((row) =>
      reliabilityRuleMatches(row, rule),
    );

    const expectedTargets = Number(node.test?.targets);
    const expectedSelected = Number(node.test?.selected);
    if (
      Number.isFinite(expectedTargets) &&
      (test.length !== expectedTargets || flagged.length !== expectedSelected)
    ) {
      throw new Error(
        `${market} ROI报告与可靠性配置口径不一致：` +
          `期望测试${expectedTargets}场/筛选${expectedSelected}场，` +
          `实际测试${test.length}场/筛选${flagged.length}场`,
      );
    }

    // 候选策略只在“重点参考”场下注；基线策略在同一批可预测比赛全部下注。
    const cases = available.map((row) =>
      pairedStrategyCase(
        reliabilityRuleMatches(row, rule) ? row.probabilities : null,
        row.probabilities,
        row.odds,
        row.actualIndex,
        { sourceFile: row.sourceFile, order: row.order },
      ),
    );
    const strategy = blockBootstrapStrategyComparison(cases);
    const unflagged = unflaggedSummary(available, rule);
    const stakeView = selectedStakeDescription(flagged);

    console.log(`\n===== ${market} 重点参考规则 门禁=${node.gate?.passed}`);
    console.log(
      `规则：最高概率 ≥ ${percent(rule.minTopProbability)}，` +
        `领先第二名 ≥ ${percent(rule.minMargin)}，范围 ±${percent(rule.threshold)}`,
    );
    console.log(
      `最新20%共 ${test.length} 场，可预测 ${available.length} 场，` +
        `被标记 ${flagged.length} 场（覆盖 ${percent(flagged.length / available.length)}）`,
    );
    console.log(
      `标记策略单注命中率 ${percent(stakeView.perStakeHitRate)}；` +
        `平均所选赔率 ${stakeView.averageSelectedOdds?.toFixed(2) || "n/a"}；` +
        `平均单注隐含保本率 ${percent(stakeView.averageSelectedBreakeven)}`,
    );
    console.log(
      `标记策略 ROI ${percent(strategy.candidate.roi)} ` +
        `（95%区间 ${percent(strategy.intervals?.candidate.lower)} ～ ${percent(strategy.intervals?.candidate.upper)}；` +
        `注数 ${strategy.candidate.stakeUnits}）`,
    );
    console.log(
      `全部可预测场 ROI ${percent(strategy.baseline.roi)}；` +
        `标记策略差值 ${percent(strategy.roiDelta)} ` +
        `（95%区间 ${percent(strategy.intervals?.delta.lower)} ～ ${percent(strategy.intervals?.delta.upper)}；` +
        `结论 ${strategy.status}）`,
    );
    console.log(
      `未标记 ${unflagged.bettingMatches} 场 ROI ${percent(unflagged.roi)}`,
    );
  }

  console.log(
    "\n说明：平均单注隐含保本率只描述所选赔率，不与命中率直接相减；是否盈利以按实际赔率和注数计算的ROI及其区间为准。",
  );
  console.log(
    "当前最新20%已参与规则选择后的复核，只能作为离线诊断，不是新的独立前瞻证据。",
  );
} finally {
  store.close();
}
