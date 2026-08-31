// 一次性只读诊断：验证门禁显著性区间对少数零概率场次的依赖程度
// 手法：不删除任何场次，而是给零概率场次的原始占比套一个概率地板后重跑显著性
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

const store = createDataStore(
  process.env.BETWIN_DATABASE_PATH || "betwin.db",
);
const STRENGTH = 20;
const THRESHOLD = 0.07;

function counts(similar) {
  return OUTCOME_LABELS.map(
    (label) => similar.filter((row) => String(row.result) === label).length,
  );
}

function laplace(c, alpha) {
  const total = c.reduce((sum, value) => sum + value, 0);
  return c.map((value) => (value + alpha) / (total + 3 * alpha));
}

function ratio(c) {
  const total = c.reduce((sum, value) => sum + value, 0);
  return total ? c.map((value) => value / total) : c.map(() => 0);
}

function collect(market, history) {
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
  const out = [];
  for (const [sourceFile, group] of groups) {
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
      const c = counts(similar);
      const raw = ratio(c);
      const priorDistribution = resolvers.priorResolver(prior, target, {
        labels: OUTCOME_LABELS,
        outcomeField: "result",
        threshold: THRESHOLD,
        relaxedMultiplier: 2,
        minLocalizedSamples: 30,
      });
      out.push({
        sourceFile,
        order: target.sourceRow,
        actualIndex,
        raw,
        alpha05: laplace(c, 0.5),
        alpha1: laplace(c, 1),
        shrink: smoothHistoricalDistribution(raw, similar.length, {
          enabled: true,
          validated: true,
          strength: STRENGTH,
          prior: priorDistribution,
        }).probabilities,
      });
    }
  }
  return out;
}

function gate(cases, candidateKey, baselineKey) {
  const deltas = cases.map((item) =>
    classificationDelta(item[candidateKey], item[baselineKey], item.actualIndex, {
      sourceFile: item.sourceFile,
      order: item.order,
    }),
  );
  const result = blockBootstrapComparison(deltas);
  const epsilon = 1e-10;
  const m = result.metrics;
  const passed =
    m &&
    m.logLoss.upper < -epsilon &&
    m.brier.upper < -epsilon &&
    m.accuracy.lower >= -epsilon;
  return { result, passed };
}

const history = store.getVerifiedHistory();
const f = (x) => (x === null || x === undefined ? "  null  " : Number(x).toFixed(4));

for (const market of ["spf", "hhad"]) {
  const cases = collect(market, history);
  console.log(`\n======== ${market}  n=${cases.length}`);
  const scenarios = [
    ["k=20 vs 原始占比（现状门禁）", "shrink", "raw"],
    ["k=20 vs Laplace α=0.5 基线", "shrink", "alpha05"],
    ["k=20 vs Laplace α=1 基线", "shrink", "alpha1"],
    ["Laplace α=1 vs 原始占比", "alpha1", "raw"],
  ];
  for (const [label, candidate, baseline] of scenarios) {
    const { result, passed } = gate(cases, candidate, baseline);
    const m = result.metrics || {};
    console.log(`\n  ${label}  → ${passed ? "通过" : "未通过"}`);
    for (const key of ["accuracy", "logLoss", "brier"]) {
      const d = m[key];
      if (!d) continue;
      console.log(
        `    ${key.padEnd(9)} lower ${f(d.lower)}  upper ${f(d.upper)}  p=${d.improvementProbability}`,
      );
    }
  }
}
store.close?.();
