import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { buildThreeWayEvents } from "../lib/three-way-backtest.mjs";
import { runProductionThreeWay } from "../lib/production-backtest.mjs";
import { summarizeCases } from "../lib/rolling-backtest.mjs";
import { THREE_WAY_MATCHING_VERSION } from "../lib/three-way-matching.mjs";
import { blockBootstrapFixtureMean } from "../lib/significance.mjs";
import { strategyOutcome } from "../lib/strategy-evaluation.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name, fallback) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const source = arg("source", "lsspfpl.xlsx");
console.warn(`旧研究协议：仅分析数据库中来源为 ${source} 的子集，不读取同名Excel文件，也不代表全库结论。`);
const warmup = Number(arg("warmup", "1000"));
if (!Number.isInteger(warmup) || warmup < 1) throw new Error("warmup必须为正整数");
const output = path.resolve(arg("output", path.join(root, "data/league-hierarchy-report.json")));
const store = createDataStore(process.env.BETWIN_DATABASE_PATH || path.join(root, "betwin.db"));
let events;
try {
  events = buildThreeWayEvents({ spfHistory: store.getSpfHistory(), hhadHistory: store.getHhadHistory(), pairedHistory: store.getPairedSpfHhadHistory() })
    .filter(row => row.sourceFile === source);
} finally { store.close(); }
if (events.length <= warmup) throw new Error(`来源${source}的历史不足预热要求`);
const fingerprint = value => createHash("sha256").update(value).digest("hex");
const run = runProductionThreeWay(events, { warmup, includeSameLeague: true });
const candidates = [{ id: "global", k: null }, ...[2,5,10,20,40,80,120,200,400,800,1600].map(k => ({ id: `hierarchy-k${k}`, k }))];
const probabilities = (row, candidate) => {
  if (!row.sampleSize) return null;
  if (candidate.id === "same") return row.localProbabilities;
  if (candidate.id === "market") return row.marketProbabilities;
  if (candidate.id === "global") return row.modelProbabilities;
  return row.localCounts.map((n, i) => (n + candidate.k * row.modelProbabilities[i]) / (row.localSamples + candidate.k));
};
const period = row => row.index < Math.floor(row.sourceLength * .6) ? "tuning"
  : row.index < Math.floor(row.sourceLength * .8) ? "validation" : "observedTail";
function metrics(rows, candidate) {
  const covered = rows.flatMap(row => {
    const p = probabilities(row, candidate);
    return p ? [{ ...row, p }] : [];
  });
  return { ...summarizeCases(covered, "p"), targets: rows.length,
    coverage: rows.length ? covered.length / rows.length : 0,
    fixtures: new Set(covered.map(x => x.fixtureId)).size };
}
const tuning = run.cases.filter(row => period(row) === "tuning");
const ranking = candidates.map(candidate => ({ ...candidate, metrics: metrics(tuning, candidate) }))
  .sort((a,b) => a.metrics.logLoss - b.metrics.logLoss || Number(a.k || 0) - Number(b.k || 0));
// Only tuning rows choose K. Later rows can reject but never retune this choice.
const chosen = ranking[0];
const policies = [{ id: "global" }, { id: "same" }, { id: "market" }, chosen];
const result = {};
for (const stage of ["tuning", "validation", "observedTail"]) {
  const rows = run.cases.filter(row => period(row) === stage);
  const common = rows.filter(row => row.sampleSize && row.localSamples);
  result[stage] = {
    sourceRows: rows.length ? [rows[0].sourceRow, rows.at(-1).sourceRow] : [],
    byPolicy: Object.fromEntries(policies.map(p => [p.id, metrics(rows,p)])),
    commonAllAndSame: Object.fromEntries(policies.map(p => [p.id,metrics(common,p)])),
    byMarket: Object.fromEntries(["spf","hhad"].map(m => [m,Object.fromEntries(policies.map(p => [p.id, metrics(rows.filter(x=>x.market===m),p)]))])),
  };
}
const tail = run.cases.filter(row => period(row) === "observedTail" && row.sampleSize);
const lossDelta = candidate => blockBootstrapFixtureMean(tail.map(row => ({
  fixtureId: row.fixtureId, sourceFile: row.sourceFile, market: row.market, order: row.sourceRow,
  // Positive means history/candidate has lower loss than the market baseline.
  value: Math.log(probabilities(row, candidate)[row.actualIndex]) - Math.log(row.marketProbabilities[row.actualIndex]),
})), { iterations: 5000, blockSize: 50 });
const casesPath = output.replace(/\.json$/, "") + ".cases.jsonl";
const lines = run.cases.map(row => JSON.stringify({
  fixtureId: row.fixtureId, sourceFile: row.sourceFile, sourceRow: row.sourceRow,
  period: period(row), market: row.market, league: row.league, actualIndex: row.actualIndex,
  odds: row.odds, globalSamples: row.sampleSize, sameSamples: row.localSamples,
  globalProbabilities: row.sampleSize ? row.modelProbabilities : null,
  sameProbabilities: row.localProbabilities, chosenProbabilities: probabilities(row,chosen),
  chosenOutcome: row.sampleSize ? strategyOutcome(probabilities(row,chosen),row.odds,row.actualIndex) : null,
})).join("\n") + "\n";
writeFileSync(casesPath, lines);
const report = {
  reportOnly: true, affectsProduction: false, generatedAt: new Date().toISOString(),
  matchingVersion: THREE_WAY_MATCHING_VERSION,
  discipline: "首行最旧、末行最新；每场仅使用同来源更小行号；文件之间不拼接时间线",
  limitation: "末段此前已经查看，属于历史研究，不能宣称独立未来验证或全局最优",
  data: { source, rows: events.length, sourceRows: [events[0].sourceRow, events.at(-1).sourceRow], fingerprint: fingerprint(JSON.stringify(events)) },
  codeFingerprint: fingerprint(["scripts/compare_league_hierarchy.mjs","lib/production-backtest.mjs","lib/three-way-matching.mjs","lib/predictor.mjs","lib/smoothing.mjs","lib/rolling-backtest.mjs","lib/strategy-evaluation.mjs","lib/significance.mjs"].map(f=>readFileSync(path.join(root,f),"utf8")).join("\n")),
  settings: { warmup, spfTolerance: .07, hhadTolerance: .07, tuningEnd: .6, validationEnd: .8 },
  ranking, selectedOnTuningOnly: { id: chosen.id, k: chosen.k }, stages: result,
  tailLossImprovementVsMarket: lossDelta(chosen),
  futureValidation: { source, requiresSourceRowGreaterThan: events.at(-1).sourceRow, requiresFrozenPrematchPredictions: true, enabled: false },
  cases: { file: path.basename(casesPath), rows: run.cases.length, sha256: fingerprint(lines) },
};
writeFileSync(output, JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({output, casesPath, data:report.data, selected:report.selectedOnTuningOnly, observedTail:report.stages.observedTail, interval:report.tailLossImprovementVsMarket},null,2));
