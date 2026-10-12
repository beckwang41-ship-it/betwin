import { createHash } from "node:crypto";
import { normalizeFixtureText, normalizeTeamName } from "./fixture-name.mjs";

export const AUDIT_VERSION = "frozen-prediction-audit-v1";
export const AUDIT_ARMS = { A: "原模型", B: "近期状态", C: "历史交锋", D: "状态＋交锋", Dcontrol: "同训练池对照", E: "加入 TypeSafe" };
const labels = { spf: ["胜", "平", "负"], hhad: ["胜", "平", "负"], goals: ["0", "1", "2", "3", "4", "5", "6", "7+"] };
export const auditHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fixtureKey = p => [normalizeFixtureText(p.league), normalizeTeamName(p.home), normalizeTeamName(p.away)].join("|");
const identity = p => `${p.market}|${p.algorithmVersion}|${p.matchId}`;
const time = value => Date.parse(value || "");
const actual = (row, market) => market === "goals" ? row.goals : row[market]?.result;
const imported = (row, market) => row[market === "goals" ? "goalImportedAt" : `${market}ImportedAt`];
const reference = (row, market) => [row[market === "goals" ? "goalSourceFile" : `${market}SourceFile`], row[market === "goals" ? "goalSourceRow" : `${market}SourceRow`]];
const historyOdds = (row, market) => market === "goals" ? row.goalMarket?.odds : row[market]?.odds;
const equalOdds = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length > 0 && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-8);

// 先使用同比赛 ID、同算法账本的赛果；未结算时直接核对历史库，绝不写回旧预测。
export function createAuditResultResolver(history, ledger, now = Date.now()) {
  const byFixture = new Map(), byRecord = new Map();
  for (const row of history) {
    const key = fixtureKey(row);
    if (!byFixture.has(key)) byFixture.set(key, []);
    byFixture.get(key).push(row);
  }
  for (const row of ledger.filter(r => r.valid && r.status === "settled")) {
    const key = `${row.market}|${row.algorithm_version}|${row.match_id}`;
    if (!byRecord.has(key)) byRecord.set(key, []);
    byRecord.get(key).push(row);
  }
  return p => {
    const frozen = time(p.frozenAt), market = p.market;
    const matching = (byFixture.get(fixtureKey(p)) || []).filter(row =>
      labels[market]?.includes(String(actual(row, market))) &&
      (market !== "hhad" || (p.handicap != null && Number(row.hhad?.handicap) === Number(p.handicap))));
    const records = (byRecord.get(identity(p)) || []).filter(r => market !== "hhad" ||
      (r.handicap != null && p.handicap != null && Number(r.handicap) === Number(p.handicap)));
    if (records.length) {
      const values = new Set(records.map(r => String(r.actual_result)));
      if (values.size !== 1 || !labels[market]?.includes([...values][0])) return { status: "invalid", reason: "同场账本赛果冲突或标签无效" };
      const availability = records.map(r => time(r.settled_at)).filter(Number.isFinite);
      for (const r of records) for (const h of matching) {
        const [source, row] = reference(h, market);
        if (source === r.settled_source_file && Number(row) === Number(r.settled_source_row)) {
          if (String(actual(h, market)) !== String(r.actual_result)) return { status: "invalid", reason: "账本与历史库赛果冲突" };
          if (Number.isFinite(time(imported(h, market)))) availability.push(time(imported(h, market)));
        }
      }
      const availableAt = Math.min(...availability);
      if (!Number.isFinite(availableAt)) return { status: "invalid", reason: "赛果缺少可核对的入库或结算时间" };
      if (availableAt <= frozen) return { status: "known-result", reason: "冻结前赛果已入库或结算，排除事后预测" };
      if (availableAt > now) return { status: "pending", reason: "截至复盘时尚无可用赛果" };
      return { status: "settled", y: labels[market].indexOf([...values][0]), availableAt, source: "ledger" };
    }
    const exact = matching.filter(row => equalOdds(historyOdds(row, market), p.odds));
    if (exact.some(row => time(imported(row, market)) <= frozen)) return { status: "known-result", reason: "同对阵、盘口及整组赔率的赛果已在冻结前入库" };
    const later = matching.filter(row => time(imported(row, market)) > frozen && time(imported(row, market)) <= now);
    const exactLater = later.filter(row => equalOdds(historyOdds(row, market), p.odds));
    const candidates = exactLater.length ? exactLater : later;
    if (!candidates.length) return { status: "pending", reason: "待结算：历史库暂无可唯一核对的新赛果" };
    if (candidates.length !== 1) return { status: "ambiguous", reason: "存在多场同名对阵，无法唯一确认赛果" };
    return { status: "settled", y: labels[market].indexOf(String(actual(candidates[0], market))),
      availableAt: time(imported(candidates[0], market)), source: "history" };
  };
}

