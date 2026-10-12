import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPredictionAudit, createAuditResultResolver } from "../lib/prediction-audit.mjs";
import { recordPredictionAttempt, savePredictionAudit } from "../lib/prediction-audit-store.mjs";
import { renderAuditTable, renderAuditIssues } from "../public/prediction-audit.js";

const manifests = [{ fingerprint: "p1", activatedAt: "2026-01-01T00:00:00Z", knownSettledMatchIds: [] }];
function prediction(id = "1", market = "spf") {
  const choice = market === "goals" ? { probabilities: [0.1, 0.1, 0.3, 0.2, 0.1, 0.1, 0.05, 0.05], singleIndex: 2, pairIndices: [2, 3] }
    : { probabilities: [0.6, 0.3, 0.1], singleIndex: 0 };
  return { matchId: String(id), market, algorithmVersion: "model-v1", status: "experimental-not-production",
    home: `主${id}`, away: "客队", league: "测试", handicap: -1, odds: [2, 3, 4],
    forecastAt: "2026-02-01T00:00:00Z", baselineCapturedAt: "2026-01-31T23:00:00Z",
    predictions: Object.fromEntries(["A", "B", "C", "D", "Dcontrol", "E"].map(a => [a, structuredClone(choice)])) };
}
const batch = (forecasts, fields = {}) => ({ id: "batch1", kind: "context", protocolVersion: "v1", protocolFingerprint: "p1", frozenAt: "2026-02-01T00:00:01Z", forecasts, ...fields });
const result = (p, extra = {}) => ({ valid: 1, status: "settled", match_id: p.matchId, market: p.market, algorithm_version: p.algorithmVersion,
  handicap: p.handicap, actual_result: p.market === "goals" ? "2" : "胜", settled_at: "2026-03-01T00:00:00Z", ...extra });
const evaluate = (batches, ledger, extra = {}) => buildPredictionAudit({ batches, ledger, manifests, generatedAt: "2026-04-01T00:00:00Z", ...extra });

test("使用冻结选择而非重新挑最大概率，双选与单选都在同一共同样本上比较", () => {
  const p = prediction("1", "goals");
  p.predictions.B.singleIndex = 1;
  p.predictions.B.pairIndices = [0, 1];
  const before = structuredClone(p), r = evaluate([batch([p])], [result(p)]), metrics = r.cohorts[0].windows.all.metrics;
  assert.equal(metrics.A.hits, 1); assert.equal(metrics.B.hits, 0);
  assert.equal(metrics.B.pairHitDelta, -1); assert.equal(metrics.B.samples, metrics.A.samples);
  assert.deepEqual(p, before);
  const html = renderAuditTable(r.cohorts[0], "all");
  assert.match(html, /双选命中/); assert.match(html, /少中 1 场/);
});

test("最早有效冻结去重、缺组不计成绩、不同协议和算法不混合", () => {
  const p = prediction(), later = { ...prediction(), forecastAt: "2026-02-02T00:00:00Z" }, missing = prediction("2");
  delete missing.predictions.C;
  const other = { ...prediction(), algorithmVersion: "model-v2" };
  const r = evaluate([batch([p, missing]), batch([later], { id: "repeat" }), batch([other])], [result(p), result(missing), result(other)]);
  assert.equal(r.cohorts.length, 2); assert.ok(r.cohorts.every(g => g.windows.all.samples === 1));
  assert.ok(r.issues.some(i => i.status === "duplicate")); assert.ok(r.issues.some(i => i.status === "invalid"));
  const separated = evaluate([batch([p]), batch([p], { protocolFingerprint: "p2" })], [result(p)], { manifests: [...manifests, { ...manifests[0], fingerprint: "p2" }] });
  assert.equal(separated.cohorts.length, 2); assert.equal(separated.summary.evaluatedFixtures, 1);
});

