import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import {
  classifyThreeWayOdds,
  segmentLabels,
  tuneSegmentThresholds,
} from "../lib/odds-segments.mjs";
import {
  OUTCOME_LABELS,
  spfDistance,
} from "../lib/predictor.mjs";
import { GOAL_MATCHING_VERSION } from "../lib/goal-zero-odds.mjs";
import { THREE_WAY_MATCHING_VERSION } from "../lib/three-way-matching.mjs";
import { FORMAL_PRODUCTION_THRESHOLDS } from "../lib/reliability-validation.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const OUTPUT_PATH =
  process.env.BETWIN_SEGMENT_CONFIG_PATH ||
  path.join(ROOT, "data", "segment-config.json");
const THRESHOLDS = {
  spf: [0.03, 0.05, 0.07, 0.1],
  hhad: [0.03, 0.05, 0.07, 0.1],
};

function common(row, sourceFile, sourceRow) {
  return {
    sourceFile,
    sourceRow,
    league: row.league,
    home: row.home,
    away: row.away,
  };
}

function spfRows(history) {
  return history.map((row) => ({
    ...common(row, row.spfSourceFile, row.spfSourceRow),
    result: row.spf.result,
    odds: row.spf.odds,
  }));
}

function hhadRows(history) {
  return history.map((row) => ({
    ...common(row, row.spfSourceFile, row.spfSourceRow),
    handicap: row.hhad.handicap,
    result: row.hhad.result,
    odds: row.hhad.odds,
  }));
}

function percent(value) {
  return (Number(value || 0) * 100).toFixed(2) + "%";
}

function thresholdText(value, market) {
  return market === "goals"
    ? (Number(value) * 100).toFixed(1) + "pp"
    : "±" + (Number(value) * 100).toFixed(0) + "%";
}

function printMarket(label, market, result) {
  console.log("\n" + label + "：" + result.enabledSegments + " 个类型通过验证");
  if (result.productionManaged) {
    console.log("- 不适用：" + result.gate.reason);
    return;
  }
  const metric = result.objective === "top-two" ? "topTwoCoverage" : "accuracy";
  for (const [segment, policy] of Object.entries(result.policies)) {
    if (!policy.selected) {
      console.log("- " + segment + "：保留全局范围；" + policy.gate.reason);
      continue;
    }
    const latest = policy.selected.validation;
    console.log(
      "- " +
        segment +
        "：" +
        thresholdText(policy.selected.threshold, market) +
        "，最新20% " +
        percent(latest.baseline[metric]) +
        " → " +
        percent(latest.candidate[metric]) +
        "，LogLoss差 " +
        latest.delta.logLoss.toFixed(4) +
        "；" +
        (policy.enabled ? "采用" : "不采用"),
    );
  }
}

const store = createDataStore(DATABASE_PATH);
try {
  const history = store.getVerifiedHistory();
  const counts = store.getCounts();
  const sourceUpdatedAt = store.getHistoricalSourceUpdatedAt();
  const productionThresholds = { ...FORMAL_PRODUCTION_THRESHOLDS };
  const commonOptions = {
    warmup: 500,
    validationFraction: 0.2,
    minimumTuningCases: 200,
    minimumValidationCases: 50,
  };
  const spf = tuneSegmentThresholds(spfRows(history), {
    ...commonOptions,
    segments: segmentLabels("spf"),
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    thresholds: THRESHOLDS.spf,
    baselineThreshold: productionThresholds.spf,
    segmenter: (row) => classifyThreeWayOdds(row.odds),
    distance: (left, right) => spfDistance(left.odds, right.odds),
    objective: "accuracy",
  });
  const hhad = tuneSegmentThresholds(hhadRows(history), {
    ...commonOptions,
    segments: segmentLabels("hhad"),
    labels: OUTCOME_LABELS,
    outcomeField: "result",
    thresholds: THRESHOLDS.hhad,
    baselineThreshold: productionThresholds.hhad,
    segmenter: (row) => classifyThreeWayOdds(row.odds),
    distance: (left, right) => spfDistance(left.odds, right.odds),
    compatible: (left, right) => left.handicap === right.handicap,
    objective: "accuracy",
  });
  const goals = {
    objective: "top-two",
    baselineThreshold: productionThresholds.goals,
    thresholds: [],
    policies: {},
    enabledSegments: 0,
    productionManaged: true,
    matchingVersion: GOAL_MATCHING_VERSION,
    gate: {
      passed: false,
      reason:
        "总进球固定使用0球赔率窗口与综合距离权重；旧八档概率阈值分组不再参与生产",
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
      thresholdSource: "locked-formal-production-rules",
      goalMatchingVersion: GOAL_MATCHING_VERSION,
    },
    methodology: {
      matchingVersion: THREE_WAY_MATCHING_VERSION,
      goalMatchingVersion: GOAL_MATCHING_VERSION,
      ordering: "每个来源文件按source_row逐场回测，每场只使用之前的数据",
      selection: "较早80%为每个赔率类型选范围，最新20%独立验证",
      gate: "目标指标、Log Loss、Brier同时改善且覆盖率不低于全局规则的98%",
      matching: "赔率类型只决定本场采用的误差范围；历史样本仍按实际赔率距离匹配，不要求类型相同",
      goals:
        "总进球旧阈值分段已停用；生产由固定0球赔率窗口和综合距离指数权重管理",
      fallback: "未通过验证的赔率类型继续使用当前全局范围和全部历史相似比赛",
      threeWaySegments: {
        "home-strong": "主胜去返还率概率至少55%",
        "home-edge": "主队概率比客队至少高8个百分点",
        balanced: "主客概率差小于8个百分点",
        "away-edge": "客队概率比主队至少高8个百分点",
        "away-strong": "客胜去返还率概率至少55%",
      },
      goalSegments: {
        low: "市场预期进球少于2.6",
        "mid-low": "市场预期进球2.6至2.9",
        "mid-high": "市场预期进球2.9至3.2",
        high: "市场预期进球至少3.2",
      },
    },
    productionThresholds,
    markets: { spf, hhad, goals },
  };
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log("已按赔率类型回测 " + history.length.toLocaleString() + " 场历史比赛");
  printMarket("胜平负", "spf", spf);
  printMarket("让球胜平负", "hhad", hhad);
  printMarket("总进球双选", "goals", goals);
  console.log("\n配置已写入：" + OUTPUT_PATH);
} finally {
  store.close();
}
