import { createHash } from "node:crypto";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// importedAt 是执行导入的本地时间，不是赛前资料本身。同一文件重复导入时它会变化，
// 但不应因此生成另一个冻结批次。
export function contextPilotRecentFormFingerprint(form) {
  if (!form || typeof form !== "object") return hash(null);
  const { importedAt: _ignored, ...stableForm } = form;
  return hash(stableForm);
}

// 只使用决定预测内容的稳定输入。重复导入同一批JSON不会因为导入时间变化而重复冻结。
export function contextPilotBatchKey({ protocolFingerprint, sources, matches, baselineOutputs }) {
  const currentSources = (sources || [])
    .filter(source => /\.json$/i.test(String(source.file_name || "")))
    .map(source => ({
      fileName: source.file_name,
      sha256: source.sha256,
      recordCount: source.record_count,
      fileSize: source.file_size,
    }))
    .sort((a,b)=>a.fileName.localeCompare(b.fileName));
  const fixtures = (matches || []).map(match => ({
    id: String(match.id), league: match.league, home: match.home, away: match.away,
    had: match.had || null, hhad: match.hhad || null, goals: match.goals || null,
  })).sort((a,b)=>a.id.localeCompare(b.id));
  // 正式实现代码是否变化不等于预测内容变化；直接锁定API输出才是稳定去重依据。
  return hash({ protocolFingerprint, currentSources, fixtures, baselineOutputs });
}

export function matchingFrozenReport(reports, { batchKey, protocolFingerprint }) {
  return (reports || []).find(report =>
    report?.batchKey === batchKey &&
    report?.protocolFingerprint === protocolFingerprint &&
    Array.isArray(report.pendingPredictions) &&
    report.pendingPredictions.length > 0
  ) || null;
}
