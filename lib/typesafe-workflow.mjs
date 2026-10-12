import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createDataStore } from "./database.mjs";
import { contextPilotRecentFormFingerprint } from "./context-pilot-freeze.mjs";
import { createTypesafeClient, openTypesafeStore, typesafeSettings } from "./typesafe-client.mjs";
import { typesafeHash, typesafeState } from "./typesafe-context.mjs";
import { TYPESAFE_EXPERIMENT, typesafeRows, predictTypesafeExperiment, evaluateTypesafeForecasts } from "./typesafe-experiment.mjs";

const protocolFiles = ["lib/typesafe-context.mjs", "lib/typesafe-experiment.mjs", "lib/typesafe-workflow.mjs", "lib/context-features.mjs", "lib/context-experiment.mjs", "lib/context-pilot.mjs"];
const sourceSignature = sources => typesafeHash(sources.filter(s => /\.json$/i.test(s.file_name))
  .map(s => [s.file_name, s.sha256]).sort(([a], [b]) => a.localeCompare(b)));
const matchSignature = m => typesafeHash(Object.fromEntries(["id", "home", "away", "league", "had", "hhad", "goals"].map(k => [k, m[k] ?? null])));
export function findPilotReportFromOutput(output, directory) {
  const explicit = /"jsonPath":\s*("(?:[^"\\]|\\.)*")/.exec(output);
  if (explicit) {
    const filename = path.resolve(JSON.parse(explicit[1]));
    if (path.dirname(filename) !== path.resolve(directory)) throw new Error("四组报告不在预期目录");
    return filename;
  }
  const frozenAt = /四组预测已冻结：同一批数据不重复生成（([^，]+)，/.exec(output)?.[1];
  if (!frozenAt) throw new Error("无法定位本次四组冻结报告，未调用TypeSafe");
  const matches = readdirSync(directory).filter(f => /^pilot-.*\.json$/.test(f))
    .filter(f => JSON.parse(readFileSync(path.join(directory, f), "utf8")).frozenAt === frozenAt);
  if (matches.length !== 1) throw new Error("四组冻结报告无法唯一定位，未调用TypeSafe");
  return path.join(directory, matches[0]);
}

