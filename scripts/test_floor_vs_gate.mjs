// 一次性只读诊断：防零层进入基线后，生产平滑的增量还剩多少。
// 背景：防零层已在 predictSpf/predictGoals 无条件生效，但
// lib/smoothing-tuning.mjs 的基线仍是裸占比。这会让门禁把
// 「防零带来的改善」错记在生产平滑账上，高估平滑的增量。
// 这里对比两种基线口径下的候选增量。
import { createDataStore } from "../lib/database.mjs";
import { OUTCOME_LABELS } from "../lib/predictor.mjs";
import {
  buildThreeWaySmoothingRows,
  createThreeWaySmoothingResolvers,
} from "../lib/three-way-smoothing.mjs";
import {
  applyZeroCellFloor,
  smoothHistoricalDistribution,
} from "../lib/smoothing.mjs";
import { blockBootstrapComparison, classificationDelta } from "../lib/significance.mjs";

const store = createDataStore(
  new URL("../betwin.db", import.meta.url).pathname,
);
const history = store.getVerifiedHistory();
const STRENGTH = 20;
const MARGIN = -0.005;
const f = (x, d = 4) => Number(x).toFixed(d);

function verdict(metrics) {
  if (!metrics) return "无数据";
  return metrics.logLoss.upper < 0 &&
    metrics.brier.upper < 0 &&
    metrics.accuracy.lower >= MARGIN
    ? "通过"
    : "未通过";
}

for (const market of ["spf", "hhad"]) {
  const rows = buildThreeWaySmoothingRows(history, market);
  const resolvers = createThreeWaySmoothingResolvers(market, {
    spfTolerance: 0.07,
    hhadTolerance: 0.07,
  });
  const groups = new Map();
  for (const row of rows) {
    const key = row.sourceFile || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.sourceRow - right.sourceRow);
  }

  // 旧口径：基线 = 裸占比；新口径：基线 = 防零后的分布
  const oldDeltas = [];
  const newDeltas = [];

  for (const group of groups.values()) {
    const start = Math.max(501, Math.floor(group.length * 0.8));
    for (let i = start; i < group.length; i += 1) {
      const target = group[i];
      const actualIndex = OUTCOME_LABELS.indexOf(String(target.result));
      if (actualIndex < 0) continue;
      const earlier = group.slice(0, i);
      const similar = resolvers
        .sampleResolver(target, earlier)
        .filter((row) => OUTCOME_LABELS.includes(String(row.result)));
      if (!similar.length) continue;

      const counts = OUTCOME_LABELS.map(
        (label) => similar.filter((row) => String(row.result) === label).length,
      );
      const total = similar.length;
      const rawBaseline = counts.map((count) => count / total);
      const flooredBaseline = applyZeroCellFloor(counts).probabilities;

      const prior = resolvers.priorResolver(earlier, target, {
        labels: OUTCOME_LABELS,
        outcomeField: "result",
        threshold: 0.07,
        relaxedMultiplier: 2,
        minLocalizedSamples: 30,
      });

      const meta = { sourceFile: target.sourceFile, order: target.sourceRow };
      // 旧口径：平滑作用在裸占比上，与裸占比比较
      const smoothedFromRaw = smoothHistoricalDistribution(rawBaseline, total, {
        enabled: true,
        validated: true,
        strength: STRENGTH,
        prior,
      }).probabilities;
      oldDeltas.push(
        classificationDelta(smoothedFromRaw, rawBaseline, actualIndex, meta),
      );
      // 新口径：平滑作用在防零后的分布上，与防零后的分布比较
      const smoothedFromFloor = smoothHistoricalDistribution(
        flooredBaseline,
        total,
        { enabled: true, validated: true, strength: STRENGTH, prior },
      ).probabilities;
      newDeltas.push(
        classificationDelta(
          smoothedFromFloor,
          flooredBaseline,
          actualIndex,
          meta,
        ),
      );
    }
  }

  console.log("\n=== " + market + "  n=" + oldDeltas.length + " ===");
  for (const [label, deltas] of [
    ["旧口径 基线=裸占比", oldDeltas],
    ["新口径 基线=防零后", newDeltas],
  ]) {
    const result = blockBootstrapComparison(deltas, { accuracyMargin: MARGIN });
    const m = result.metrics;
    console.log("  " + label);
    console.log(
      "    命中率 delta " + f(m.accuracy.delta, 6) +
        "  区间 [" + f(m.accuracy.lower, 6) + ", " + f(m.accuracy.upper, 6) + "]",
    );
    console.log(
      "    LogLoss delta " + f(m.logLoss.delta) +
        "  上界 " + f(m.logLoss.upper) +
        "　｜　Brier delta " + f(m.brier.delta) +
        "  上界 " + f(m.brier.upper),
    );
    console.log("    → " + verdict(m));
  }
}
store.close?.();