function validSelection(p, market) {
  const n = labels[market]?.length, ps = p?.probabilities;
  return Array.isArray(ps) && ps.length === n && ps.every(v => Number.isFinite(v) && v >= 0 && v <= 1) &&
    Math.abs(ps.reduce((a, b) => a + b, 0) - 1) < 1e-6 && Number.isInteger(p.singleIndex) && p.singleIndex >= 0 && p.singleIndex < n &&
    (market !== "goals" || (Array.isArray(p.pairIndices) && p.pairIndices.length === 2 && new Set(p.pairIndices).size === 2 &&
      p.pairIndices.every(i => Number.isInteger(i) && i >= 0 && i < n)));
}

function metrics(cases, arms, market) {
  return Object.fromEntries(arms.map(arm => {
    let hits = 0, pairHits = 0, logLoss = 0, brier = 0;
    for (const c of cases) {
      const saved = c.predictions[arm], p = saved.probabilities;
      hits += Number(saved.singleIndex === c.y);
      pairHits += Number(saved.pairIndices?.includes(c.y));
      logLoss -= Math.log(Math.max(1e-8, p[c.y]));
      brier += p.reduce((s, v, i) => s + (v - Number(i === c.y)) ** 2, 0);
    }
    const n = cases.length;
    return [arm, { samples: n, hits, accuracy: n ? hits / n : null,
      logLoss: n ? logLoss / n : null, brier: n ? brier / n : null,
      ...(market === "goals" ? { pairHits, pairAccuracy: n ? pairHits / n : null } : {}) }];
  }));
}

function windowSummary(cases, arms, market) {
  const values = metrics(cases, arms, market);
  for (const arm of arms) {
    values[arm].hitDelta = values[arm].hits - values.A.hits;
    if (market === "goals") values[arm].pairHitDelta = values[arm].pairHits - values.A.pairHits;
  }
  return { samples: cases.length, metrics: values };
}

