// 一次性只读诊断：动态相似范围（3%→5%→7% 阶梯）在新口径下
// 能否改善命中率与 ROI。
//
// 背景：data/adaptive-config.json 的 spf/hhad 候选已通过门禁，
// 但那份报告生成于 2026-08-26，早于防零层与 9003 场水位。
// 且原门禁只看命中率/LogLoss/Brier，没有看 ROI。
//
// 本脚本在同一批比赛上对比：
//   固定 ±7%   vs   阶梯 3%→5%→7%（样本不足才放宽）
// 两者都套防零层，与生产口径一致。
import { createDataStore } from "../lib/database.mjs";
import { OUTCOME_LABELS, spfDistance } from "../lib/predictor.mjs";
import { buildThreeWaySmoothingRows } from "../lib/three-way-smoothing.mjs";
import { applyZeroCellFloor } from "../lib/smoothing.mjs";

if (process.env.BETWIN_ALLOW_LEGACY_DIAGNOSTIC !== "1") {
  console.log(
    "该一次性脚本使用单市场独立匹配，不符合当前联合匹配与让球同盘口生产口径，已停止作为验证依据。\n" +
      "请运行：npm run model:tune-adaptive && npm run report:strategy-gates\n" +
      "如仅需复现旧实验，可显式设置 BETWIN_ALLOW_LEGACY_DIAGNOSTIC=1。",
  );
  process.exit(0);
}

const store = createDataStore(
  new URL("../betwin.db", import.meta.url).pathname,
);
const history = store.getVerifiedHistory();
const LADDER = [0.03, 0.05, 0.07];
const MIN_SAMPLES = 100;
const f = (x, d = 2) => Number(x).toFixed(d);

function harmonicMean(values) {
  if (!values.length) return null;
  return values.length / values.reduce((acc, value) => acc + 1 / value, 0);
}

function argmax(values) {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] > values[best]) best = i;
  }
  return best;
}

// 在给定容差下找相似比赛（等权，与生产一致）
function findSimilar(pool, targetOdds, market, tolerance) {
  const result = [];
  for (const row of pool) {
    const odds = row[market]?.odds;
    if (!Array.isArray(odds)) continue;
    if (spfDistance(odds, targetOdds) <= tolerance) result.push(row);
  }
  return result;
}

function evaluate(market, mode) {
  const rows = buildThreeWaySmoothingRows(history, market);
  const groups = new Map();
  for (const row of rows) {
    const key = row.sourceFile || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.sourceRow - right.sourceRow);
  }

  const picks = [];
  const thresholdUsed = new Map();
  for (const group of groups.values()) {
    const start = Math.max(501, Math.floor(group.length * 0.8));
    for (let i = start; i < group.length; i += 1) {
      const target = group[i];
      const actualIndex = OUTCOME_LABELS.indexOf(String(target.result));
      if (actualIndex < 0) continue;
      const targetOdds = target[market]?.odds;
      if (!Array.isArray(targetOdds)) continue;
      const earlier = group.slice(0, i);

      let similar = [];
      let used = 0.07;
      if (mode === "fixed") {
        similar = findSimilar(earlier, targetOdds, market, 0.07);
      } else {
        for (const tolerance of LADDER) {
          similar = findSimilar(earlier, targetOdds, market, tolerance);
          used = tolerance;
          if (similar.length >= MIN_SAMPLES) break;
        }
      }
      similar = similar.filter((row) =>
        OUTCOME_LABELS.includes(String(row.result)),
      );
      if (!similar.length) continue;
      thresholdUsed.set(used, (thresholdUsed.get(used) || 0) + 1);

      const counts = OUTCOME_LABELS.map(
        (label) => similar.filter((row) => String(row.result) === label).length,
      );
      const probabilities = applyZeroCellFloor(counts).probabilities;
      const top = argmax(probabilities);
      const odds = Number(targetOdds[top]);
      if (!Number.isFinite(odds) || odds <= 1) continue;

      picks.push({
        odds,
        probability: probabilities[top],
        won: top === actualIndex,
        samples: similar.length,
      });
    }
  }
  return { picks, thresholdUsed };
}

function summarize(label, picks) {
  const wins = picks.filter((pick) => pick.won);
  const hitRate = wins.length / picks.length;
  const modelProb =
    picks.reduce((sum, pick) => sum + pick.probability, 0) / picks.length;
  const breakEven = 1 / harmonicMean(picks.map((pick) => pick.odds));
  const roi = wins.reduce((sum, pick) => sum + pick.odds, 0) / picks.length - 1;
  const medianSamples = picks
    .map((pick) => pick.samples)
    .sort((a, b) => a - b)[Math.floor(picks.length / 2)];
  console.log(
    "  " + label.padEnd(20) +
      String(picks.length).padStart(6) +
      (f(modelProb * 100) + "%").padStart(10) +
      (f(hitRate * 100) + "%").padStart(10) +
      (f(breakEven * 100) + "%").padStart(9) +
      (f(roi * 100) + "%").padStart(10) +
      String(medianSamples).padStart(9),
  );
}

for (const market of ["spf", "hhad"]) {
  console.log("\n=== " + (market === "spf" ? "胜平负" : "让球胜平负") + " ===");
  console.log(
    "  口径                  场次  模型概率  真实命中   保本线       ROI  样本中位",
  );
  const fixed = evaluate(market, "fixed");
  summarize("固定 ±7%", fixed.picks);
  const adaptive = evaluate(market, "ladder");
  summarize("阶梯 3→5→7%", adaptive.picks);
  const ladderStats = [...adaptive.thresholdUsed.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, n]) => (t * 100).toFixed(0) + "%:" + n)
    .join("  ");
  console.log("    阶梯实际落点  " + ladderStats);
}
store.close?.();
