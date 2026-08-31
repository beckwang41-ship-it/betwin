// 一次性只读诊断：按样本量分层，分解平滑对各指标的改善来源
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { OUTCOME_LABELS } from "../lib/predictor.mjs";
import { smoothHistoricalDistribution } from "../lib/smoothing.mjs";
import {
  buildThreeWaySmoothingRows,
  createThreeWaySmoothingResolvers,
} from "../lib/three-way-smoothing.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const store = createDataStore(
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db"),
);
const WARMUP = 500;
const VALIDATION_FRACTION = 0.2;
const STRENGTH = 20;
const THRESHOLD = 0.07;

function rawDistribution(similar) {
  const counts = OUTCOME_LABELS.map(
    (label) => similar.filter((row) => String(row.result) === label).length,
  );
  const total = counts.reduce((sum, value) => sum + value, 0);
  return total
    ? counts.map((value) => value / total)
    : OUTCOME_LABELS.map(() => 0);
}

function topScore(probabilities, actualIndex) {
  const highest = Math.max(...probabilities);
  const tied = probabilities.filter(
    (value) => Math.abs(value - highest) < 1e-12,
  ).length;
  return Math.abs(probabilities[actualIndex] - highest) < 1e-12 ? 1 / tied : 0;
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
  const cases = [];
  for (const group of groups.values()) {
    const validationStart = Math.max(
      WARMUP + 1,
      Math.floor(group.length * (1 - VALIDATION_FRACTION)),
    );
    for (let i = validationStart; i < group.length; i += 1) {
      const target = group[i];
      const actualIndex = OUTCOME_LABELS.indexOf(String(target.result));
      if (actualIndex < 0) continue;
      const prior = group.slice(0, i);
      const similar = resolvers
        .sampleResolver(target, prior)
        .filter((row) => OUTCOME_LABELS.includes(String(row.result)));
      if (!similar.length) continue;
      const raw = rawDistribution(similar);
      const priorDistribution = resolvers.priorResolver(prior, target, {
        labels: OUTCOME_LABELS,
        outcomeField: "result",
        threshold: THRESHOLD,
        relaxedMultiplier: 2,
        minLocalizedSamples: 30,
      });
      const smooth = smoothHistoricalDistribution(raw, similar.length, {
        enabled: true,
        validated: true,
        strength: STRENGTH,
        prior: priorDistribution,
      }).probabilities;
      cases.push({ raw, smooth, actualIndex, n: similar.length });
    }
  }
  return cases;
}

function metrics(cases) {
  if (!cases.length) return null;
  const acc = (key) => {
    let logLoss = 0;
    let brier = 0;
    let correct = 0;
    const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, s: 0 }));
    for (const item of cases) {
      const p = item[key];
      logLoss -= Math.log(Math.max(1e-12, p[item.actualIndex]));
      brier += p.reduce(
        (sum, value, index) =>
          sum + (value - (index === item.actualIndex ? 1 : 0)) ** 2,
        0,
      );
      const score = topScore(p, item.actualIndex);
      correct += score;
      const confidence = Math.max(...p);
      const bin = bins[Math.min(9, Math.max(0, Math.floor(confidence * 10)))];
      bin.n += 1;
      bin.p += confidence;
      bin.s += score;
    }
    let ece = 0;
    for (const bin of bins) {
      if (!bin.n) continue;
      ece += (bin.n / cases.length) * Math.abs(bin.p / bin.n - bin.s / bin.n);
    }
    return {
      logLoss: logLoss / cases.length,
      brier: brier / cases.length,
      accuracy: correct / cases.length,
      ece,
    };
  };
  return { n: cases.length, baseline: acc("raw"), smooth: acc("smooth") };
}

function show(label, result) {
  if (!result) {
    console.log(`  ${label}: 无样本`);
    return;
  }
  const f = (x) => Number(x).toFixed(4);
  const d = (a, b) => {
    const v = b - a;
    return `${v >= 0 ? "+" : ""}${v.toFixed(4)}`;
  };
  const b = result.baseline;
  const s = result.smooth;
  console.log(
    `  ${label.padEnd(16)} n=${String(result.n).padStart(5)}  ` +
      `LogLoss ${f(b.logLoss)}→${f(s.logLoss)} (${d(b.logLoss, s.logLoss)})  ` +
      `Brier ${f(b.brier)}→${f(s.brier)} (${d(b.brier, s.brier)})  ` +
      `命中 ${f(b.accuracy)}→${f(s.accuracy)} (${d(b.accuracy, s.accuracy)})  ` +
      `ECE ${f(b.ece)}→${f(s.ece)} (${d(b.ece, s.ece)})`,
  );
}

const history = store.getVerifiedHistory();
for (const market of ["spf", "hhad"]) {
  const cases = collect(market, history);
  console.log(`\n=== ${market} 验证段总计 ${cases.length} 场`);
  show("全样本", metrics(cases));
  show("零概率场次", metrics(cases.filter((c) => c.raw[c.actualIndex] <= 0)));
  show("非零概率场次", metrics(cases.filter((c) => c.raw[c.actualIndex] > 0)));
  console.log("  --- 按相似样本量分层 ---");
  const tiers = [
    ["n<=3", (c) => c.n <= 3],
    ["4<=n<=10", (c) => c.n >= 4 && c.n <= 10],
    ["11<=n<=30", (c) => c.n >= 11 && c.n <= 30],
    ["31<=n<=100", (c) => c.n >= 31 && c.n <= 100],
    ["n>100", (c) => c.n > 100],
  ];
  for (const [label, filter] of tiers) {
    show(label, metrics(cases.filter(filter)));
  }
}
store.close?.();
