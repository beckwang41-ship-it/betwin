// 一次性只读诊断：LogLoss/Brier 的改善在不同下界设定下由哪些场次贡献
import { createDataStore } from "../lib/database.mjs";
import { OUTCOME_LABELS } from "../lib/predictor.mjs";
import { smoothHistoricalDistribution } from "../lib/smoothing.mjs";
import {
  buildThreeWaySmoothingRows,
  createThreeWaySmoothingResolvers,
} from "../lib/three-way-smoothing.mjs";

const store = createDataStore(
  process.env.BETWIN_DATABASE_PATH || "betwin.db",
);
const WARMUP = 500;
const STRENGTH = 20;
const THRESHOLD = 0.07;
const FLOORS = [1e-12, 1e-6, 0.001, 0.01, 0.02, 0.05];

function rawDistribution(similar) {
  const counts = OUTCOME_LABELS.map(
    (label) => similar.filter((row) => String(row.result) === label).length,
  );
  const total = counts.reduce((sum, value) => sum + value, 0);
  return total
    ? counts.map((value) => value / total)
    : OUTCOME_LABELS.map(() => 0);
}

function laplace(similar, alpha) {
  const counts = OUTCOME_LABELS.map(
    (label) => similar.filter((row) => String(row.result) === label).length,
  );
  const total = counts.reduce((sum, value) => sum + value, 0);
  return counts.map((value) => (value + alpha) / (total + 3 * alpha));
}

function topScore(probabilities, actualIndex) {
  const highest = Math.max(...probabilities);
  const tied = probabilities.filter(
    (value) => Math.abs(value - highest) < 1e-12,
  ).length;
  return Math.abs(probabilities[actualIndex] - highest) < 1e-12 ? 1 / tied : 0;
}

export function collect(market, history) {
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
    const start = Math.max(WARMUP + 1, Math.floor(group.length * 0.8));
    for (let i = start; i < group.length; i += 1) {
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
      cases.push({
        raw,
        actualIndex,
        n: similar.length,
        sourceFile: group[i].sourceFile,
        order: target.sourceRow,
        shrink: smoothHistoricalDistribution(raw, similar.length, {
          enabled: true,
          validated: true,
          strength: STRENGTH,
          prior: priorDistribution,
        }).probabilities,
        alpha05: laplace(similar, 0.5),
        alpha1: laplace(similar, 1),
      });
    }
  }
  return cases;
}

function score(cases, key, floor) {
  let logLoss = 0;
  let brier = 0;
  let correct = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, s: 0 }));
  for (const item of cases) {
    const p = item[key];
    logLoss -= Math.log(Math.max(floor, p[item.actualIndex]));
    brier += p.reduce(
      (sum, value, index) =>
        sum + (value - (index === item.actualIndex ? 1 : 0)) ** 2,
      0,
    );
    const hit = topScore(p, item.actualIndex);
    correct += hit;
    const confidence = Math.max(...p);
    const bin = bins[Math.min(9, Math.max(0, Math.floor(confidence * 10)))];
    bin.n += 1;
    bin.p += confidence;
    bin.s += hit;
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
}

const history = store.getVerifiedHistory();
const f = (x) => Number(x).toFixed(4);
const sign = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(4)}`;

for (const market of ["spf", "hhad"]) {
  const cases = collect(market, history);
  const zero = cases.filter((c) => c.raw[c.actualIndex] <= 0);
  console.log(
    `\n======== ${market}  验证段 ${cases.length} 场，其中零概率命中 ${zero.length} 场`,
  );
  console.log("\n[A] LogLoss 随评估下界变化（基线=原始占比，候选=k=20收缩）");
  for (const floor of FLOORS) {
    const base = score(cases, "raw", floor);
    const shrink = score(cases, "shrink", floor);
    const baseZero = score(zero, "raw", floor);
    const shrinkZero = score(zero, "shrink", floor);
    const zeroContribution =
      ((shrinkZero.logLoss - baseZero.logLoss) * zero.length) / cases.length;
    const totalDelta = shrink.logLoss - base.logLoss;
    console.log(
      `  floor=${String(floor).padEnd(6)} 基线 ${f(base.logLoss)} → k20 ${f(shrink.logLoss)}  Δ${sign(totalDelta)}` +
        `   其中零概率${zero.length}场贡献 ${sign(zeroContribution)} (${((zeroContribution / totalDelta) * 100).toFixed(0)}%)`,
    );
  }
  console.log("\n[B] 三种方案对比（floor=0.01，避免 clamp 主导）");
  const rows = [
    ["原始占比(基线)", "raw"],
    ["k=20 市场先验收缩", "shrink"],
    ["Laplace α=0.5", "alpha05"],
    ["Laplace α=1", "alpha1"],
  ];
  const base = score(cases, "raw", 0.01);
  for (const [label, key] of rows) {
    const s = score(cases, key, 0.01);
    console.log(
      `  ${label.padEnd(20)} LogLoss ${f(s.logLoss)} (${sign(s.logLoss - base.logLoss)})  ` +
        `Brier ${f(s.brier)} (${sign(s.brier - base.brier)})  ` +
        `命中 ${f(s.accuracy)} (${sign(s.accuracy - base.accuracy)})  ` +
        `ECE ${f(s.ece)} (${sign(s.ece - base.ece)})`,
    );
  }
  console.log("\n[C] 剔除零概率命中场次后（floor=0.01）");
  const nonZero = cases.filter((c) => c.raw[c.actualIndex] > 0);
  const nzBase = score(nonZero, "raw", 0.01);
  for (const [label, key] of rows) {
    const s = score(nonZero, key, 0.01);
    console.log(
      `  ${label.padEnd(20)} LogLoss ${f(s.logLoss)} (${sign(s.logLoss - nzBase.logLoss)})  ` +
        `Brier ${f(s.brier)} (${sign(s.brier - nzBase.brier)})  ` +
        `命中 ${f(s.accuracy)} (${sign(s.accuracy - nzBase.accuracy)})  ` +
        `ECE ${f(s.ece)} (${sign(s.ece - nzBase.ece)})`,
    );
  }
}
store.close?.();
