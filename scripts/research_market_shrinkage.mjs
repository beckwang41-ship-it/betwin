// 只读研究：历史概率向去水市场概率收缩 p = w·历史 + (1−w)·市场，能否改善校准。
// 用法：npm run research:market-shrinkage
// 口径：时间滚动回测（预热500）；前60%选 w，中间20%复核，最新20%检验。
// 胜平负 / 让球看单选（最高项）；总进球只看双选（前两名，2 注），不评估单选。
// 输出 data/market-shrinkage-research.json（reportOnly，不影响生产）。
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { buildThreeWayReliabilityObservations } from "../lib/reliability-tuning.mjs";
import { FORMAL_PRODUCTION_THRESHOLDS } from "../lib/reliability-validation.mjs";
import { buildThreeWayEvents } from "../lib/three-way-backtest.mjs";
import { historySteps } from "../lib/history-timeline.mjs";
import { GOAL_LABELS, normalizeOdds, selectTopGoalPair } from "../lib/predictor.mjs";
import { selectProductionGoalSimilarity, predictProductionGoals } from "../lib/goal-production.mjs";
import { GOAL_ZERO_ODDS_TOLERANCE } from "../lib/goal-zero-odds.mjs";
import { blockBootstrapMean } from "../lib/significance.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH = process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const WARMUP = 500;
const WEIGHTS = Array.from({ length: 11 }, (_, i) => i / 10);
const EPS = 1e-6;
const pct = (v) => `${(v * 100).toFixed(2)}%`;

const blend = (model, market, w) => model.map((p, i) => w * p + (1 - w) * market[i]);
const validOdds = (odds, n) => Array.isArray(odds) && odds.length === n && odds.every((o) => Number.isFinite(o) && o > 1);

// 最高项（并列按 1/k 计分）
function topPick(p) {
  const max = Math.max(...p);
  return p.map((v, i) => (Math.abs(v - max) < 1e-12 ? i : -1)).filter((i) => i >= 0);
}

// 单场指标：LogLoss、命中、收益（单选 1 注 / 双选 2 注）、所选项预测概率
function caseMetrics(kind, row, p) {
  const logLoss = -Math.log(Math.max(EPS, p[row.actualIndex]));
  if (kind === "pair") {
    const pair = selectTopGoalPair(p, row.odds);
    const hit = pair.indices.includes(row.actualIndex);
    return { logLoss, hit: Number(hit), predicted: pair.probability,
      profit: (hit ? row.odds[row.actualIndex] : 0) - 2, stake: 2 };
  }
  const idx = topPick(p);
  const hit = idx.includes(row.actualIndex) ? 1 / idx.length : 0;
  const profit = idx.includes(row.actualIndex) ? row.odds[row.actualIndex] / idx.length - 1 : -1;
  return { logLoss, hit, predicted: p[idx[0]], profit, stake: 1 };
}

function summarize(kind, rows, w) {
  if (!rows.length) return null;
  let ll = 0, hit = 0, pred = 0, profit = 0, stake = 0, changed = 0;
  const edges = [0, 0.3, 0.4, 0.5, 0.6, 0.7, 1.01];
  const bins = edges.slice(0, -1).map((from, i) => ({ from, to: edges[i + 1], n: 0, hit: 0, pred: 0 }));
  for (const row of rows) {
    const p = blend(row.model, row.market, w);
    const m = caseMetrics(kind, row, p);
    ll += m.logLoss; hit += m.hit; pred += m.predicted; profit += m.profit; stake += m.stake;
    // 收缩后所选方向是否改变（单选看最高项，双选看组合）
    const sig = (q) => (kind === "pair" ? selectTopGoalPair(q, row.odds).indices.slice().sort().join() : topPick(q).join());
    if (sig(p) !== sig(row.model)) changed += 1;
    const bin = bins.find((b) => m.predicted >= b.from && m.predicted < b.to);
    if (bin) { bin.n += 1; bin.hit += m.hit; bin.pred += m.predicted; }
  }
  const n = rows.length;
  const ece = bins.reduce((s, b) => s + (b.n ? Math.abs(b.pred / b.n - b.hit / b.n) * b.n / n : 0), 0);
  return { n, logLoss: ll / n, hitRate: hit / n, meanPredicted: pred / n, overconfidence: (pred - hit) / n,
    ece, roi: profit / stake, pickChangedRate: changed / n };
}

// 最新段：收缩(w*) 相对纯历史(w=1) 的逐场 LogLoss 改善，做区块 Bootstrap。
function logLossGain(rows, w) {
  const cases = rows.map((row, order) => ({
    sourceFile: row.sourceFile, order,
    value: -Math.log(Math.max(EPS, row.model[row.actualIndex])) + Math.log(Math.max(EPS, blend(row.model, row.market, w)[row.actualIndex])),
  }));
  const r = blockBootstrapMean(cases, { iterations: 1000, blockSize: 20, seed: 20260929 });
  return { mean: r.mean, lower: r.lower, upper: r.upper, status: r.status };
}

// 最新段：收缩后命中（双选=组合命中）相对纯历史的逐场差，做区块 Bootstrap。
function hitGain(kind, rows, w) {
  const cases = rows.map((row, order) => ({
    sourceFile: row.sourceFile, order,
    value: caseMetrics(kind, row, blend(row.model, row.market, w)).hit - caseMetrics(kind, row, row.model).hit,
  }));
  const r = blockBootstrapMean(cases, { iterations: 1000, blockSize: 20, seed: 20260929 });
  return { mean: r.mean, lower: r.lower, upper: r.upper, status: r.status };
}

