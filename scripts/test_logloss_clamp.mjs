// 一次性只读诊断：验证平滑带来的 LogLoss 改善有多少来自零概率截断
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
const CLAMP = 1e-12;

function rawDistribution(similar) {
  const counts = OUTCOME_LABELS.map(
    (label) => similar.filter((row) => String(row.result) === label).length,
  );
  const total = counts.reduce((sum, value) => sum + value, 0);
  return total ? counts.map((value) => value / total) : OUTCOME_LABELS.map(() => 0);
}

function analyze(market, history) {
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

  const stats = {
    evaluated: 0,
    zeroHit: 0,
    baseLogLoss: 0,
    smoothLogLoss: 0,
    baseLogLossNonZero: 0,
    smoothLogLossNonZero: 0,
    nonZeroCount: 0,
    baseBrier: 0,
    smoothBrier: 0,
    baseCorrect: 0,
    smoothCorrect: 0,
  };

  for (const group of groups.values()) {
    const validationStart = Math.max(
      WARMUP + 1,
      Math.floor(group.length * (1 - VALIDATION_FRACTION)),
    );
    for (
      let targetIndex = validationStart;
      targetIndex < group.length;
      targetIndex += 1
    ) {
      const target = group[targetIndex];
      const actualIndex = OUTCOME_LABELS.indexOf(String(target.result));
      if (actualIndex < 0) continue;
      const prior = group.slice(0, targetIndex);
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

      const isZero = raw[actualIndex] <= 0;
      stats.evaluated += 1;
      if (isZero) stats.zeroHit += 1;
      const bl = -Math.log(Math.max(CLAMP, raw[actualIndex]));
      const sl = -Math.log(Math.max(CLAMP, smooth[actualIndex]));
      stats.baseLogLoss += bl;
      stats.smoothLogLoss += sl;
      if (!isZero) {
        stats.nonZeroCount += 1;
        stats.baseLogLossNonZero += bl;
        stats.smoothLogLossNonZero += sl;
      }
      stats.baseBrier += raw.reduce(
        (sum, value, index) =>
          sum + (value - (index === actualIndex ? 1 : 0)) ** 2,
        0,
      );
      stats.smoothBrier += smooth.reduce(
        (sum, value, index) =>
          sum + (value - (index === actualIndex ? 1 : 0)) ** 2,
        0,
      );
      const topOf = (probabilities) => {
        const highest = Math.max(...probabilities);
        const tied = probabilities.filter(
          (value) => Math.abs(value - highest) < 1e-12,
        ).length;
        return Math.abs(probabilities[actualIndex] - highest) < 1e-12
          ? 1 / tied
          : 0;
      };
      stats.baseCorrect += topOf(raw);
      stats.smoothCorrect += topOf(smooth);
    }
  }
  return stats;
}

const history = store.getVerifiedHistory();
for (const market of ["spf", "hhad"]) {
  const s = analyze(market, history);
  const f = (x) => Number(x).toFixed(4);
  console.log(`\n=== ${market} 验证段 n=${s.evaluated}`);
  console.log(
    `实际结果落在零概率格的场次：${s.zeroHit} (${((s.zeroHit / s.evaluated) * 100).toFixed(2)}%)`,
  );
  console.log(
    `全样本 LogLoss  基线 ${f(s.baseLogLoss / s.evaluated)} → 平滑 ${f(s.smoothLogLoss / s.evaluated)}  (Δ ${f((s.smoothLogLoss - s.baseLogLoss) / s.evaluated)})`,
  );
  console.log(
    `剔除零概率场次后 (n=${s.nonZeroCount}) LogLoss 基线 ${f(s.baseLogLossNonZero / s.nonZeroCount)} → 平滑 ${f(s.smoothLogLossNonZero / s.nonZeroCount)}  (Δ ${f((s.smoothLogLossNonZero - s.baseLogLossNonZero) / s.nonZeroCount)})`,
  );
  console.log(
    `Brier  基线 ${f(s.baseBrier / s.evaluated)} → 平滑 ${f(s.smoothBrier / s.evaluated)}  (Δ ${f((s.smoothBrier - s.baseBrier) / s.evaluated)})`,
  );
  console.log(
    `命中率 基线 ${f(s.baseCorrect / s.evaluated)} → 平滑 ${f(s.smoothCorrect / s.evaluated)}  (Δ ${f((s.smoothCorrect - s.baseCorrect) / s.evaluated)})`,
  );
}
store.close?.();