export function buildPredictionAudit({ batches = [], manifests = [], history = [], ledger = [], notices = [], attempts = [], generatedAt = new Date().toISOString() }) {
  const now = time(generatedAt), resolve = createAuditResultResolver(history, ledger, now);
  if (!Number.isFinite(now)) throw new Error("复盘时间无效");
  const protocols = new Map(manifests.map(m => [m.fingerprint, m]));
  const groups = new Map(), issues = [...notices], seen = new Set();
  const entries = batches.flatMap(b => (b.forecasts || []).map(p => {
    const frozen = Math.max(time(p.forecastAt), time(b.frozenAt || p.forecastAt));
    return { ...p, batch: b, frozenAt: Number.isFinite(frozen) ? new Date(frozen).toISOString() : null };
  }))
    .sort((a, b) => time(a.frozenAt) - time(b.frozenAt) || a.batch.id.localeCompare(b.batch.id));
  for (const p of entries) {
    const b = p.batch, manifest = protocols.get(b.protocolFingerprint), arms = b.kind === "typesafe" ? ["A", "B", "C", "D", "Dcontrol", "E"] : ["A", "B", "C", "D"];
    const detail = { matchId: String(p.matchId), market: p.market, fixture: `${p.home || ""} vs ${p.away || ""}`, batch: b.id, protocol: b.protocolVersion };
    const issue = (status, reason) => issues.push({ ...detail, status, reason });
    if (!manifest || !Number.isFinite(time(manifest.activatedAt)) || !Array.isArray(manifest.knownSettledMatchIds)) { issue("invalid", "缺少对应的冻结协议或启动水位"); continue; }
    if (!p.algorithmVersion || !labels[p.market] || p.status !== "experimental-not-production" || !arms.every(a => validSelection(p.predictions?.[a], p.market))) { issue("invalid", "缺少完整的冻结概率、单选/双选选择或版本"); continue; }
    if (!Number.isFinite(time(p.frozenAt)) || !Number.isFinite(time(p.baselineCapturedAt)) || time(p.frozenAt) < time(manifest.activatedAt) || time(p.frozenAt) > now || time(p.baselineCapturedAt) > time(p.frozenAt)) { issue("invalid", "冻结时间不符合协议水位"); continue; }
    if (manifest.knownSettledMatchIds.map(String).includes(String(p.matchId))) { issue("known-result", "实验启动时已知赛果，排除"); continue; }
    const key = `${b.kind}|${b.protocolFingerprint}|${b.parentProtocol || ""}|${p.market}|${p.algorithmVersion}`;
    const unique = `${key}|${p.matchId}`;
    if (seen.has(unique)) { issue("duplicate", "同协议同算法同比赛，仅保留最早有效冻结"); continue; }
    const result = resolve(p);
    if (!["settled", "pending"].includes(result.status)) { issue(result.status, result.reason); continue; }
    seen.add(unique);
    if (!groups.has(key)) groups.set(key, { id: auditHash(key).slice(0, 20), kind: b.kind, protocol: b.protocolVersion,
      parentProtocol: b.parentProtocol || null, market: p.market, algorithmVersion: p.algorithmVersion, arms, cases: [], pending: [], entries: [] });
    const g = groups.get(key), row = { ...detail, forecastAt: p.frozenAt, predictions: p.predictions, ...result };
    g.entries.push(row);
    if (result.status === "settled") g.cases.push(row);
    else { g.pending.push(detail); issue(result.status, result.reason); }
  }
  const successful = new Set(entries.map(p => `${p.batch.kind}|${p.matchId}|${p.market}`));
  const missing = new Map();
  for (const b of [...batches].sort((a, b) => time(a.frozenAt) - time(b.frozenAt))) for (const item of b.unavailable || []) {
    const key = `${b.kind}|${item.matchId}|${item.market}`;
    if (!successful.has(key)) missing.set(key, { ...item, status: "not-generated", batch: b.id, protocol: b.protocolVersion });
  }
  issues.push(...missing.values());
  // 不从缺失反推 API 失败或训练不足：旧任务没有记录原因时明确说明未知。
  for (const p of entries.filter(p => p.batch.kind === "context")) {
    const key = `typesafe|${p.matchId}|${p.market}`;
    if (!successful.has(key) && !missing.has(key)) missing.set(key, { matchId: String(p.matchId), market: p.market, status: "not-recorded",
      reason: "未找到 E 组冻结，旧任务未保存具体原因", batch: p.batch.id });
  }
  issues.push(...[...missing.values()].filter(i => i.status === "not-recorded"));
  const cohorts = [...groups.values()].map(g => {
    const ordered = g.cases.sort((a, b) => time(a.forecastAt) - time(b.forecastAt) || a.matchId.localeCompare(b.matchId));
    const latest = g.entries.at(-1), batch = latest?.batch;
    return { ...g, entries: undefined, pending: g.pending.length, latestAt: latest?.forecastAt,
      windows: { all: windowSummary(ordered, g.arms, g.market), recent30: windowSummary(ordered.slice(-30), g.arms, g.market),
        latest: { ...windowSummary(ordered.filter(c => c.batch === batch), g.arms, g.market), batch,
          pending: g.entries.filter(c => c.batch === batch && c.status === "pending").length } },
      cases: ordered.map(({ predictions, ...c }) => c) };
  }).sort((a, b) => time(b.latestAt) - time(a.latestAt) || a.market.localeCompare(b.market));
  return { version: AUDIT_VERSION, generatedAt, productionChanged: false, cohorts, issues, attempts,
    summary: { batches: new Set(batches.map(b => `${b.kind}|${b.id}`)).size, cohorts: cohorts.length,
      evaluatedFixtures: new Set(cohorts.flatMap(g => g.cases.map(c => c.matchId))).size,
      pendingItems: cohorts.reduce((n, g) => n + g.pending, 0), excludedItems: issues.filter(i => ["invalid", "known-result", "ambiguous"].includes(i.status)).length },
    limitations: ["A 就是原模型；每张表使用同协议、同算法、同玩法的共同比赛，不跨表比较命中率。",
      "只核对冻结时保存的概率与选择，不训练、不补算、不调用 AI API；缺预测不按预测失败计入命中率。",
      "同协议同算法同比赛只取最早有效冻结；最近30场按冻结顺序取已结算比赛，最近一批指最晚新增有效冻结的批次，可含待结算比赛。",
      "以赛果入库/结算时间核对冻结先后，缺少真实开赛日期，不能据此宣称已完成严格赛前认证。",
      "少量比赛多中或少中不证明稳定提升，命中率变化也不代表投注收益；不会自动上线候选模型。"] };
}