export async function runTypesafeWorkflow({ root, database, outputDir = path.join(root, "data/typesafe"),
  parentPath = null, mode = "predict", env = process.env, fetchImpl = fetch, storeFactory = createDataStore }) {
  if (env.BETWIN_TYPESAFE_ENABLED === "0") return { summary: "TypeSafe E已关闭，原预测不变" };
  if (!["predict", "prepare", "report"].includes(mode)) throw new Error("未知TypeSafe模式");
  const startedAt = new Date().toISOString();
  const db = new DatabaseSync(database, { readOnly: true }), store = storeFactory(database);
  const cache = openTypesafeStore(path.join(outputDir, "cache.db"));
  try {
    cache.exec("CREATE TABLE IF NOT EXISTS fits (id TEXT PRIMARY KEY, record_json TEXT NOT NULL)");
    const getRecords = () => db.prepare("SELECT * FROM prediction_ledger WHERE market IN ('spf','hhad','goals') ORDER BY captured_at,id").all();
    const getSources = () => db.prepare("SELECT * FROM source_files ORDER BY file_name").all();
    const originalRecords = getRecords(), sources = getSources(), active = new Set(store.getMatches().map(m => String(m.id)));
    const codeHashes = Object.fromEntries(protocolFiles.map(f => [f, typesafeHash(readFileSync(path.join(root, f), "utf8"))]));
    const fingerprint = typesafeHash({ protocol: TYPESAFE_EXPERIMENT, codeHashes });
    const old = cache.prepare("SELECT record_json FROM manifests WHERE version=?").get(TYPESAFE_EXPERIMENT.version);
    let manifest = old ? JSON.parse(old.record_json) : null;
    if (manifest && manifest.fingerprint !== fingerprint) throw new Error("E组协议代码已变化，须升级实验版本，不能混合旧预测");
    if (!manifest) {
      manifest = { version: TYPESAFE_EXPERIMENT.version, fingerprint, codeHashes, protocol: TYPESAFE_EXPERIMENT,
        activatedAt: startedAt, knownSettledMatchIds: [...new Set(originalRecords.filter(r => r.valid && r.status === "settled").map(r => String(r.match_id)))] };
      cache.prepare("INSERT INTO manifests(version,record_json) VALUES(?,?)").run(manifest.version, JSON.stringify(manifest));
    }
    if (mode === "report") {
      const forecasts = cache.prepare("SELECT record_json FROM forecasts WHERE protocol=?").all(fingerprint).map(r => JSON.parse(r.record_json));
      const comparisons = evaluateTypesafeForecasts(forecasts, originalRecords, manifest);
      const report = { generatedAt: startedAt, manifest, frozen: forecasts.length, comparisons, productionChanged: false,
        limitations: ["仅核对E组生成之后结算且启动时未知的赛果，按同版本同比赛最早有效预测去重。", "A/D/E及同训练池Dcontrol按共同目标比较；估算概率与真实命中率分开，少样本不能证明提升。", "使用用户提供的赛前资料约定，精确开赛时间未认证。"] };
      const paths = saveReport(outputDir, "evaluation", report, evaluationMarkdown(report));
      return { summary: `TypeSafe E：已冻结${forecasts.length}项，已核对${comparisons.reduce((n, c) => n + c.evaluated, 0)}项；报告 ${paths.mdPath}`, ...paths };
    }
    let parent, parentHash, targets = [], reused = [];
    const eligible = records => new Set(records.filter(r => r.valid && r.status === "settled").map(r => String(r.match_id)));
    const guard = () => {
      if (!parent) return;
      if (sourceSignature(getSources()) !== sourceSignature(parent.sources)) throw new Error("JSON来源已变化，E组拒绝使用旧四组报告");
      const settled = eligible(getRecords()), current = new Map(store.getMatches().map(m => [String(m.id), m]));
      for (const fixture of parent.fixtures) {
        const m = current.get(String(fixture.match.id));
        if (!m || matchSignature(m) !== matchSignature(fixture.match) ||
          contextPilotRecentFormFingerprint(store.getRecentForm(m)) !== contextPilotRecentFormFingerprint(fixture.recentForm)) throw new Error("当前比赛与四组冻结资料不一致，未生成E组");
      }
      if (targets.some(t => settled.has(String(t.matchId)))) throw new Error("E组冻结前已有目标赛果，已停止以防赛后补算");
    };
    if (mode === "predict") {
      if (!parentPath) throw new Error("E组需要本次四组冻结报告路径");
      parent = JSON.parse(readFileSync(parentPath, "utf8")); parentHash = typesafeHash(parent);
      if (!parent.pendingPredictions?.length || !parent.fixtures?.length || !parent.sources) throw new Error("四组报告不完整");
      const settled = eligible(originalRecords);
      targets = parent.pendingPredictions.filter(p => !settled.has(String(p.matchId))).map(p => {
        const fixture = parent.fixtures.find(f => String(f.match.id) === String(p.matchId));
        if (!fixture || !["A", "D"].every(a => p.predictions?.[a])) throw new Error("四组基线或冻结资料缺失");
        const key = typesafeHash({ fingerprint, parentHash, matchId: p.matchId, market: p.market });
        return { ...p, forecastKey: key, state: typesafeState(fixture.recentForm, p) };
      });
      guard();
      targets = targets.filter(t => {
        const saved = cache.prepare("SELECT record_json FROM forecasts WHERE key=?").get(t.forecastKey);
        if (saved) reused.push(JSON.parse(saved.record_json));
        return !saved;
      });
      if (!targets.length) return { summary: `TypeSafe E：复用${reused.length}项，无需新调用${reused.length ? "" : "（当前目标已结算或不可用）"}` };
    }
    const client = createTypesafeClient({ db: cache, apiKey: env.TYPESAFE_API_KEY, fetchImpl, limits: typesafeSettings(env) });
    // 当前比赛优先，避免补充历史特征耗尽本次请求预算。
    for (const target of targets) target.judgment = await client.judge(target.state);
    const allRows = typesafeRows(originalRecords);
    const versions = new Set(targets.map(t => `${t.market}|${t.algorithmVersion}`));
    const cutoff = targets.length ? Math.min(...targets.map(t => t.capture)) : Date.parse(startedAt);
    const training = allRows.filter(r => r.status === "settled" && r.settled < cutoff && r.capture < cutoff && !active.has(String(r.matchId)) &&
      (!versions.size || versions.has(`${r.market}|${r.algorithmVersion}`))).sort((a, b) => b.capture - a.capture || b.id - a.id);
    const warnings = new Set(); let warmRequests = 0;
    for (const row of training) {
      const hit = client.cached(row.state);
      if (hit) { row.judgment = { available: true, ...hit }; continue; }
      if (warmRequests >= TYPESAFE_EXPERIMENT.trainingRequestsPerRun) continue;
      const before = client.stats.requests;
      row.judgment = await client.judge(row.state);
      warmRequests += client.stats.requests - before;
      if (!row.judgment.available) warnings.add(row.judgment.reason);
    }
    if (mode === "prepare") {
      const readiness = ["spf", "hhad", "goals"].map(m => `${m} ${training.filter(r => r.market === m && r.judgment?.available).length}场`);
      return { summary: `TypeSafe历史特征已准备：${readiness.join("、")}；本次调用${client.stats.requests}次${warnings.size ? `；${[...warnings].join("；")}` : ""}`, usage: client.stats };
    }
    const result = predictTypesafeExperiment(training, targets, { forecastAt: new Date().toISOString() });
    guard();
    if (sourceSignature(sources) !== sourceSignature(getSources())) throw new Error("E组分析期间来源变化，拒绝冻结");
    cache.exec("BEGIN IMMEDIATE");
    try {
      for (const model of result.models) cache.prepare("INSERT OR IGNORE INTO fits(id,record_json) VALUES(?,?)").run(model.id, JSON.stringify(model));
      for (const forecast of result.forecasts) {
        forecast.protocolFingerprint = fingerprint;
        cache.prepare("INSERT OR IGNORE INTO forecasts(key,protocol,parent,record_json) VALUES(?,?,?,?)").run(forecast.forecastKey, fingerprint, parentHash, JSON.stringify(forecast));
      }
      cache.exec("COMMIT");
    } catch (error) { cache.exec("ROLLBACK"); throw error; }
    const frozen = result.forecasts.map(p => JSON.parse(cache.prepare("SELECT record_json FROM forecasts WHERE key=?").get(p.forecastKey).record_json));
    const report = { version: TYPESAFE_EXPERIMENT.version, manifest, parentPath, parentHash, generatedAt: new Date().toISOString(),
      ledgerInputHash: typesafeHash(originalRecords), productionChanged: false, usage: client.stats, warnings: [...warnings],
      forecasts: [...reused, ...frozen], unavailable: result.unavailable, models: result.models,
      limitations: ["E组未替代正式概率。三个玩法独立拟合，未施加跨玩法联合一致性约束。", "Dcontrol与E使用同一训练池、同一原概率和同一正则，仅E增加TypeSafe特征。", "历史特征为今天从旧冻结资料提取，仅用于训练，不能计作过去的赛前AI预测。", "未认证精确开赛时间；资料按用户赛前数据约定使用。", "费用为固定模型公开价格下的估算，本地限额不能替代供应商账单限额。"] };
    const paths = saveReport(outputDir, "forecast", report, forecastMarkdown(report));
    return { summary: `TypeSafe E：新增${frozen.length}项、复用${reused.length}项、未生成${result.unavailable.length}项；调用${client.stats.requests}次；报告 ${paths.mdPath}`,
      usage: client.stats, ...paths };
  } finally { cache.close(); store.close(); db.close(); }
}
const pct = v => `${(v * 100).toFixed(1)}%`;
function forecastMarkdown(report) {
  const lines = ["# TypeSafe E组实验预测", "", ...report.limitations.map(s => `- ${s}`), "",
    "| 比赛 | 玩法 | A原模型 | D原状态模型 | D同训练池对照 | E加TypeSafe |", "|---|---|---|---|---|---|"];
  const show = p => `${p.single} ${pct(p.probabilities[p.singleIndex])}${p.pair ? `；双选${p.pair.join("/")} ${pct(p.pairCoverage)}` : ""}`;
  for (const p of report.forecasts) lines.push(`| ${p.home} vs ${p.away} | ${p.market} | ${["A", "D", "Dcontrol", "E"].map(a => show(p.predictions[a])).join(" | ")} |`);
  if (report.unavailable.length) lines.push("", "## 未生成E组", "", ...report.unavailable.map(p => `- ${p.matchId} ${p.market}：${p.reason}`));
  return lines.join("\n") + "\n";
}
function evaluationMarkdown(report) {
  const lines = ["# TypeSafe E组冻结成绩", "", ...report.limitations.map(s => `- ${s}`), "",
    "| 玩法 | 组别 | 已结算 | 单选命中率 | 进球双选命中率 | LogLoss↓ | Brier↓ |", "|---|---|---:|---:|---:|---:|---:|"];
  for (const c of report.comparisons) for (const [arm, m] of Object.entries(c.metrics)) lines.push(`| ${c.market} | ${arm} | ${m.samples} | ${pct(m.accuracy)} | ${m.pairHitRate == null ? "—" : pct(m.pairHitRate)} | ${m.logLoss.toFixed(4)} | ${m.brier.toFixed(4)} |`);
  if (!report.comparisons.length) lines.push("", "尚无符合条件的E组冻结后结算样本，不输出提升结论。");
  for (const c of report.comparisons) for (const [base, values] of Object.entries(c.pairedImprovement)) {
    lines.push("", `### ${c.market}：E相对${base}（正值表示改善）`, "");
    for (const [name, v] of Object.entries(values)) lines.push(`- ${name}：${v.mean == null ? "样本不足" : `${v.mean.toFixed(4)}，95%区间 [${v.lower?.toFixed(4)}, ${v.upper?.toFixed(4)}]`}；${v.status}`);
  }
  return lines.join("\n") + "\n";
}
function saveReport(directory, prefix, report, markdown) {
  mkdirSync(directory, { recursive: true });
  const stem = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const jsonPath = path.join(directory, `${stem}.json`), mdPath = path.join(directory, `${stem}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  writeFileSync(mdPath, markdown, { flag: "wx" });
  return { jsonPath, mdPath };
}
