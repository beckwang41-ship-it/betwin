// 只读诊断：可靠性分级是否带来相对市场的增量信息。
// 用法：node scripts/diagnose_reliability.mjs
// 口径与 report:reliability-roi 相同的时间滚动观测（预热500场，全部联赛，±7%），
// 另比较模型概率与去水市场概率的校准、LogLoss，以及按"模型-市场分歧"分箱的 ROI。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import {
  buildThreeWayReliabilityObservations,
  reliabilityRuleMatches,
} from "../lib/reliability-tuning.mjs";
import { FORMAL_PRODUCTION_THRESHOLDS } from "../lib/reliability-validation.mjs";
import { buildThreeWayEvents } from "../lib/three-way-backtest.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const config = JSON.parse(
  readFileSync(path.join(ROOT, "data", "reliability-config.json"), "utf8"),
);

const pct = (v) => (v === null || !Number.isFinite(v) ? "  n/a" : `${(v * 100).toFixed(1)}%`);

function devig(odds) {
  const inv = odds.map((o) => 1 / o);
  const total = inv.reduce((s, v) => s + v, 0);
  return inv.map((v) => v / total);
}

// 单选（唯一最高）才计入，并列视为无预测，与账本单选口径一致。
function pick(probabilities) {
  const max = Math.max(...probabilities);
  const idx = probabilities
    .map((v, i) => (Math.abs(v - max) < 1e-12 ? i : -1))
    .filter((i) => i >= 0);
  return idx.length === 1 ? idx[0] : -1;
}

function summarize(rows) {
  if (!rows.length) return null;
  let hit = 0, profit = 0, model = 0, market = 0;
  for (const r of rows) {
    const won = r.actualIndex === r.pick;
    hit += won ? 1 : 0;
    profit += won ? r.odds[r.pick] - 1 : -1;
    model += r.probabilities[r.pick];
    market += r.market[r.pick];
  }
  const n = rows.length;
  return { n, hit: hit / n, model: model / n, market: market / n, roi: profit / n };
}

function logLoss(rows, key) {
  const eps = 1e-6;
  return rows.reduce((s, r) => s - Math.log(Math.max(eps, r[key][r.actualIndex])), 0) / rows.length;
}

function line(label, s) {
  if (!s) return `${label.padEnd(22)} (无)`;
  return `${label.padEnd(22)} n=${String(s.n).padStart(5)}  命中${pct(s.hit).padStart(7)}  模型${pct(s.model).padStart(7)}  市场${pct(s.market).padStart(7)}  ROI${pct(s.roi).padStart(8)}`;
}

function bins(rows, fn, edges, labelFn) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const part = rows.filter((r) => fn(r) >= edges[i] && fn(r) < edges[i + 1]);
    if (part.length >= 30) out.push({ label: labelFn(edges[i], edges[i + 1]), ...summarize(part) });
  }
  return out;
}

