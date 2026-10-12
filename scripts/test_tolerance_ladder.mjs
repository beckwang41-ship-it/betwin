import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_PATH = process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");

const LABELS = ["胜", "平", "负"];
const WARMUP = 500;
const LADDER = [0.07, 0.10, 0.15, 0.20];
const MIN_SAMPLES_TARGET = Number(process.env.MIN_SAMPLES || 20);

function spfDistance(historyOdds, targetOdds) {
  return Math.max(
    ...historyOdds.map((odd, i) => Math.abs(Number(odd) / Number(targetOdds[i]) - 1)),
  );
}

function loadRows() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT source_file, source_row, league, result,
              final_home_odds AS h, final_draw_odds AS d, final_away_odds AS a
         FROM historical_spf
        WHERE final_home_odds IS NOT NULL
          AND final_draw_odds IS NOT NULL
          AND final_away_odds IS NOT NULL
          AND result IN ('胜','平','负')
        ORDER BY source_file, source_row`,
    )
    .all();
  db.close();
  return rows;
}

function pickMainSource(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.source_file, (counts.get(r.source_file) || 0) + 1);
  let best = null;
  for (const [file, n] of counts) if (!best || n > best.n) best = { file, n };
  return best;
}

function distribution(pool) {
  const counts = [0, 0, 0];
  for (const row of pool) counts[LABELS.indexOf(row.result)] += 1;
  const total = pool.length;
  return { counts, total, probs: counts.map((c) => (total ? c / total : 0)) };
}

function argmaxLabel(probs) {
  let best = 0;
  for (let i = 1; i < 3; i += 1) if (probs[i] > probs[best]) best = i;
  const tie = probs.filter((p) => Math.abs(p - probs[best]) < 1e-12).length > 1;
  return { label: LABELS[best], index: best, tie };
}

function evaluate(rows, strategy) {
  const stats = new Map();
  const bump = (key, hit, samples, tolUsed) => {
    if (!stats.has(key)) stats.set(key, { n: 0, hit: 0, samples: 0, tolSum: 0, skipped: 0 });
    const s = stats.get(key);
    s.n += 1;
    s.hit += hit ? 1 : 0;
    s.samples += samples;
    s.tolSum += tolUsed;
    return s;
  };
  let skipped = 0;
  let evaluated = 0;
  let hits = 0;
  let sampleSum = 0;
  let tolSum = 0;

  for (let i = WARMUP; i < rows.length; i += 1) {
    const target = rows[i];
    const targetOdds = [target.h, target.d, target.a];
    const earlier = rows.slice(0, i);
    const outcome = strategy(earlier, targetOdds);
    if (!outcome) {
      skipped += 1;
      continue;
    }
    const { probs, total, tolerance } = outcome;
    const { label, tie } = argmaxLabel(probs);
    if (tie) {
      skipped += 1;
      continue;
    }
    evaluated += 1;
    if (label === target.result) hits += 1;
    sampleSum += total;
    tolSum += tolerance;
    const bucket =
      total < 5 ? "1-4场" : total < 20 ? "5-19场" : total < 50 ? "20-49场" : total < 100 ? "50-99场" : "100场+";
    bump(bucket, label === target.result, total, tolerance);
  }
  return {
    evaluated,
    hits,
    skipped,
    accuracy: evaluated ? hits / evaluated : 0,
    avgSamples: evaluated ? sampleSum / evaluated : 0,
    avgTolerance: evaluated ? tolSum / evaluated : 0,
    coverage: evaluated / (evaluated + skipped),
    buckets: stats,
  };
}

function fixedStrategy(tolerance, minSamples) {
  return (earlier, targetOdds) => {
    const pool = earlier.filter(
      (row) => spfDistance([row.h, row.d, row.a], targetOdds) <= tolerance,
    );
    if (pool.length < minSamples) return null;
    const dist = distribution(pool);
    return { probs: dist.probs, total: dist.total, tolerance };
  };
}

function ladderStrategy(target, minSamples) {
  return (earlier, targetOdds) => {
    for (const tolerance of LADDER) {
      const pool = earlier.filter(
        (row) => spfDistance([row.h, row.d, row.a], targetOdds) <= tolerance,
      );
      if (pool.length >= target) {
        const dist = distribution(pool);
        return { probs: dist.probs, total: dist.total, tolerance };
      }
    }
    const widest = LADDER[LADDER.length - 1];
    const pool = earlier.filter(
      (row) => spfDistance([row.h, row.d, row.a], targetOdds) <= widest,
    );
    if (pool.length < minSamples) return null;
    const dist = distribution(pool);
    return { probs: dist.probs, total: dist.total, tolerance: widest };
  };
}

function report(name, res) {
  const pct = (v) => `${(100 * v).toFixed(1)}%`;
  console.log(
    `${name.padEnd(34)} 出手=${String(res.evaluated).padStart(5)} 覆盖=${pct(res.coverage).padStart(6)} 命中=${pct(res.accuracy).padStart(6)} 均样本=${res.avgSamples.toFixed(0).padStart(5)} 均阈值=${pct(res.avgTolerance).padStart(6)}`,
  );
}

const all = loadRows();
const main = pickMainSource(all);
const rows = all.filter((r) => r.source_file === main.file);
console.warn("旧研究协议：仅分析数据库中样本最多的单一来源，不是全库阈值结论；全库批次回测请用 backtest:rolling。");
console.log(`数据库: ${DB_PATH}`);
console.log(`主时间序列来源: ${main.file}，共 ${rows.length} 场（warmup ${WARMUP}）`);
console.log(`评估口径: 严格只使用 source_row 更早的记录；并列方向记为不出手\n`);

console.log("=== A. 固定阈值（当前生产 = ±7%，最少1场）===");
for (const tol of LADDER) {
  report(`固定 ±${(100 * tol).toFixed(0)}% / 最少1场`, evaluate(rows, fixedStrategy(tol, 1)));
}

console.log("\n=== B. 固定 ±7% + 提高最少样本门槛（不预测低样本）===");
for (const min of [1, 5, 10, 20, 30]) {
  report(`±7% / 最少${min}场`, evaluate(rows, fixedStrategy(0.07, min)));
}

console.log(`\n=== C. 阶梯放宽（目标${MIN_SAMPLES_TARGET}场：7%→10%→15%→20%）===`);
for (const target of [10, 20, 30, 50]) {
  report(`阶梯至${target}场 / 兜底最少5场`, evaluate(rows, ladderStrategy(target, 5)));
}

console.log("\n=== D. 最优候选的样本量分层命中率 ===");
const best = ladderStrategy(20, 5);
const res = evaluate(rows, best);
const order = ["1-4场", "5-19场", "20-49场", "50-99场", "100场+"];
for (const key of order) {
  const s = res.buckets.get(key);
  if (!s) continue;
  console.log(
    `   ${key.padEnd(9)} n=${String(s.n).padStart(5)} 命中=${(100 * s.hit / s.n).toFixed(1).padStart(5)}% 均阈值=${(100 * s.tolSum / s.n).toFixed(1)}%`,
  );
}
