import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildRecentForm } from "../lib/recent-form.mjs";
import { extractContextFeatures } from "../lib/context-features.mjs";
import { typesafeState, TYPESAFE_MODEL, TYPESAFE_QUESTIONS, TYPESAFE_CONTEXT_HASH, judgmentKey, validateTypesafeResponse } from "../lib/typesafe-context.mjs";
import { createTypesafeClient, openTypesafeStore, TYPESAFE_LIMITS, typesafeSettings } from "../lib/typesafe-client.mjs";
import { predictTypesafeExperiment, evaluateTypesafeForecasts, typesafeRows } from "../lib/typesafe-experiment.mjs";
import { findPilotReportFromOutput, runTypesafeWorkflow } from "../lib/typesafe-workflow.mjs";
import { pilotSelect } from "../lib/context-pilot.mjs";

function form() {
  const games = Array.from({ length: 5 }, (_, i) => ({ date: `2026-09-${String(10 - i).padStart(2, "0")}`, homeTeam: "私有甲队", awayTeam: "私有乙队", score: "2:1", tournament: i === 0 ? "友谊赛" : "联赛" }));
  return buildRecentForm({ matchId: 123, homeTeam: "私有甲队", awayTeam: "私有乙队", history: games, results: { home: { matches: games }, away: { matches: games } } }, { importedAt: "2026-09-11T00:00:00Z" });
}
function response(positive = true) {
  return { model: TYPESAFE_MODEL, usage: { input_tokens: 100, output_tokens: 20 },
    answers: Object.fromEntries(Object.entries(TYPESAFE_QUESTIONS).map(([id, q]) => {
      const keys = Object.keys(q.criteria), choice = keys[positive ? 0 : 1];
      return [id, { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(keys.map(k => [k, Number(k === choice)])) }];
    })) };
}
const now = Date.parse("2026-09-26T10:00:00Z");
function judgment(positive = true) {
  const data = response(positive);
  return { available: true, key: positive ? "positive" : "negative", protocol: TYPESAFE_CONTEXT_HASH, features: validateTypesafeResponse(data) };
}
function record(i, market = "spf") {
  return { id: i, match_id: String(i), market, algorithm_version: "test", valid: 1, status: "settled", league: "联赛", handicap: -1,
    home_team: "私有甲队", away_team: "私有乙队", captured_at: "2026-09-12T00:00:00Z", settled_at: "2026-09-13T00:00:00Z",
    actual_result: market === "goals" ? (i % 2 ? "1" : "3") : i % 2 ? "负" : "胜",
    probabilities_json: JSON.stringify(market === "goals" ? Array(8).fill(0.125) : [0.4, 0.2, 0.4]),
    settings_json: JSON.stringify({ sameLeague: false, recentForm: form() }) };
}
function target(market = "spf", positive = true) {
  const p = market === "goals" ? Array(8).fill(0.125) : [0.4, 0.2, 0.4];
  return { matchId: "target", market, league: "联赛", home: "私有甲队", away: "私有乙队", algorithmVersion: "test", capture: now - 1000, p,
    judgment: judgment(positive), features: extractContextFeatures(form(), { market, league: "联赛", handicap: -1 }),
    predictions: { A: pilotSelect(p, market), D: pilotSelect(p, market) } };
}
function resources(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "betwin-typesafe-test-")), db = openTypesafeStore(path.join(dir, "cache.db"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, db };
}

