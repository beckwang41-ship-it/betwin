import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_PATH = process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const LABELS = ["胜", "平", "负"];
const WARMUP = 500;
const TOL = 0.07;
const STRENGTHS = [0, 5, 10, 20, 40];

function spfDistance(o, t) {
  return Math.max(...o.map((v, i) => Math.abs(Number(v) / Number(t[i]) - 1)));
}

function marketPrior(odds) {
  const bases = [0.862, 0.899, 0.88];
  const raw = odds.map((odd, i) => {
    const v = Number(odd);
    let rtp = bases[i];
    if (v > 4.5) rtp = 0.815;
    else if (v < 1.5) rtp = 0.902;
    return rtp / v;
  });
  const total = raw.reduce((s, v) => s + v, 0);
  return total > 0 ? raw.map((v) => v / total) : [1 / 3, 1 / 3, 1 / 3];
}

function loadRows() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT source_file, source_row, result,
              final_home_odds AS h, final_draw_odds AS d, final_away_odds AS a
         FROM historical_spf
        WHERE final_home_odds IS NOT NULL AND final_draw_odds IS NOT NULL
          AND final_away_odds IS NOT NULL AND result IN ('胜','平','负')
        ORDER BY source_file, source_row`,
    )
    .all();
  db.close();
  const counts = new Map();
  for (const r of rows) counts.set(r.source_file, (counts.get(r.source_file) || 0) + 1);
  let best = null;
  for (const [f, n] of counts) if (!best || n > best.n) best = { file: f, n };
  return rows.filter((r) => r.source_file === best.file);
}

const rows = loadRows();
console.log(`数据库: ${DB_PATH}`);
console.log(`主时间序列 ${rows.length} 场，warmup ${WARMUP}，阈值 ±${(100 * TOL).toFixed(0)}%`);
console.log(`口径：严格只用 source_row 更早的记录；平滑公式 (n*p + k*prior)/(n+k)\n`);

const cases = [];
for (let i = WARMUP; i < rows.length; i += 1) {
  const t = rows[i];
  const target = [t.h, t.d, t.a];
  const counts = [0, 0, 0];
  let total = 0;
  for (let j = 0; j < i; j += 1) {
    const r = rows[j];
    if (spfDistance([r.h, r.d, r.a], target) <= TOL) {
      counts[LABELS.indexOf(r.result)] += 1;
      total += 1;
    }
  }
  if (!total) continue;
  cases.push({
    counts,
    total,
    prior: marketPrior(target),
    actual: LABELS.indexOf(t.result),
  });
}
console.log(`可评估样本 ${cases.length} 场\n`);

function metrics(strength) {
  let n = 0;
  let hits = 0;
  let logLoss = 0;
  let brier = 0;
  const buckets = new Map();
  for (const c of cases) {
    const probs = c.counts.map(
      (cnt, i) => (cnt + strength * c.prior[i]) / (c.total + strength),
    );
    let top = 0;
    for (let i = 1; i < 3; i += 1) if (probs[i] > probs[top]) top = i;
    const tie = probs.filter((p) => Math.abs(p - probs[top]) < 1e-12).length > 1;
    if (tie) continue;
    n += 1;
    if (top === c.actual) hits += 1;
    const p = Math.min(1 - 1e-15, Math.max(1e-15, probs[c.actual]));
    logLoss += -Math.log(p);
    brier += probs.reduce((s, v, i) => s + (v - (i === c.actual ? 1 : 0)) ** 2, 0);
    const pt = probs[top];
    const key =
      pt < 0.4 ? "1 <40%" : pt < 0.5 ? "2 40-50%" : pt < 0.6 ? "3 50-60%" : pt < 0.75 ? "4 60-75%" : "5 >=75%";
    if (!buckets.has(key)) buckets.set(key, { n: 0, hit: 0, sum: 0 });
    const b = buckets.get(key);
    b.n += 1;
    b.hit += top === c.actual ? 1 : 0;
    b.sum += pt;
  }
  return { n, accuracy: hits / n, logLoss: logLoss / n, brier: brier / n, buckets };
}

console.log("=== 平滑强度 k 对方向命中率与概率准确度的影响 ===");
console.log("k        出手   命中率    LogLoss    Brier   最大校准偏差");
const results = new Map();
for (const k of STRENGTHS) {
  const m = metrics(k);
  results.set(k, m);
  let worst = 0;
  for (const b of m.buckets.values()) {
    if (b.n < 30) continue;
    worst = Math.max(worst, Math.abs(b.hit / b.n - b.sum / b.n));
  }
  console.log(
    `${String(k).padEnd(6)} ${String(m.n).padStart(6)} ${(100 * m.accuracy).toFixed(1).padStart(6)}% ${m.logLoss.toFixed(4).padStart(9)} ${m.brier.toFixed(4).padStart(8)} ${(100 * worst).toFixed(1).padStart(9)}pp`,
  );
}

for (const k of [0, 20]) {
  const m = results.get(k);
  console.log(`\n=== k=${k} 的概率分档校准 ${k === 0 ? "(当前生产)" : "(候选)"} ===`);
  console.log("   档位        n     预测概率   实际命中   偏差");
  for (const key of [...m.buckets.keys()].sort()) {
    const b = m.buckets.get(key);
    const pred = b.sum / b.n;
    const act = b.hit / b.n;
    console.log(
      `   ${key.padEnd(10)} ${String(b.n).padStart(5)} ${(100 * pred).toFixed(1).padStart(8)}% ${(100 * act).toFixed(1).padStart(9)}% ${(100 * (act - pred) >= 0 ? "+" : "")}${(100 * (act - pred)).toFixed(1).padStart(6)}pp`,
    );
  }
}
