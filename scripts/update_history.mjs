import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import {
  FORMAL_PRODUCTION_PROBABILITY_POLICY,
  FORMAL_PRODUCTION_THRESHOLDS,
  reliabilityValidationIsCurrent,
} from "../lib/reliability-validation.mjs";
import {
  GOAL_MATCHING_VERSION,
} from "../lib/goal-zero-odds.mjs";
import { THREE_WAY_MATCHING_VERSION } from "../lib/three-way-matching.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH = process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const RELIABILITY_CONFIG_PATH =
  process.env.BETWIN_RELIABILITY_CONFIG_PATH ||
  path.join(ROOT, "data", "reliability-config.json");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 执行失败（退出码 ${result.status}）`);
  }
}

function readReliabilityConfig() {
  try {
    return JSON.parse(readFileSync(RELIABILITY_CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

run(process.env.PYTHON || "python3", ["scripts/import_sqlite.py"]);

const store = createDataStore(DATABASE_PATH);
let current = false;
try {
  const counts = store.getCounts();
  current = reliabilityValidationIsCurrent(readReliabilityConfig(), {
    verifiedMatches: counts.verifiedHistory,
    sourceUpdatedAt: store.getHistoricalSourceUpdatedAt(),
    matchingVersion: THREE_WAY_MATCHING_VERSION,
    goalMatchingVersion: GOAL_MATCHING_VERSION,
    probabilityPolicy: FORMAL_PRODUCTION_PROBABILITY_POLICY,
    thresholds: FORMAL_PRODUCTION_THRESHOLDS,
  });
} finally {
  store.close();
}

if (current) {
  console.log("正式规则验证仍然有效，已跳过重复时间滚动验证。");
} else {
  console.log("历史数据发生变化，开始重跑正式规则时间滚动验证……");
  run(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "scripts/tune_reliability.mjs",
  ]);
}

console.log("轻量历史更新完成：未运行高级调参、研究报告、随机森林或全量测试。");
