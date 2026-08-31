import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import {
  buildGoalReliabilityObservation,
  buildThreeWayReliabilityObservations,
  tuneReliabilityPolicy,
} from "../lib/reliability-tuning.mjs";
import {
  GOAL_MATCHING_VERSION,
  GOAL_ZERO_ODDS_TOLERANCE,
} from "../lib/goal-zero-odds.mjs";
import { selectProductionGoalSimilarity } from "../lib/goal-production.mjs";
import { THREE_WAY_MATCHING_VERSION } from "../lib/three-way-matching.mjs";
import { buildThreeWayEvents } from "../lib/three-way-backtest.mjs";
import {
  FORMAL_PRODUCTION_PROBABILITY_POLICY,
  FORMAL_PRODUCTION_THRESHOLDS,
} from "../lib/reliability-validation.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const OUTPUT_PATH =
  process.env.BETWIN_RELIABILITY_CONFIG_PATH ||
  path.join(ROOT, "data", "reliability-config.json");
const WARMUP = 500;

function dominantSource(rows) {
  const counts = new Map();
  for (const row of rows) {
    counts.set(row.sourceFile, (counts.get(row.sourceFile) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
}

function rowsNearZeroOdds(priceBuckets, targetZeroOdds, tolerance) {
  const rows = [];
  for (const [price, bucket] of priceBuckets) {
    if (Math.abs(price - targetZeroOdds) <= tolerance) rows.push(...bucket);
  }
  return rows;
}

function buildGoalObservations(rows, thresholds) {
  const [sourceFile, sourceRows] = dominantSource(rows);
  const ordered = rows
    .filter((row) => row.sourceFile === sourceFile)
    .sort((left, right) => left.sourceRow - right.sourceRow);
  const priceBuckets = new Map();
  const observations = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const target = ordered[index];
    const targetZeroOdds = Number(target.odds?.[0]);
    if (index >= WARMUP && Number.isFinite(targetZeroOdds)) {
      const candidates = rowsNearZeroOdds(
        priceBuckets,
        targetZeroOdds,
        GOAL_ZERO_ODDS_TOLERANCE,
      );
      const resolved = selectProductionGoalSimilarity(candidates, {
        odds: target.odds,
        initialOdds: target.initialOdds,
      }, {
        zeroOddsTolerance: GOAL_ZERO_ODDS_TOLERANCE,
      });
      observations.push(
        buildGoalReliabilityObservation(target, resolved.similar, {
          bandwidth: resolved.weighting?.bandwidth || 1,
          weightingMethod:
            resolved.weighting?.method ||
            "exponential-composite-distance",
        }),
      );
      if (observations.length % 1000 === 0) {
        console.log(
          `总进球可靠性回测：${observations.length.toLocaleString()} / ${(ordered.length - WARMUP).toLocaleString()}`,
        );
      }
    }
    if (Number.isFinite(targetZeroOdds)) {
      if (!priceBuckets.has(targetZeroOdds)) {
        priceBuckets.set(targetZeroOdds, []);
      }
      priceBuckets.get(targetZeroOdds).push(target);
    }
  }
  return { sourceFile, sourceRows, observations };
}

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function printPolicy(label, policy) {
  console.log(`\n${label}`);
  console.log(
    `${policy.enabled ? "门禁通过" : "门禁未通过"}：${policy.gate.reason}`,
  );
  if (!policy.test) return;
  console.log(
    `最新20%：筛选 ${policy.test.selected.toLocaleString()} 场 / 覆盖 ${percent(policy.test.coverage)} / ` +
      `命中 ${percent(policy.test.baselineAccuracy)} → ${percent(policy.test.selectedAccuracy)} / ` +
      `提升 ${percent(policy.test.accuracyLift)}`,
  );
  console.log(
    `95%提升区间 ${percent(policy.testSignificance.accuracyLift.lower)} ～ ${percent(policy.testSignificance.accuracyLift.upper)}`,
  );
}

const store = createDataStore(DATABASE_PATH);
try {
  const counts = store.getCounts();
  const sourceUpdatedAt = store.getHistoricalSourceUpdatedAt();
  const thresholds = { ...FORMAL_PRODUCTION_THRESHOLDS };
  const events = buildThreeWayEvents({
    spfHistory: store.getSpfHistory(),
    hhadHistory: store.getHhadHistory(),
    pairedHistory: store.getPairedSpfHhadHistory(),
  });
  const spfRows = buildThreeWayReliabilityObservations(
    events,
    "spf",
    thresholds,
    { warmup: WARMUP },
  );
  const hhadRows = buildThreeWayReliabilityObservations(
    events,
    "hhad",
    thresholds,
    { warmup: WARMUP },
  );
  const goalRows = buildGoalObservations(
    store.getGoalHistory(),
    thresholds,
  );
  const spf = tuneReliabilityPolicy(spfRows.observations, {
    threshold: thresholds.spf,
  });
  const hhad = tuneReliabilityPolicy(hhadRows.observations, {
    threshold: thresholds.hhad,
  });
  const goals = tuneReliabilityPolicy(goalRows.observations, {
    threshold: thresholds.goals,
  });
  const config = {
    version: 1,
    generatedAt: new Date().toISOString(),
    data: {
      database: path.basename(DATABASE_PATH),
      verifiedMatches: counts.verifiedHistory,
      sourceUpdatedAt,
      matchingVersion: THREE_WAY_MATCHING_VERSION,
      goalMatchingVersion: GOAL_MATCHING_VERSION,
      probabilityPolicy: FORMAL_PRODUCTION_PROBABILITY_POLICY,
      thresholds,
      thresholdSource: "locked-formal-production-rules",
    },
    methodology: {
      ordering: "选择记录最多的历史来源，按 source_row 递增；每场只读取此前记录",
      warmup: WARMUP,
      split: "前60%选择规则、中间20%验证、最新20%最终测试",
      matching: "SPF/HHAD复用生产联合优先与联合零样本回退；只训练全部联赛口径",
      probability:
        `与生产一致使用 ${FORMAL_PRODUCTION_PROBABILITY_POLICY}；三项盘和总进球均先应用总先验质量1.5的保序防零`,
      gate: "训练提升至少3%；中间20%提升至少3%；最新20%提升至少2%，且两段连续20场区块Bootstrap的95%提升下界不低于0",
      goals: "复用生产0球赔率±2.00窗口；全部合格样本按终赔60%、初赔15%、走势15%、隐含进球10%的综合距离指数加权；四档样本池方向用于稳定性筛选",
    },
    sources: {
      spf: { file: spfRows.sourceFile, rows: spfRows.sourceRows },
      hhad: { file: hhadRows.sourceFile, rows: hhadRows.sourceRows },
      goals: { file: goalRows.sourceFile, rows: goalRows.sourceRows },
    },
    markets: { spf, hhad, goals },
  };
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(
    `已生成可靠性观察：SPF ${spfRows.observations.length.toLocaleString()} / HHAD ${hhadRows.observations.length.toLocaleString()} / Goals ${goalRows.observations.length.toLocaleString()}`,
  );
  printPolicy("胜平负可靠性", spf);
  printPolicy("让球胜平负可靠性", hhad);
  printPolicy("总进球可靠性", goals);
  console.log(`\n配置已写入：${OUTPUT_PATH}`);
} finally {
  store.close();
}