test("请求白名单匿名化、不泄露球队/日期/赛果标签，重复导入时间不改变同日输入", () => {
  const f = { ...form(), actualResult: "秘密赛果", apiKey: "秘密凭证" }, state = typesafeState(f, { league: "联赛" }), text = JSON.stringify(state);
  assert.doesNotMatch(text, /私有|秘密|2026|123/);
  assert.equal(state.homeRecent.length, 5); assert.equal(state.headToHead.length, 5);
  assert.equal(state.homeRecent[0].competitionType, "friendly");
  assert.equal(judgmentKey(state), judgmentKey(typesafeState({ ...f, importedAt: "2026-09-11T08:00:00Z" }, { league: "联赛" })));
  assert.throws(() => typesafeState({ ...f, importedAt: "bad" }), /资料/);
});
test("响应必须完整、归一化且固定模型版本，不把置信度当比赛概率", () => {
  assert.equal(Object.keys(validateTypesafeResponse(response())).length, 14);
  assert.throws(() => validateTypesafeResponse({ ...response(), model: "jev-latest" }), /版本/);
  const r = response(); r.answers.homeForm.probabilities.positive = 2;
  assert.throws(() => validateTypesafeResponse(r), /格式/);
  const missing = response(); delete missing.answers.awayForm;
  assert.throws(() => validateTypesafeResponse(missing), /格式/);
});
test("实际API两位小数舍入总和0.99可归一化，异常分布仍拒绝且保留原始响应", () => {
  const r = response();
  r.answers.homeForm = { type: "choice", choice: "mixed", confidence: 0.58,
    probabilities: { mixed: 0.68, insufficient: 0.03, negative: 0.01, positive: 0.27 } };
  const features = validateTypesafeResponse(r);
  assert.ok(Math.abs(features["homeForm.positive"] - 0.27 / 0.99) < 1e-12);
  assert.equal(r.answers.homeForm.probabilities.positive, 0.27);
  r.answers.homeForm.probabilities.positive = 0.1;
  assert.throws(() => validateTypesafeResponse(r), /格式/);
});
test("同状态跨玩法和跨进程复用缓存，无密钥也可以读取已有缓存", async t => {
  const { db } = resources(t), state = typesafeState(form()); let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++; assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(options.body); assert.equal(body.model, TYPESAFE_MODEL);
    assert.equal(Object.keys(body.questions).length, 5);
    assert.doesNotMatch(options.body, /actual_result|私有甲队|test-key/);
    return { ok: true, json: async () => response() };
  };
  const client = createTypesafeClient({ db, apiKey: "test-key", fetchImpl, now: () => now });
  const [a, b] = await Promise.all([client.judge(state), client.judge(state)]);
  assert.equal(calls, 1); assert.equal(a.key, b.key); assert.equal(a.available, true);
  const second = createTypesafeClient({ db, apiKey: "", fetchImpl, now: () => now });
  assert.equal((await second.judge(state)).available, true); assert.equal(calls, 1);
  assert.equal(client.stats.inputTokens, 100);
});
test("429有限退避重试；超预算、无key、401都不会反复请求", async t => {
  const { db } = resources(t), state = typesafeState(form()); let calls = 0, waits = 0;
  const client = createTypesafeClient({ db, apiKey: "key", now: () => now, wait: async () => { waits++; },
    fetchImpl: async () => ++calls === 1 ? { ok: false, status: 429 } : { ok: true, json: async () => response() } });
  assert.equal((await client.judge(state)).available, true); assert.equal(calls, 2); assert.equal(waits, 1);
  const capped = createTypesafeClient({ db, apiKey: "key", now: () => now, limits: { ...TYPESAFE_LIMITS, maxRequestsPerDay: 2 }, fetchImpl: async () => { throw new Error("不能调用"); } });
  assert.match((await capped.judge({ ...state, changed: 1 })).reason, /预算/);
  const noKey = createTypesafeClient({ db, apiKey: "", now: () => now });
  assert.match((await noKey.judge({ ...state, changed: 2 })).reason, /TYPESAFE_API_KEY/);
  let unauthorized = 0;
  const denied = createTypesafeClient({ db, apiKey: "do-not-log", now: () => now, fetchImpl: async () => { unauthorized++; return { ok: false, status: 401 }; } });
  assert.equal((await denied.judge({ ...state, changed: 3 })).available, false);
  assert.equal((await denied.judge({ ...state, changed: 4 })).available, false); assert.equal(unauthorized, 1);
});
test("超时重试也计预算，失败不缓存为有效判断，错误不泄露密钥", async t => {
  const { db } = resources(t); let calls = 0;
  const client = createTypesafeClient({ db, apiKey: "secret-key", now: () => now, wait: async () => {},
    limits: { ...TYPESAFE_LIMITS, maxRequestsPerRun: 1 }, fetchImpl: async () => { calls++; throw new TypeError("secret-key"); } });
  const r = await client.judge(typesafeState(form()));
  assert.equal(r.available, false); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(r), /secret-key/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM judgments").get().n, 0);
  assert.ok(db.prepare("SELECT usd FROM attempts").get().usd > 0);
  assert.throws(() => typesafeSettings({ BETWIN_TYPESAFE_MAX_REQUESTS: "bad" }), /非负/);
});
test("三玩法E实际学习新特征，Dcontrol使用同一训练池且不受TypeSafe特征改变影响", () => {
  for (const market of ["spf", "hhad", "goals"]) {
    const rows = typesafeRows(Array.from({ length: 24 }, (_, i) => record(i, market))).map((r, i) => ({ ...r, judgment: judgment(i % 2 === 0) }));
    const t = target(market), before = structuredClone(t);
    const a = predictTypesafeExperiment(rows, [t], { forecastAt: new Date(now).toISOString() });
    const b = predictTypesafeExperiment(rows, [target(market, false)], { forecastAt: new Date(now).toISOString() });
    assert.equal(a.models[0].training, 24); assert.deepEqual(t, before);
    assert.deepEqual(a.forecasts[0].predictions.Dcontrol, b.forecasts[0].predictions.Dcontrol);
    assert.notDeepEqual(a.forecasts[0].predictions.E, b.forecasts[0].predictions.E);
    assert.deepEqual(a.forecasts[0].predictions.A.probabilities, t.p);
    assert.deepEqual(a.forecasts[0].predictions.D, t.predictions.D);
    assert.ok(Math.abs(a.forecasts[0].predictions.E.probabilities.reduce((s, p) => s + p, 0) - 1) < 1e-10);
    if (market === "goals") assert.equal(a.forecasts[0].predictions.E.pair.length, 2);
  }
});
test("E排除本批、未来结算、不同版本、无判断的样本；不足不冒充E=A", () => {
  const rows = typesafeRows(Array.from({ length: 24 }, (_, i) => record(i))).map(r => ({ ...r, judgment: judgment() }));
  rows[0].matchId = "target"; rows[1].settled = now + 1; rows[2].algorithmVersion = "other"; rows[3].judgment = null;
  const result = predictTypesafeExperiment(rows, [target()], { forecastAt: new Date(now).toISOString() });
  assert.equal(result.models[0].training, 20);
  const short = predictTypesafeExperiment(rows.slice(0, 23), [target()], { forecastAt: new Date(now).toISOString() });
  assert.equal(short.forecasts.length, 0); assert.match(short.unavailable[0].reason, /19\/20/);
  const missing = predictTypesafeExperiment(rows, [{ ...target(), judgment: { available: false, reason: "超时" } }], { forecastAt: new Date(now).toISOString() });
  assert.equal(missing.forecasts.length, 0); assert.equal(missing.unavailable[0].reason, "超时");
});
test("成绩只认冻结后结算，最早预测去重，旧历史回填不计前瞻提升", () => {
  const t = target(), select = pilotSelect(t.p, "spf");
  const p = { ...t, protocolFingerprint: "p", forecastAt: new Date(now).toISOString(), predictions: { A: select, D: select, Dcontrol: select, E: select } };
  const r = { ...record(99), match_id: "target", settled_at: new Date(now + 1000).toISOString() };
  const manifest = { fingerprint: "p", activatedAt: new Date(now - 1000).toISOString(), knownSettledMatchIds: [] };
  const result = evaluateTypesafeForecasts([p, { ...p, forecastAt: new Date(now + 500).toISOString() }], [r], manifest);
  assert.equal(result[0].evaluated, 1); assert.equal(result[0].metrics.E.samples, 1);
  assert.equal(evaluateTypesafeForecasts([p], [{ ...r, settled_at: new Date(now - 1).toISOString() }], manifest).length, 0);
  assert.equal(evaluateTypesafeForecasts([p], [r], { ...manifest, knownSettledMatchIds: ["target"] }).length, 0);
});
test("更新入口能定位新报告和复用报告，不猜测最近文件", t => {
  const { dir } = resources(t), filename = path.join(dir, "pilot-1.json");
  writeFileSync(filename, JSON.stringify({ frozenAt: "2026-09-26T00:00:00Z" }));
  assert.equal(findPilotReportFromOutput(JSON.stringify({ jsonPath: filename }), dir), filename);
  assert.equal(findPilotReportFromOutput("四组预测已冻结：同一批数据不重复生成（2026-09-26T00:00:00Z，3条玩法预测）。", dir), filename);
  assert.throws(() => findPilotReportFromOutput("没有报告", dir), /无法定位/);
});