const report = { generatedAt: new Date().toISOString(), reportOnly: true, affectsProduction: false, markets: {} };
const store = createDataStore(DATABASE_PATH);
try {
  const events = buildThreeWayEvents({
    spfHistory: store.getSpfHistory(),
    hhadHistory: store.getHhadHistory(),
    pairedHistory: store.getPairedSpfHhadHistory(),
  });
  for (const market of ["spf", "hhad"]) {
    const rule = config.markets?.[market]?.rule;
    const { observations } = buildThreeWayReliabilityObservations(
      events, market, FORMAL_PRODUCTION_THRESHOLDS, { warmup: 500 },
    );
    const rows = observations
      .filter((r) => r.available && r.actualIndex >= 0 && r.odds.every((o) => o > 1))
      .map((r) => ({ ...r, market: devig(r.odds), pick: pick(r.probabilities) }))
      .filter((r) => r.pick >= 0);
    const half = Math.floor(rows.length / 2);
    const parts = { 前半段: rows.slice(0, half), 后半段: rows.slice(half) };

    // 融合权重 w：p = w*模型 + (1-w)*去水市场；前半段选 w，后半段复核。
    const blendLoss = (part, w) => logLoss(
      part.map((r) => ({ ...r, blend: r.probabilities.map((p, i) => w * p + (1 - w) * r.market[i]) })),
      "blend",
    );
    const weights = Array.from({ length: 11 }, (_, i) => i / 10);
    const bestW = weights.reduce((b, w) => (blendLoss(parts.前半段, w) < blendLoss(parts.前半段, b) ? w : b), 0);
    const blend = {
      bestWeight: bestW,
      firstHalf: Object.fromEntries(weights.map((w) => [w, Number(blendLoss(parts.前半段, w).toFixed(4))])),
      secondHalf: Object.fromEntries(weights.map((w) => [w, Number(blendLoss(parts.后半段, w).toFixed(4))])),
    };

    console.log(`\n================ ${market}  单选可预测 ${rows.length} 场`);
    console.log(`LogLoss 模型 ${logLoss(rows, "probabilities").toFixed(4)}  去水市场 ${logLoss(rows, "market").toFixed(4)}（越小越好）`);
    console.log(`融合权重（前半段选）w=${bestW}；后半段 LogLoss：纯市场 ${blend.secondHalf[0]} / w=${bestW} ${blend.secondHalf[bestW]} / 纯模型 ${blend.secondHalf[1]}`);
    console.log(line("全部单选", summarize(rows)));
    const flagged = rows.filter((r) => rule && reliabilityRuleMatches(r, rule));
    const rest = rows.filter((r) => !(rule && reliabilityRuleMatches(r, rule)));
    console.log(line("重点参考规则", summarize(flagged)));
    console.log(line("其余", summarize(rest)));

    const divergence = (r) => r.probabilities[r.pick] - r.market[r.pick];
    const divEdges = [-1, -0.05, 0, 0.03, 0.06, 0.1, 1];
    const divLabel = (a, b) => `分歧 ${a <= -1 ? "<" : `${(a * 100).toFixed(0)}`}${b >= 1 ? "+" : `~${(b * 100).toFixed(0)}`}pt`;
    const fav = (r) => (r.market[r.pick] === Math.max(...r.market) ? 1 : 0);

    const segments = {};
    for (const [name, part] of Object.entries(parts)) {
      console.log(`\n-- ${name}（${part.length} 场）：按模型-市场分歧`);
      const d = bins(part, divergence, divEdges, divLabel);
      d.forEach((b) => console.log(line(b.label, b)));
      console.log(`-- ${name}：模型方向是否市场热门`);
      const favRows = [
        { label: "同市场热门", ...summarize(part.filter((r) => fav(r) === 1)) },
        { label: "逆市场热门", ...summarize(part.filter((r) => fav(r) === 0)) },
      ];
      favRows.forEach((b) => console.log(line(b.label, b)));
      console.log(`-- ${name}：按市场概率分箱`);
      const m = bins(part, (r) => r.market[r.pick], [0, 0.35, 0.45, 0.55, 0.65, 0.75, 1.01], (a, b) => `市场 ${(a * 100).toFixed(0)}-${(b * 100).toFixed(0)}%`);
      m.forEach((b) => console.log(line(b.label, b)));
      segments[name] = { divergence: d, favourite: favRows, marketBins: m };
    }
    report.markets[market] = {
      rows: rows.length,
      logLoss: { model: logLoss(rows, "probabilities"), market: logLoss(rows, "market") },
      blend,
      all: summarize(rows),
      flagged: summarize(flagged),
      unflagged: summarize(rest),
      segments,
    };
  }
} finally {
  store.close();
}
writeFileSync(path.join(ROOT, "data", "reliability-diagnosis.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log("\n已写入 data/reliability-diagnosis.json（只读研究，不影响生产）");
