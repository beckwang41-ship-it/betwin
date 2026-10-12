import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createLatestRequestGate, ledgerEmptyState, sourceTime } from "../public/presentation.js";
import { summarizeSampleOrigins } from "../lib/presentation-data.mjs";

test("数据入口只保留读取状态、按钮和导入说明", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="(?:data-status-panel|data-status-times|match-data-status)"/);
  assert.match(html, /id="source-connection-label"[^>]*role="status"/);
  assert.match(html, /id="refresh-current-data"/);
  assert.match(html, /更新文件后，请先执行数据更新命令/);
});

test("实际比赛读取流程支持失败后重试，且不访问已移除的时间面板", async () => {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const nodes = new Map(["#refresh-current-data", "#source-connection-label", "#match-count"].map(id => [id, { disabled: false, textContent: "" }]));
  const requests = [];
  const context = vm.createContext({
    state: { portfolioRows: [], matches: [], selectedId: null, modelConfig: {} },
    $: id => { assert.ok(nodes.has(id), `访问了不应存在的元素 ${id}`); return nodes.get(id); },
    setLoading() {}, renderMatchList() {}, loadPrediction() {}, loadMatchReliability() {}, showError() {},
    fetchJson: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
  });
  vm.runInContext(source.slice(source.indexOf("async function loadMatches()"), source.indexOf("function renderSampleOrigins()")), context);
  const first = context.loadMatches();
  assert.equal(nodes.get("#refresh-current-data").disabled, true);
  assert.match(nodes.get("#source-connection-label").textContent, /正在读取/);
  requests[0].reject(new Error("offline"));
  await first;
  assert.match(nodes.get("#source-connection-label").textContent, /读取失败/);
  assert.equal(nodes.get("#refresh-current-data").disabled, false);
  const retry = context.loadMatches();
  requests[1].resolve({ matches: [{ id: "1" }] });
  await retry;
  assert.equal(nodes.get("#source-connection-label").textContent, "本地数据读取成功");
  assert.equal(nodes.get("#match-count").textContent, "1 场");
  assert.equal(nodes.get("#refresh-current-data").disabled, false);
});

test("latest request gate rejects late successes and errors, including debounced changes", () => {
  const gate = createLatestRequestGate();
  const old = gate.begin();
  const latest = gate.begin();
  assert.equal(old.isCurrent(), false);
  assert.equal(latest.isCurrent(), true);
  gate.invalidate();
  assert.equal(latest.isCurrent(), false);
});

test("empty ledger distinguishes no archive, version exclusion and ordinary filters", () => {
  assert.equal(ledgerEmptyState({ all: 0, selectedPolicy: 0 }, "parlay").kind, "empty");
  const excluded = ledgerEmptyState({ all: 49, selectedPolicy: 0, unknown: 49 }, "parlay");
  assert.equal(excluded.kind, "version");
  assert.match(excluded.message, /49/);
  assert.equal(ledgerEmptyState({ all: 49, selectedPolicy: 12 }, "parlay").kind, "filtered");
  assert.equal(ledgerEmptyState(undefined, "single").kind, "filtered");
});

test("source timestamps never invent a date for time-only odds or missing collection time", () => {
  assert.equal(sourceTime("21:05:58"), "21:05:58（日期未知）");
  assert.equal(sourceTime(null), "未知");
  assert.equal(sourceTime("garbage"), "未知");
  assert.match(sourceTime("2026-09-04T16:00:00Z"), /2026.*09.*05.*00:00/);
  assert.match(sourceTime("2026-09-04 16:47:32"), /16:47/);
});

test("origins summarize the full sample pool, preserving count versus effective weight", () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ league: i < 30 ? "英冠" : "英超" }));
  const result = summarizeSampleOrigins(rows, { league: "英冠", mode: "joint", effectiveSamples: 32.4 });
  assert.equal(result.total, 45);
  assert.equal(result.sameLeague, 30);
  assert.equal(result.otherLeagues, 15);
  assert.equal(result.effectiveSamples, 32.4);
  assert.equal(result.leagues[0].share, 30 / 45);
  assert.equal(result.mode, "joint");
  assert.equal(summarizeSampleOrigins([], { league: "英冠", mode: "joint-unavailable" }).total, 0);
  assert.equal(summarizeSampleOrigins([{ league: null }], { league: "英冠" }).leagues[0].league, "联赛未知");
});

function ledgerHarness() {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function showLedgerLoading()");
  const end = source.indexOf("function matchReliabilitySummary", start);
  const nodes = new Map();
  const renders = [];
  const requests = [];
  const context = vm.createContext({
    state: { ledgerLoaded: true }, ledgerFilterTimer: null, clearTimeout,
    ledgerRequestGate: createLatestRequestGate(),
    $: (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, {
        hidden: true, textContent: "", disabled: false,
        classList: { add() {}, remove() {} }, setAttribute() {}, scrollIntoView() {},
      });
      return nodes.get(selector);
    },
    ledgerRequestParams: () => "singlePolicy=current",
    renderLedger: (value) => renders.push(value),
    fetchJson: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
  });
  vm.runInContext(source.slice(start, end), context);
  return { nodes, requests, renders, load: () => context.loadLedger() };
}

test("actual ledger loader keeps a failed refresh visible above previously loaded data", async () => {
  const h = ledgerHarness();
  const pending = h.load();
  h.requests[0].reject(new Error("offline"));
  await pending;
  assert.equal(h.nodes.get("#ledger-request-error").hidden, false);
  assert.match(h.nodes.get("#ledger-request-error-text").textContent, /上次成功加载/);
  assert.equal(h.nodes.get("#ledger-loading").hidden, true);
  assert.equal(h.nodes.get("#ledger-refresh").disabled, false);
  const retry = h.load();
  h.requests[1].resolve({ revision: 2 });
  await retry;
  assert.equal(h.nodes.get("#ledger-request-error").hidden, true);
  assert.equal(h.renders.length, 1);
});

test("actual ledger loader ignores late response and never hides a newer request's error", async () => {
  const h = ledgerHarness();
  const old = h.load();
  const latest = h.load();
  h.requests[1].reject(new Error("new request failed"));
  await latest;
  h.requests[0].resolve({ stale: true });
  await old;
  assert.equal(h.renders.length, 0);
  assert.equal(h.nodes.get("#ledger-request-error").hidden, false);
  assert.match(h.nodes.get("#ledger-request-error-text").textContent, /new request failed/);
});