test("跨客户端并发同一状态只收费一次，第二客户端明确等待", async t => {
  const { db } = resources(t); let release, calls = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const fetchImpl = async () => { calls++; await wait; return { ok: true, json: async () => response() }; };
  const a = createTypesafeClient({ db, apiKey: "key", fetchImpl });
  const b = createTypesafeClient({ db, apiKey: "key", fetchImpl });
  const pending = a.judge(typesafeState(form()));
  assert.match((await b.judge(typesafeState(form()))).reason, /正在分析/);
  release(); assert.equal((await pending).available, true); assert.equal(calls, 1);
});

test("完整E工作流复用四组快照、冻结与去重，并拒绝数据改变后的旧快照", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "betwin-typesafe-workflow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = path.join(dir, "source.db"), source = new DatabaseSync(database);
  const prototype = record(0), keys = Object.keys(prototype);
  source.exec(`CREATE TABLE prediction_ledger (${keys.map(k => `${k} ${typeof prototype[k] === "number" ? "NUMERIC" : "TEXT"}`).join(",")});
    CREATE TABLE source_files(file_name TEXT,sha256 TEXT);`);
  const insert = source.prepare(`INSERT INTO prediction_ledger VALUES (${keys.map(() => "?").join(",")})`);
  for (let i = 0; i < 24; i++) insert.run(...keys.map(k => record(i)[k]));
  source.prepare("INSERT INTO source_files VALUES(?,?)").run("match_data1.json", "original");
  const fixture = { id: "target", home: "私有甲队", away: "私有乙队", league: "联赛", had: null, hhad: null, goals: null };
  const targetForm = { ...form(), importedAt: "2026-09-14T00:00:00Z" };
  const p = target(); p.capture = Date.now() - 1000;
  const parent = { frozenAt: new Date(p.capture).toISOString(), sources: [{ file_name: "match_data1.json", sha256: "original" }],
    fixtures: [{ match: fixture, recentForm: targetForm }], pendingPredictions: [p] };
  const parentPath = path.join(dir, "parent.json"); writeFileSync(parentPath, JSON.stringify(parent));
  let calls = 0;
  const options = { root: process.cwd(), database, outputDir: path.join(dir, "typesafe"), parentPath,
    env: { TYPESAFE_API_KEY: "mock", BETWIN_TYPESAFE_MAX_REQUESTS: "2" }, storeFactory: () => ({ getMatches: () => [fixture], getRecentForm: () => targetForm, close() {} }),
    fetchImpl: async (_url, request) => {
      if (calls === 0) assert.deepEqual(JSON.parse(request.body).state, typesafeState(targetForm, p));
      calls++; return { ok: true, json: async () => response() };
    } };
  try {
    const first = await runTypesafeWorkflow(options);
    assert.match(first.summary, /新增1项/); assert.equal(calls, 2);
    const second = await runTypesafeWorkflow(options);
    assert.match(second.summary, /复用1项/); assert.equal(calls, 2);
    assert.equal(source.prepare("SELECT COUNT(*) n FROM prediction_ledger").get().n, 24);
    source.prepare("UPDATE source_files SET sha256='changed'").run();
    await assert.rejects(() => runTypesafeWorkflow(options), /来源已变化/); assert.equal(calls, 2);
  } finally { source.close(); }
});
