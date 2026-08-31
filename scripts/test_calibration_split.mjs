import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_PATH = process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const LABELS = ["胜", "平", "负"];
const WARMUP = 500;
const TOL = 0.07;

function dist(o, t) {
  return Math.max(...o.map((v, i) => Math.abs(Number(v) / Number(t[i]) - 1)));
}

function prior(od) {
  const b = [0.862, 0.899, 0.88];
  const raw = od.map((v, i) => {
    let r = b[i];
    if (v > 4.5) r = 0.815;
    else if (v < 1.5) r = 0.902;
    return r / v;
  });
  const s = raw.reduce((x, y) => x + y, 0);
  return raw.map((v) => v / s);
}

function loadMain() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const all = db
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
  const cnt = new Map();
  for (const r of all) cnt.set(r.source_file, (cnt.get(r.source_file) || 0) + 1);
  let bf = null;
  for (const [f, n] of cnt) if (!bf || n > bf.n) bf = { file: f, n };
  return all.filter((r) => r.source_file === bf.file);
}

function evaluate(sub, k) {
  let n = 0;
  let h = 0;
  let ll = 0;
  let br = 0;
  const per = [];
  for (const x of sub) {
    const p = x.c.map((v, i) => (v + k * x.pr[i]) / (x.tot + k));
    let tp = 0;
    for (let i = 1; i < 3; i += 1) if (p[i] > p[tp]) tp = i;
    if (p.filter((q) => Math.abs(q - p[tp]) < 1e-12).length > 1) continue;
    n += 1;
    const hit = tp === x.act ? 1 : 0;
    h += hit;
    const pp = Math.min(1 - 1e-15, Math.max(1e-15, p[x.act]));
    const L = -Math.log(pp);
    const B = p.reduce((s, v, i) => s + (v - (i === x.act ? 1 : 0)) ** 2, 0);
    ll += L;
    br += B;
    per.push({ key: x.key, hit, L, B });
  }
  return { n, acc: h / n, ll: ll / n, br: br / n, per };
}

const rows = loadMain();
const cases = [];
for (let i = WARMUP; i < rows.length; i += 1) {
  const t = rows[i];
  const tg = [t.h, t.d, t.a];
  const c = [0, 0, 0];
  let tot = 0;
  for (let j = 0; j < i; j += 1) {
    const r = rows[j];
    if (dist([r.h, r.d, r.a], tg) <= TOL) {
      c[LABELS.indexOf(r.result)] += 1;
      tot += 1;
    }
  }
  if (tot) {
    cases.push({
      key: `${t.source_file}:${t.source_row}`,
      c,
      tot,
      pr: prior(tg),
      act: LABELS.indexOf(t.result),
    });
  }
}

const N = cases.length;
const cut = Math.floor(N * 0.8);
console.log(`数据库: ${DB_PATH}`);
console.log(`可评估 ${N} 场；前80%调参段 ${cut} 场，最新20%独立验证段 ${N - cut} 场\n`);

for (const [name, sub] of [
  ["前80% 调参段", cases.slice(0, cut)],
  ["最新20% 独立验证段", cases.slice(cut)],
]) {
  console.log(`=== ${name} ===`);
  console.log("k          n    命中率    LogLoss     Brier");
  for (const k of [0, 10, 20, 40]) {
    const m = evaluate(sub, k);
    console.log(
      `${String(k).padEnd(6)}${String(m.n).padStart(7)} ${(100 * m.acc).toFixed(2).padStart(6)}% ${m.ll.toFixed(4).padStart(9)} ${m.br.toFixed(4).padStart(9)}`,
    );
  }
  console.log("");
}

const test = cases.slice(cut);
const a = evaluate(test, 0);
const b = evaluate(test, 20);
const deltas = [];
const bByKey = new Map(b.per.map((row) => [row.key, row]));
for (const baseline of a.per) {
  const candidate = bByKey.get(baseline.key);
  if (!candidate) continue;
  deltas.push({
    acc: candidate.hit - baseline.hit,
    ll: candidate.L - baseline.L,
    br: candidate.B - baseline.B,
  });
}
const m = deltas.length;

let seed = 20260727;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const BS = 2000;
const BLK = 20;
const s = { acc: [], ll: [], br: [] };
for (let it = 0; it < BS; it += 1) {
  let A = 0;
  let L = 0;
  let B = 0;
  let cn = 0;
  while (cn < deltas.length) {
    const st = Math.floor(rnd() * deltas.length);
    const take = Math.min(BLK, deltas.length - cn);
    for (let o = 0; o < take; o += 1) {
      const d = deltas[(st + o) % deltas.length];
      A += d.acc;
      L += d.ll;
      B += d.br;
      cn += 1;
    }
  }
  s.acc.push(A / cn);
  s.ll.push(L / cn);
  s.br.push(B / cn);
}
const pc = (arr, q) => {
  const v = [...arr].sort((x, y) => x - y);
  return v[Math.floor(q * (v.length - 1))];
};

console.log(`=== 最新20% 连续区块Bootstrap (k=20 vs k=0，${BS}次，区块${BLK}，配对 ${m} 场) ===`);
console.log("按项目既有门禁：LogLoss/Brier 上界<0 且 命中率下界>=0\n");
for (const [nm, key, good] of [
  ["命中率", "acc", "up"],
  ["LogLoss", "ll", "down"],
  ["Brier", "br", "down"],
]) {
  const lo = pc(s[key], 0.025);
  const hi = pc(s[key], 0.975);
  const mean = s[key].reduce((x, y) => x + y, 0) / BS;
  const ok = good === "up" ? lo >= -1e-12 : hi < -1e-12;
  console.log(
    `${nm.padEnd(9)} 均值=${mean >= 0 ? "+" : ""}${mean.toFixed(4)}  95%区间=[${lo >= 0 ? "+" : ""}${lo.toFixed(4)}, ${hi >= 0 ? "+" : ""}${hi.toFixed(4)}]  ${ok ? "通过" : "未通过"}`,
  );
}
