import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TYPESAFE_MODEL, TYPESAFE_QUESTIONS, TYPESAFE_CONTEXT_HASH, judgmentKey, validateTypesafeResponse } from "./typesafe-context.mjs";

export const TYPESAFE_LIMITS = Object.freeze({
  maxRequestsPerRun: 40, maxRequestsPerDay: 60, maxUsdPerDay: 0.10,
  timeoutMs: 12000, runTimeoutMs: 120000, retries: 1, maxBodyBytes: 20000,
  // 2026-09-26 官方价格；按单次 API 最大输入 64k 预留，失败仍占预算。
  inputUsdPerMillion: 0.042, reservedInputTokens: 64000,
});
export function openTypesafeStore(filename) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS judgments (key TEXT PRIMARY KEY, protocol TEXT NOT NULL, record_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, day TEXT NOT NULL, input_tokens INTEGER NOT NULL, usd REAL NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inflight (key TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS forecasts (key TEXT PRIMARY KEY, protocol TEXT NOT NULL, parent TEXT NOT NULL, record_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS manifests (version TEXT PRIMARY KEY, record_json TEXT NOT NULL);`);
  if (!db.prepare("PRAGMA table_info(attempts)").all().some(c => c.name === "state_key")) db.exec("ALTER TABLE attempts ADD COLUMN state_key TEXT");
  return db;
}
export function typesafeSettings(env = process.env) {
  const out = { ...TYPESAFE_LIMITS };
  for (const [name, field] of Object.entries({ BETWIN_TYPESAFE_MAX_REQUESTS: "maxRequestsPerRun", BETWIN_TYPESAFE_DAILY_REQUESTS: "maxRequestsPerDay", BETWIN_TYPESAFE_DAILY_USD: "maxUsdPerDay" })) {
    if (env[name] === undefined) continue;
    const v = Number(env[name]);
    if (!Number.isFinite(v) || v < 0 || (field !== "maxUsdPerDay" && !Number.isInteger(v))) throw new Error(`${name}必须是非负${field === "maxUsdPerDay" ? "数" : "整数"}`);
    out[field] = v;
  }
  return out;
}

export function createTypesafeClient({ db, apiKey = process.env.TYPESAFE_API_KEY, fetchImpl = fetch, limits = TYPESAFE_LIMITS, now = () => Date.now(), wait = sleep }) {
  const started = now(), memo = new Map();
  const stats = { requests: 0, cached: 0, failed: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
  let circuit = false;
  const cached = state => {
    const row = db.prepare("SELECT record_json FROM judgments WHERE key=? AND protocol=?").get(judgmentKey(state), TYPESAFE_CONTEXT_HASH);
    if (!row) return null;
    const record = JSON.parse(row.record_json);
    record.features = validateTypesafeResponse(record.response);
    if (judgmentKey(record.state) !== judgmentKey(state)) throw new Error("TypeSafe缓存指纹不一致");
    return record;
  };
  function reserve(stateKey) {
    if (!apiKey) throw new Error("缺少服务端 TYPESAFE_API_KEY，已保留原预测");
    if (circuit) throw new Error("TypeSafe连续失败，本次已停止调用");
    if (stats.requests >= limits.maxRequestsPerRun || now() - started >= limits.runTimeoutMs) throw new Error("TypeSafe本次调用或时间预算已用完");
    const day = new Date(now() + 8 * 3600000).toISOString().slice(0, 10);
    const cost = limits.reservedInputTokens * limits.inputUsdPerMillion / 1e6;
    db.exec("BEGIN IMMEDIATE");
    try {
      const used = db.prepare("SELECT COUNT(*) requests, COALESCE(SUM(usd),0) usd FROM attempts WHERE day=?").get(day);
      if (used.requests >= limits.maxRequestsPerDay || used.usd + cost > limits.maxUsdPerDay + 1e-12) throw new Error("TypeSafe每日调用或估算费用预算已用完");
      const id = db.prepare("INSERT INTO attempts(day,input_tokens,usd,status,state_key) VALUES(?,?,?,'reserved',?)").run(day, limits.reservedInputTokens, cost, stateKey).lastInsertRowid;
      db.exec("COMMIT"); stats.requests++; stats.estimatedUsd += cost; return { id, cost };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  async function evaluateUncached(state) {
    const body = JSON.stringify({ model: TYPESAFE_MODEL, state, questions: TYPESAFE_QUESTIONS });
    if (Buffer.byteLength(body) > limits.maxBodyBytes) return { available: false, reason: "TypeSafe输入超出长度预算" };
    for (let retry = 0; retry <= limits.retries; retry++) {
      let ticket;
      try { ticket = reserve(judgmentKey(state)); } catch (error) { return { available: false, reason: error.message }; }
      let retryable = false, reason = "TypeSafe请求失败";
      try {
        const timeout = Math.max(1, Math.min(limits.timeoutMs, limits.runTimeoutMs - (now() - started)));
        const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
          method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body,
          signal: AbortSignal.timeout(timeout), redirect: "error",
        });
        if (!response.ok) {
          retryable = [429, 500, 502, 503, 504, 529].includes(response.status);
          if ([401, 403].includes(response.status)) circuit = true;
          reason = `TypeSafe HTTP ${response.status}`;
        } else {
          const data = await response.json();
          let features;
          try { features = validateTypesafeResponse(data); }
          catch (error) { reason = error.message; throw error; }
          const actualCost = data.usage.input_tokens * limits.inputUsdPerMillion / 1e6;
          db.prepare("UPDATE attempts SET input_tokens=?,usd=?,status='ok' WHERE id=?").run(data.usage.input_tokens, actualCost, ticket.id);
          stats.inputTokens += data.usage.input_tokens; stats.outputTokens += data.usage.output_tokens;
          stats.estimatedUsd += actualCost - ticket.cost;
          const record = { key: judgmentKey(state), protocol: TYPESAFE_CONTEXT_HASH, createdAt: new Date(now()).toISOString(), state, response: data, features };
          db.prepare("INSERT OR IGNORE INTO judgments(key,protocol,record_json) VALUES(?,?,?)").run(record.key, record.protocol, JSON.stringify(record));
          return { available: true, cached: false, ...cached(state) };
        }
      } catch (error) {
        // 不回显服务响应、请求头或异常原文，避免凭证进入日志。
        retryable = ["TimeoutError", "AbortError", "TypeError"].includes(error.name);
        if (reason === "TypeSafe请求失败") reason = retryable ? "TypeSafe连接失败或超时" : "TypeSafe响应校验失败";
      }
      stats.failed++;
      db.prepare("UPDATE attempts SET status=? WHERE id=? AND status='reserved'").run(reason, ticket.id);
      if (stats.failed >= 3) circuit = true;
      if (!retryable || retry === limits.retries || circuit) return { available: false, reason };
      await wait(Math.min(2000, 500 * 2 ** retry));
    }
  }
  async function evaluate(state) {
    const hit = cached(state);
    if (hit) { stats.cached++; return { available: true, cached: true, ...hit }; }
    const key = judgmentKey(state);
    db.exec("BEGIN IMMEDIATE");
    let claimed;
    try {
      db.prepare("DELETE FROM inflight WHERE started_at<?").run(now() - limits.runTimeoutMs * 2);
      claimed = db.prepare("INSERT OR IGNORE INTO inflight(key,started_at) VALUES(?,?)").run(key, now()).changes;
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    if (!claimed) return { available: false, reason: "相同资料正在分析，本次不重复调用" };
    try { return await evaluateUncached(state); }
    finally { db.prepare("DELETE FROM inflight WHERE key=?").run(key); }
  }
  return { stats, cached, async judge(state) {
    const key = judgmentKey(state);
    if (!memo.has(key)) memo.set(key, evaluate(state));
    return memo.get(key);
  } };
}