function evaluateMarket(name, kind, rows) {
  const a = Math.floor(rows.length * 0.6), b = Math.floor(rows.length * 0.8);
  const seg = { train: rows.slice(0, a), calibration: rows.slice(a, b), test: rows.slice(b) };
  const trainLoss = WEIGHTS.map((w) => summarize(kind, seg.train, w).logLoss);
  const bestW = WEIGHTS[trainLoss.indexOf(Math.min(...trainLoss))];
  const out = { kind, rows: rows.length, bestWeightFromTrain: bestW,
    trainLogLossByWeight: Object.fromEntries(WEIGHTS.map((w, i) => [w, Number(trainLoss[i].toFixed(4))])),
    segments: {} };
  for (const [key, part] of Object.entries(seg)) {
    out.segments[key] = {
      history: summarize(kind, part, 1), shrunk: summarize(kind, part, bestW), market: summarize(kind, part, 0),
    };
  }
  out.testLogLossGain = logLossGain(seg.test, bestW);
  out.calibrationLogLossGain = logLossGain(seg.calibration, bestW);
  out.testHitGain = hitGain(kind, seg.test, bestW);

  console.log(`\n================ ${name}（${kind === "pair" ? "双选前两名" : "单选最高项"}，${rows.length} 场）`);
  console.log(`前60%选出 w=${bestW}（1=纯历史，0=纯市场）`);
  for (const [key, label] of [["calibration", "中间20%"], ["test", "最新20%"]]) {
    for (const [v, vl] of [["history", "纯历史"], ["shrunk", `收缩w=${bestW}`], ["market", "纯市场"]]) {
      const s = out.segments[key][v];
      console.log(`${label} ${vl.padEnd(10)} LogLoss ${s.logLoss.toFixed(4)}  命中 ${pct(s.hitRate)}  预测 ${pct(s.meanPredicted)}  高估 ${pct(s.overconfidence)}  ECE ${pct(s.ece)}  ROI ${pct(s.roi)}  换向 ${pct(s.pickChangedRate)}`);
    }
  }
  const g = out.testLogLossGain;
  console.log(`最新20% LogLoss 改善 ${g.mean.toFixed(4)}（95% ${g.lower.toFixed(4)} ~ ${g.upper.toFixed(4)}，${g.status}）`);
  const h = out.testHitGain;
  console.log(`最新20% 命中率变化 ${pct(h.mean)}（95% ${pct(h.lower)} ~ ${pct(h.upper)}，${h.status}）`);
  return out;
}

function threeWayRows(events, market) {
  const { observations } = buildThreeWayReliabilityObservations(
    events, market, FORMAL_PRODUCTION_THRESHOLDS, { warmup: WARMUP },
  );
  return observations
    .filter((r) => r.available && r.actualIndex >= 0 && validOdds(r.odds, 3) && Array.isArray(r.probabilities))
    .map((r) => ({ sourceFile: r.sourceFile, odds: r.odds, actualIndex: r.actualIndex,
      model: r.probabilities.map(Number), market: normalizeOdds(r.odds) }));
}

// 与 tune_reliability 相同的总进球时间滚动：0 球赔率分桶 + 生产相似度选择。
function goalRows(history) {
  const rows = [];
  let buckets, previous, added = 0;
  for (const { target, history: prior } of historySteps(history)) {
    if (previous !== prior) { buckets = new Map(); previous = prior; added = 0; }
    while (added < prior.length) {
      const row = prior[added++], price = Number(row.odds?.[0]);
      if (!Number.isFinite(price)) continue;
      if (!buckets.has(price)) buckets.set(price, []);
      buckets.get(price).push(row);
    }
    const odds = (target.odds || []).map(Number);
    const actualIndex = GOAL_LABELS.indexOf(String(target.goals));
    if (prior.length < WARMUP || !validOdds(odds, 8) || actualIndex < 0) continue;
    const candidates = [];
    for (const [price, bucket] of buckets) {
      if (Math.abs(price - odds[0]) <= GOAL_ZERO_ODDS_TOLERANCE) candidates.push(...bucket);
    }
    const resolved = selectProductionGoalSimilarity(candidates, { odds, initialOdds: target.initialOdds },
      { zeroOddsTolerance: GOAL_ZERO_ODDS_TOLERANCE });
    const p = predictProductionGoals(odds, resolved, { blendOptions: { empiricalOnly: true, requireSamples: true } });
    if (!p.available) continue;
    rows.push({ sourceFile: target.sourceFile, odds, actualIndex, model: p.final.map(Number), market: normalizeOdds(odds) });
    if (rows.length % 2000 === 0) console.log(`总进球回测：${rows.length} 场`);
  }
  return rows;
}

const report = { generatedAt: new Date().toISOString(), reportOnly: true, affectsProduction: false,
  method: "p = w·历史 + (1−w)·去水市场；前60%选w，中间20%/最新20%复核", markets: {} };
const store = createDataStore(DATABASE_PATH);
try {
  const events = buildThreeWayEvents({
    spfHistory: store.getSpfHistory(), hhadHistory: store.getHhadHistory(),
    pairedHistory: store.getPairedSpfHhadHistory(),
  });
  report.markets.spf = evaluateMarket("胜平负", "single", threeWayRows(events, "spf"));
  report.markets.hhad = evaluateMarket("让球", "single", threeWayRows(events, "hhad"));
  report.markets.goals = evaluateMarket("总进球", "pair", goalRows(store.getGoalHistory()));
} finally {
  store.close();
}
writeFileSync(path.join(ROOT, "data", "market-shrinkage-research.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log("\n已写入 data/market-shrinkage-research.json（只读研究，不影响生产）");
