// 一次性只读诊断：对比「防零」方案在验证段的效果。
// 背景：test_zero_cells.mjs 显示模型报 0% 的格子实际发生率 14.6%~17.6%，
// 这会让 LogLoss 被 clamp 极端惩罚，也让用户按虚高概率下注。
// 对比五种方案：
//   A 基线            —— 原始历史占比，不做任何处理
//   B Jeffreys α=0.5  —— 对称 Laplace 平滑，(c+α)/(n+3α)
//   C 生产平滑 k=20    —— 已通过门禁的市场先验收缩
//   D 固定先验质量      —— 总质量 1.5，均匀分配到三个结果
//   E 历史先验质量      —— 总质量 1.5，按历史先验概率分配
// 关键约束：防零不能改变 argmax（该押哪一边），否则就不只是校准问题。
import { createDataStore } from "../lib/database.mjs";
import { OUTCOME_LABELS } from "../lib/predictor.mjs";
import {
  buildThreeWaySmoothingRows,
  createThreeWaySmoothingResolvers,
} from "../lib/three-way-smoothing.mjs";
import { smoothHistoricalDistribution } from "../lib/smoothing.mjs";

const store = createDataStore(
  new URL("../betwin.db", import.meta.url).pathname,
);
const history = store.getVerifiedHistory();
const ALPHA = 0.5;
const STRENGTH = 20;
// 生产实现改用「总先验质量固定」参数化：alpha = priorMass / k。
// 三分类下 priorMass=1 等价于 alpha=1/3，比经典 Jeffreys(0.5) 略弱。
const PRIOR_MASS = 1.5;
const f = (x, d = 4) => Number(x).toFixed(d);

function jeffreys(counts, total) {
  const denominator = total + OUTCOME_LABELS.length * ALPHA;
  return counts.map((count) => (count + ALPHA) / denominator);
}

function priorMassFloor(counts, total) {
  const alpha = PRIOR_MASS / OUTCOME_LABELS.length;
  const denominator = total + PRIOR_MASS;
  return counts.map((count) => (count + alpha) / denominator);
}

function historicalPriorMassFloor(counts, total, priorProbabilities) {
  const denominator = total + PRIOR_MASS;
  return counts.map(
    (count, i) => (count + PRIOR_MASS * priorProbabilities[i]) / denominator,
  );
}

function logLoss(probabilities, actualIndex) {
  return -Math.log(Math.max(1e-12, probabilities[actualIndex]));
}

function brier(probabilities, actualIndex) {
  return probabilities.reduce(
    (sum, value, index) => sum + (value - (index === actualIndex ? 1 : 0)) ** 2,
    0,
  );
}

function argmax(probabilities) {
  let best = 0;
  for (let i = 1; i < probabilities.length; i += 1) {
    if (probabilities[i] > probabilities[best]) best = i;
  }
  return best;
}

function accumulator() {
  return { n: 0, hit: 0, logLoss: 0, brier: 0, argmaxChanged: 0, zeroCells: 0 };
}

function record(acc, probabilities, actualIndex, baseArgmax) {
  acc.n += 1;
  if (argmax(probabilities) === actualIndex) acc.hit += 1;
  acc.logLoss += logLoss(probabilities, actualIndex);
  acc.brier += brier(probabilities, actualIndex);
  if (baseArgmax !== null && argmax(probabilities) !== baseArgmax) {
    acc.argmaxChanged += 1;
  }
  acc.zeroCells += probabilities.filter((p) => p <= 0).length;
}

function summarize(label, acc) {
  return (
    "  " + label.padEnd(20) + " n=" + acc.n +
    "  命中率 " + f((acc.hit / acc.n) * 100, 2) + "%" +
    "  LogLoss " + f(acc.logLoss / acc.n) +
    "  Brier " + f(acc.brier / acc.n) +
    "  零格 " + acc.zeroCells +
    "  argmax变动 " + acc.argmaxChanged
  );
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

  const accs = {
    A: accumulator(),
    B: accumulator(),
    C: accumulator(),
    D: accumulator(),
    E: accumulator(),
  };
  // 高概率档专项：模型报 >=0.75 的场次，实际命中多少
  const highProb = {
    A: { n: 0, hit: 0, predicted: 0 },
    B: { n: 0, hit: 0, predicted: 0 },
    C: { n: 0, hit: 0, predicted: 0 },
    D: { n: 0, hit: 0, predicted: 0 },
    E: { n: 0, hit: 0, predicted: 0 },
  };

  for (const group of groups.values()) {
    const start = Math.max(501, Math.floor(group.length * 0.8));
    for (let i = start; i < group.length; i += 1) {
      const target = group[i];
      const actualIndex = OUTCOME_LABELS.indexOf(String(target.result));
      if (actualIndex < 0) continue;
      const similar = resolvers
        .sampleResolver(target, group.slice(0, i))
        .filter((row) => OUTCOME_LABELS.includes(String(row.result)));
      if (!similar.length) continue;

      const counts = OUTCOME_LABELS.map(
        (label) => similar.filter((row) => String(row.result) === label).length,
      );
      const total = similar.length;
      const baseline = counts.map((count) => count / total);
      const baseArgmax = argmax(baseline);

      const prior = resolvers.priorResolver(group.slice(0, i), target, {
        labels: OUTCOME_LABELS,
        outcomeField: "result",
        threshold: 0.07,
        relaxedMultiplier: 2,
        minLocalizedSamples: 30,
      });
      const production = smoothHistoricalDistribution(baseline, total, {
        enabled: true,
        validated: true,
        strength: STRENGTH,
        prior,
      }).probabilities;

      const variants = {
        A: baseline,
        B: jeffreys(counts, total),
        C: production,
        D: priorMassFloor(counts, total),
        E: historicalPriorMassFloor(counts, total, prior.probabilities),
      };
      for (const [key, probabilities] of Object.entries(variants)) {
        record(
          accs[key],
          probabilities,
          actualIndex,
          key === "A" ? null : baseArgmax,
        );
        const top = argmax(probabilities);
        if (probabilities[top] >= 0.75) {
          highProb[key].n += 1;
          highProb[key].predicted += probabilities[top];
          if (top === actualIndex) highProb[key].hit += 1;
        }
      }
    }
  }

  console.log("\n=== " + market + " ===");
  console.log(summarize("A 基线（原始占比）", accs.A));
  console.log(summarize("B Jeffreys a=" + ALPHA, accs.B));
  console.log(summarize("C 生产平滑 k=" + STRENGTH, accs.C));
  console.log(summarize("D 均匀总质量=" + PRIOR_MASS, accs.D));
  console.log(summarize("E 历史先验质量=" + PRIOR_MASS, accs.E));

  console.log("\n  高概率档（模型报 >=75%）实际表现：");
  for (const [key, label] of [
    ["A", "A 基线"],
    ["B", "B Jeffreys"],
    ["C", "C 生产平滑"],
    ["D", "D 均匀总质量=1.5"],
    ["E", "E 历史先验=1.5"],
  ]) {
    const h = highProb[key];
    if (!h.n) {
      console.log("    " + label.padEnd(14) + " 无样本");
      continue;
    }
    const predicted = (h.predicted / h.n) * 100;
    const actual = (h.hit / h.n) * 100;
    console.log(
      "    " + label.padEnd(14) + String(h.n).padStart(4) + " 场" +
        "  宣称 " + f(predicted, 2) + "%" +
        "  实际 " + f(actual, 2) + "%" +
        "  虚高 " + f(predicted - actual, 2) + "pp",
    );
  }
}
store.close?.();