test("E组只用自身完整六组共同冻结，待结算及没有E不按错误预测计入", () => {
  const p = prediction(), pending = prediction("2");
  const r = evaluate([batch([p, pending], { kind: "typesafe", parentProtocol: "p1" })], [result(p)]);
  assert.equal(r.cohorts[0].arms.length, 6); assert.equal(r.cohorts[0].windows.all.samples, 1);
  assert.equal(r.cohorts[0].pending, 1);
  const empty = evaluate([batch([pending])], []);
  assert.equal(empty.cohorts[0].windows.all.metrics.A.accuracy, null);
  assert.match(renderAuditTable(empty.cohorts[0], "latest"), /待结算不计为失败/);
  assert.ok(empty.issues.some(i => i.status === "not-recorded"));
});

test("最近30场按冻结顺序，最新批次可全为待结算，不用旧赛果填补", () => {
  const ps = Array.from({ length: 35 }, (_, i) => ({ ...prediction(i), forecastAt: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString() }));
  const last = { ...prediction("last"), forecastAt: "2026-03-10T00:00:00Z" };
  const g = evaluate([batch(ps), batch([last], { id: "new", frozenAt: "2026-03-10T00:00:01Z" })], ps.map(p => result(p))).cohorts[0];
  assert.equal(g.windows.all.samples, 35); assert.equal(g.windows.recent30.samples, 30);
  assert.equal(g.windows.latest.samples, 0); assert.equal(g.windows.latest.pending, 1);
});

test("拒绝启动前已知赛果、冻结后才保存的事后预测和损坏时间", () => {
  const p = prediction();
  const known = evaluate([batch([p])], [result(p)], { manifests: [{ ...manifests[0], knownSettledMatchIds: ["1"] }] });
  assert.equal(known.cohorts.length, 0);
  const late = evaluate([batch([p], { frozenAt: "2026-03-02T00:00:00Z" })], [result(p)]);
  assert.equal(late.cohorts.length, 0); assert.equal(late.issues[0].status, "known-result");
  assert.equal(evaluate([batch([{ ...p, forecastAt: "bad" }])], [result(p)]).cohorts.length, 0);
});

test("不用网页结算也可读取新历史赛果，不按Excel行号先后，歧义不强配", () => {
  const p = { ...prediction(), frozenAt: "2026-02-01T00:00:00Z" };
  const h = { home: p.home, away: p.away, league: p.league, spf: { result: "胜", odds: [2, 3, 4] },
    spfImportedAt: "2026-03-01T00:00:00Z", spfSourceFile: "history.xlsx", spfSourceRow: 2 };
  assert.equal(createAuditResultResolver([h], [])(p).status, "settled");
  assert.equal(createAuditResultResolver([h, { ...h, spfSourceRow: 3 }], [])(p).status, "ambiguous");
  assert.equal(createAuditResultResolver([{ ...h, spfImportedAt: "2026-01-01T00:00:00Z" }], [])(p).status, "known-result");
  const record = result(p, { settled_source_file: "history.xlsx", settled_source_row: 2 });
  assert.equal(createAuditResultResolver([{ ...h, spfImportedAt: "2026-01-01T00:00:00Z" }], [record])(p).status, "known-result");
});

test("同比赛让球数后来变化，不借用不同盘口的账本赛果", () => {
  const p = { ...prediction("1", "hhad"), frozenAt: "2026-02-01T00:00:00Z" };
  assert.equal(createAuditResultResolver([], [result(p)])(p).status, "settled");
  assert.equal(createAuditResultResolver([], [result(p, { handicap: -2 })])(p).status, "pending");
});

test("缺失原因防注入；任务异常只保存分类，不记录敏感原始输出；报告追加保存", () => {
  assert.doesNotMatch(renderAuditIssues([{ reason: "<script>bad</script>", status: "invalid" }]), /<script>/);
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-audit-"));
  try {
    recordPredictionAttempt(directory, { stage: "freeze", error: new Error("训练不足 TOKEN=secret") });
    const file = readdirSync(path.join(directory, "attempts"))[0];
    const saved = readFileSync(path.join(directory, "attempts", file), "utf8");
    assert.match(saved, /training-insufficient/); assert.doesNotMatch(saved, /secret|TOKEN/);
    const report = evaluate([], []);
    const first = savePredictionAudit(directory, report), second = savePredictionAudit(directory, report);
    assert.notEqual(first, second); assert.equal(JSON.parse(readFileSync(first)).version, report.version);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
