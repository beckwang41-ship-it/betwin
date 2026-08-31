// 一次性只读诊断：区分门禁翻转是"数据更新"还是"判据本身不稳定"
// 手法一：用旧水位（截断到 sourceRow 上限）复现配置时的门禁结果
// 手法二：固定数据，只换 bootstrap 随机种子，看 accuracy.lower 的分布
import { createDataStore } from "../lib/database.mjs";
import { OUTCOME_LABELS } from "../lib/predictor.mjs";
import { smoothHistoricalDistribution } from "../lib/smoothing.mjs";
import {
  blockBootstrapComparison,
  classificationDelta,
} from "../lib/significance.mjs";
import {
  buildThreeWaySmoothingRows,
  createThreeWaySmoothingResolvers,
} from "../lib/three-way-smoothing.mjs";

const store = createDataStore("betwin.db");
const STRENGTH = 20;
const THRESHOLD = 0.07;

function ratio(similar) {
  const counts = OUTCOME_LABELS.map(
    (label) => similar.filter((row) => String(row.result) === label).length,
  );
  const total = counts.reduce((sum, value) => sum + value, 0);
  return total
    ? counts.map((value) => value / total)
    : OUTCOME_LABELS.map(() => 0);
}

function collect(market, history, limitRows) {
  const rows = buildThreeWaySmoothingRows(history, market);
  const resolvers = createThreeWaySmoothingResolvers(market, {
    spfTolerance: THRESHOLD,
    hhadTolerance: THRESHOLD,
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
  const deltas = [];
  let evaluated = 0;
  for (const [sourceFile, full] of groups) {
    const group = limitRows ? full.slice(0, limitRows[sourceFile] ?? full.length) : full;
    const start = Math.max(501, Math.floor(group.length * 0.8));
    for (let i = start; i < group.length; i += 1) {
      const target = group[i];
      const actualIndex = OUTCOME_LABELS.indexOf(String(target.result));
      if (actualIndex < 0) continue;
      const prior = group.slice(0, i);
      const similar = resolvers
        .sampleResolver(target, prior)
        .filter((row) => OUTCOME_LABELS.includes(String(row.result)));
      if (!similar.length) continue;
      const raw = ratio(similar);
      const priorDistribution = resolvers.priorResolver(prior, target, {
        labels: OUTCOME_LABELS,
        outcomeField: "result",
        threshold: THRESHOLD,
        relaxedMultiplier: 2,
        minLocalizedSamples: 30,
      });
      const shrink = smoothHistoricalDistribution(raw, similar.length, {
        enabled: true,
        validated: true,
        strength: STRENGTH,
        prior: priorDistribution,
      }).probabilities;
      evaluated += 1;
      deltas.push(
        classificationDelta(shrink, raw, actualIndex, {
          sourceFile,
          order: target.sourceRow,
        }),
      );
    }
  }
  return { deltas, evaluated };
}

// 与 lib/smoothing-tuning.mjs 的 accuracyMargin 默认值保持一致。
const ACCURACY_MARGIN = -0.005;

function verdict(metrics, margin = ACCURACY_MARGIN) {
  const epsilon = 1e-10;
  if (!metrics) return "无数据";
  return metrics.logLoss.upper < -epsilon &&
    metrics.brier.upper < -epsilon &&
    metrics.accuracy.lower >= margin - epsilon
    ? "通过"
    : "未通过";
}

const history = store.getVerifiedHistory();
const f = (x) => Number(x).toFixed(6);

console.log("【实验一】固定当前数据，只换 bootstrap 随机种子");
const SEEDS = [20260727, 1, 42, 777, 12345, 99999, 20250101, 31337];
for (const market of ["spf", "hhad"]) {
  const { deltas, evaluated } = collect(market, history);
  console.log(`\n  ${market}  n=${evaluated}`);
  const lowers = [];
  for (const seed of SEEDS) {
    const result = blockBootstrapComparison(deltas, { seed });
    const m = result.metrics;
    lowers.push(m.accuracy.lower);
    console.log(
      `    seed=${String(seed).padStart(9)}  accuracy.lower ${f(m.accuracy.lower).padStart(10)}  ` +
        `upper ${f(m.accuracy.upper).padStart(9)}  → ${verdict(m)}`,
    );
  }
  const min = Math.min(...lowers);
  const max = Math.max(...lowers);
  const passCount = lowers.filter((x) => x >= ACCURACY_MARGIN - 1e-10).length;
  const strictPassCount = lowers.filter((x) => x >= -1e-10).length;
  console.log(
    `    → accuracy.lower 跨种子范围 [${f(min)}, ${f(max)}]，跨度 ${f(max - min)}\n` +
      `      非劣界限 ${ACCURACY_MARGIN}：${passCount}/${SEEDS.length} 通过` +
      `　｜　旧判据 >= 0：${strictPassCount}/${SEEDS.length} 通过`,
  );
}

console.log("\n\n【实验二】把数据截断回配置时的水位（lsspfpl 8120 行）");
for (const market of ["spf", "hhad"]) {
  const limits = { "lsspfpl.xlsx": 8120 };
  const { deltas, evaluated } = collect(market, history, limits);
  const result = blockBootstrapComparison(deltas);
  const m = result.metrics;
  console.log(
    `  ${market}  n=${evaluated}  accuracy.lower ${f(m.accuracy.lower)}  ` +
      `logLoss.upper ${f(m.logLoss.upper)}  brier.upper ${f(m.brier.upper)}  → ${verdict(m)}`,
  );
}
store.close?.();
