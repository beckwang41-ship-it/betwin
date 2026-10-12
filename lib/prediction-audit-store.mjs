import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createDataStore } from "./database.mjs";
import { auditHash, buildPredictionAudit } from "./prediction-audit.mjs";

export function auditPaths(root, env = process.env) {
  return { database: env.BETWIN_DATABASE_PATH || path.join(root, "betwin.db"),
    contextDir: env.BETWIN_CONTEXT_PILOT_DIR || path.join(root, "data/context-pilot"),
    typesafeDir: env.BETWIN_TYPESAFE_DIR || path.join(root, "data/typesafe"),
    outputDir: env.BETWIN_AUDIT_DIR || path.join(root, "data/prediction-audit") };
}

function oddsFor(match, market) {
  const node = market === "spf" ? match?.had : match?.[market];
  return !node ? null : (market === "goals" ? ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7plus"] : ["h", "d", "a"]).map(k => Number(node[k]));
}

export function readPredictionAudit({ database, contextDir, typesafeDir, outputDir, generatedAt }) {
  const notices = [], batches = [], manifests = [], parents = new Map();
  const readDirectory = (directory, accepts) => {
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(accepts).sort().flatMap(file => {
      try { return [{ file, value: JSON.parse(readFileSync(path.join(directory, file), "utf8")) }]; }
      catch (error) { notices.push({ status: "invalid", reason: `报告无法读取：${file}（${error.name}）` }); return []; }
    });
  };
  for (const { file, value: report } of readDirectory(contextDir, f => /^(pilot-.*|context-pilot-.*-protocol)\.json$/.test(f))) {
    if (file.endsWith("-protocol.json")) { manifests.push(report); continue; }
    parents.set(auditHash(report), report);
    batches.push({ id: file, kind: "context", protocolVersion: report.version, protocolFingerprint: report.protocolFingerprint,
      frozenAt: report.frozenAt, unavailable: report.skipped || [],
      forecasts: (report.pendingPredictions || []).map(p => ({ ...p, odds: oddsFor(report.fixtures?.find(f => String(f.match?.id) === String(p.matchId))?.match, p.market) })) });
  }
  const addTypesafe = (forecasts, manifest, parentHash, frozenAt, id, unavailable = []) => {
    const parent = parents.get(parentHash);
    if (!parent) { notices.push({ status: "invalid", reason: `E组缺少对应四组父报告：${id}` }); return; }
    manifests.push(manifest);
    batches.push({ id: path.basename(id), kind: "typesafe", parentProtocol: parent.protocolFingerprint,
      protocolVersion: manifest.version, protocolFingerprint: manifest.fingerprint, frozenAt,
      unavailable, forecasts: forecasts.map(p => ({ ...p, odds: oddsFor(parent.fixtures?.find(f => String(f.match?.id) === String(p.matchId))?.match, p.market) })) });
  };
  // 缓存是冻结记录的权威来源；JSON 报告提供缺失原因和实际批次，不回写缓存。
  const eReports = readDirectory(typesafeDir, f => /^forecast-.*\.json$/.test(f));
  const firstPublished = new Map();
  for (const report of [...eReports].sort((a, b) => Date.parse(a.value.generatedAt) - Date.parse(b.value.generatedAt))) {
    for (const p of report.value.forecasts || []) if (!firstPublished.has(p.forecastKey)) firstPublished.set(p.forecastKey, report);
  }
  const cachePath = path.join(typesafeDir, "cache.db");
  if (existsSync(cachePath)) {
    let cache;
    try {
      cache = new DatabaseSync(cachePath, { readOnly: true });
      const eManifests = new Map(cache.prepare("SELECT record_json FROM manifests").all().map(row => {
        const m = JSON.parse(row.record_json); return [m.fingerprint, m];
      }));
      for (const row of cache.prepare("SELECT key,protocol,parent,record_json FROM forecasts").all()) {
        const forecast = JSON.parse(row.record_json), manifest = eManifests.get(row.protocol), report = firstPublished.get(row.key);
        if (!manifest || forecast.protocolFingerprint !== manifest.fingerprint) { notices.push({ status: "invalid", reason: "E组冻结缺少匹配协议" }); continue; }
        addTypesafe([forecast], manifest, row.parent, report?.value.generatedAt || forecast.forecastAt,
          report?.file || `cache-${row.parent}`);
      }
    } catch (error) { notices.push({ status: "invalid", reason: `E组缓存读取失败（${error.name}），未使用未经核对的数据` }); }
    finally { cache?.close(); }
  }
  for (const { file, value: r } of eReports) {
    if (!r.manifest?.fingerprint) { notices.push({ status: "invalid", reason: `E组报告协议缺失：${file}` }); continue; }
    addTypesafe(existsSync(cachePath) ? [] : r.forecasts || [], r.manifest, r.parentHash, r.generatedAt, file, r.unavailable || []);
  }
  const attempts = readDirectory(path.join(outputDir, "attempts"), f => f.endsWith(".json")).map(r => r.value)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt)).slice(0, 20);
  const db = new DatabaseSync(database, { readOnly: true }), store = createDataStore(database);
  try {
    db.exec("BEGIN");
    const sourceUpdatedAt = store.getSourceUpdatedAt();
    const ledger = db.prepare("SELECT * FROM prediction_ledger WHERE valid=1 AND market IN ('spf','hhad','goals')").all();
    const history = store.getSettlementHistory();
    const report = buildPredictionAudit({ batches, manifests, ledger, history, notices, attempts, generatedAt });
    if (sourceUpdatedAt !== store.getSourceUpdatedAt()) throw new Error("复盘期间数据变化，请更新完成后重试");
    return { ...report, sourceUpdatedAt };
  } finally { db.close(); store.close(); }
}

export function savePredictionAudit(outputDir, report) {
  mkdirSync(outputDir, { recursive: true });
  const name = `audit-${report.generatedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`;
  const content = JSON.stringify(report, null, 2) + "\n";
  const reportPath = path.join(outputDir, name);
  writeFileSync(reportPath, content, { flag: "wx" });
  const temporary = path.join(outputDir, `.latest-${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { flag: "wx" });
  renameSync(temporary, path.join(outputDir, "latest.json"));
  return reportPath;
}

export function recordPredictionAttempt(outputDir, { stage, error }) {
  const message = String(error?.message || error || "");
  const category = /训练不足|有效训练/.test(message) ? "training-insufficient"
    : /资料不足|明细|没有可预测/.test(message) ? "missing-context"
      : /均已有赛果/.test(message) ? "known-result" : "workflow-failed";
  const reasons = { "training-insufficient": "有效训练样本不足，本次未完成冻结", "missing-context": "资料不足，本次未完成冻结",
    "known-result": "目标比赛已有赛果，未补做预测", "workflow-failed": "流程未完成，具体错误见该次命令输出" };
  const directory = path.join(outputDir, "attempts");
  mkdirSync(directory, { recursive: true });
  // 不保存完整异常输出，避免把凭证、外部响应或私密路径写入展示报告。
  writeFileSync(path.join(directory, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ stage, category, reason: reasons[category], recordedAt: new Date().toISOString() }), { flag: "wx" });
}
