import { exactGoalMultipleRelations } from "./goal-multiples.js";

const state = {
  matches: [],
  selectedId: null,
  data: null,
  activeTab: "spf",
  spfPage: 1,
  hhadPage: 1,
  goalPage: 1,
  requestController: null,
  activeView: "single",
  ledgerLoaded: false,
  ledgerData: null,
  ledgerTab: "overview",
  ledgerSinglePage: 1,
  ledgerParlayPage: 1,
  ledgerExpandedFixtures: new Set(),
  ledgerExpandedParlays: new Set(),
  parlayLoaded: false,
  parlayCandidates: [],
  parlaySelected: new Set(),
  parlayMarkets: new Map(),
  parlayMode: "standard",
  parlayMethod: null,
  movementMarket: "spf",
  goalPairPolicy: null,
  modelConfig: null,
  adaptiveConfig: null,
  segmentConfig: null,
  goalZeroConfig: null,
  weightingConfig: null,
  movementConfig: null,
  smoothingConfig: null,
  challengerConfig: null,
  productionPolicy: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const MIN_PARLAY_LEG_ODDS = 1.7;
const pct = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const compactNumber = (value, maximumFractionDigits = 2) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toLocaleString("zh-CN", {
    useGrouping: false,
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
};
const signedPp = (value, digits = 1) => {
  const points = Number(value || 0) * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(digits)}pp`;
};
const oddsText = (values) => values.map((value) => Number(value).toFixed(2)).join(" / ");
const effectiveSamples = (prediction) =>
  Number(prediction?.weighting?.effectiveSamples || 0);
const weightingLabel = (prediction) =>
  prediction?.weighting?.enabled ? "距离加权" : "等权统计";
const stableProbabilities = (prediction) =>
  prediction?.stableEmpirical?.length
    ? prediction.stableEmpirical
    : prediction?.weightedEmpirical || prediction?.empirical || [];
const smoothingLabel = (prediction) =>
  prediction?.smoothing?.applied
    ? "稳定概率 · 已用于预测"
    : prediction?.smoothing?.referenceOnly
      ? "稳定概率 · 仅参考"
      : "稳定概率";
const sampleText = (prediction) =>
  !prediction
    ? "未开售"
    : prediction.weighting.enabled
    ? `${prediction.stats.total.toLocaleString()} 场 · 加权等效 ${effectiveSamples(prediction).toFixed(1)}`
    : `${prediction.stats.total.toLocaleString()} 场 · 等权`;
const ledgerSampleText = (prediction) =>
  !prediction
    ? "未开售"
    : prediction.weighting.enabled
    ? `${prediction.stats.total.toLocaleString()} / 核心 ${prediction.weighting.coreSamples.toLocaleString()} / 加权等效 ${effectiveSamples(prediction).toFixed(1)}`
    : `${prediction.stats.total.toLocaleString()} 场 / 等权统计`;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function predictionText(prediction, prefix = "") {
  if (prediction?.available === false) return "无相似样本";
  const labels = prediction?.topLabels?.length
    ? prediction.topLabels
    : [prediction?.predicted].filter(Boolean);
  if (!labels.length) return "—";
  const text = labels.map((label) => `${prefix}${label}`).join(" / ");
  return prediction.isTie ? `${text}并列` : text;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

async function loadMatches() {
  setLoading(true);
  try {
    const payload = await fetchJson("/api/matches");
    if (!state.modelConfig && payload.modelConfig) {
      applyModelConfig(
        payload.modelConfig,
        payload.productionPolicy,
        payload.adaptiveConfig,
        payload.segmentConfig,
        payload.goalZeroConfig,
        payload.weightingConfig,
        payload.movementConfig,
        payload.smoothingConfig,
        payload.challengerConfig,
      );
    }
    state.matches = payload.matches;
    state.selectedId = state.selectedId || state.matches[0]?.id;
    $("#match-count").textContent = `${state.matches.length} 场`;
    renderMatchList();
    if (state.selectedId) await loadPrediction();
  } catch (error) {
    showError(error);
  }
}

function setView(view) {
  state.activeView = view;
  $("#single-view").hidden = view !== "single";
  $("#parlay-view").hidden = view !== "parlay";
  $("#ledger-view").hidden = view !== "ledger";
  $$(".mode-button").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  if (view === "parlay" && !state.parlayLoaded) loadParlayCandidates();
  if (view === "ledger" && !state.ledgerLoaded) loadLedger({ settle: true });
}

const ledgerMarketNames = {
  spf: "胜平负",
  hhad: "让球胜平负",
  goals: "总进球",
  goalsPair: "总进球双选",
};

function ledgerDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function ledgerMetric(value, digits = 1) {
  return value === null || value === undefined ? "待结算" : pct(value, digits);
}

function ledgerProfit(value) {
  const amount = Number(value || 0);
  return `${amount >= 0 ? "+" : ""}${amount.toFixed(2)}`;
}

function renderLedgerMarkets(data) {
  $("#ledger-market-grid").innerHTML = ["spf", "hhad", "goals", "goalsPair"]
    .map((market) => {
      const metrics = data.byMarket?.[market] || {};
      const isPair = market === "goalsPair";
      const record =
        metrics.settled > 0
          ? `${metrics.correct} 中 / ${metrics.settled} 场`
          : "尚无已结算记录";
      return `
        <article class="ledger-market-card ${escapeHtml(market)}">
          <div>
            <span>${escapeHtml(ledgerMarketNames[market])}</span>
            <strong>${ledgerMetric(metrics.accuracy)}</strong>
          </div>
          <dl>
            <div><dt>留档</dt><dd>${Number(metrics.total || 0).toLocaleString()}</dd></div>
            <div><dt>待结算</dt><dd>${Number(metrics.pending || 0).toLocaleString()}</dd></div>
            <div><dt>实战记录</dt><dd>${escapeHtml(record)}</dd></div>
            <div><dt>${isPair ? "双注盈亏" : "模拟盈亏"}</dt><dd>${metrics.settled ? ledgerProfit(metrics.simulatedProfit) : "—"}</dd></div>
          </dl>
          ${isPair ? `<small class="ledger-cost-note">每场历史占比前两名，各投1注 · ROI ${ledgerMetric(metrics.roi)}</small>` : ""}
        </article>`;
    })
    .join("");
}

function renderLedgerRows(rows) {
  const body = $("#ledger-rows");
  if (!rows.length) {
    body.innerHTML =
      '<div class="ledger-empty">还没有赛前快照。系统会在使用验证后的默认规则时自动留档。</div>';
    return;
  }

  const fixtures = [];
  const fixtureById = new Map();
  for (const row of rows) {
    const key = String(
      row.matchId ||
        `${row.league}\u0000${row.home}\u0000${row.away}\u0000${row.capturedAt}`,
    );
    if (!fixtureById.has(key)) {
      const fixture = {
        key,
        matchId: row.matchId,
        capturedAt: row.capturedAt,
        league: row.league,
        home: row.home,
        away: row.away,
        rows: [],
      };
      fixtureById.set(key, fixture);
      fixtures.push(fixture);
    }
    fixtureById.get(key).rows.push(row);
  }

  const marketOrder = { spf: 0, hhad: 1, goals: 2 };
  body.innerHTML = fixtures
    .map((fixture, fixtureIndex) => {
      const expanded = state.ledgerExpandedFixtures.has(fixture.key);
      const fixtureRows = [...fixture.rows].sort(
        (left, right) =>
          (marketOrder[left.market] ?? 99) - (marketOrder[right.market] ?? 99),
      );
      const pendingCount = fixtureRows.filter(
        (row) => row.status !== "settled",
      ).length;
      const statusClass = pendingCount ? "pending" : "settled";
      const statusText = pendingCount
        ? `${pendingCount} 项待结算`
        : `${fixtureRows.length} 项已结算`;
      const marketRows = fixtureRows
        .map((row) => {
      const marketLine =
        row.market === "hhad" && Number.isFinite(Number(row.handicap))
          ? `${ledgerMarketNames[row.market]} (${Number(row.handicap) > 0 ? "+" : ""}${row.handicap})`
          : ledgerMarketNames[row.market];
      const result =
        row.status === "settled"
          ? `${escapeHtml(row.actualResult)}${row.score ? ` · ${escapeHtml(row.score)}` : ""}`
          : "等待赛果";
      const verdict =
        row.status !== "settled"
          ? `<span class="ledger-verdict pending">待结算</span>`
          : row.correct
            ? `<span class="ledger-verdict hit">命中</span>`
            : `<span class="ledger-verdict miss">未中</span>`;
      const goalPair = row.market === "goals" ? row.goalPair : null;
      const pairPrediction = goalPair?.available
        ? `<small class="ledger-pair-line">双选 ${escapeHtml(goalPair.labels.join(" / "))}球 · ${pct(goalPair.probability)}</small>`
        : "";
      const pairVerdict =
        row.status === "settled" && goalPair
          ? goalPair.correct
            ? `<span class="ledger-verdict pair hit">双选命中</span>`
            : `<span class="ledger-verdict pair miss">双选未中</span>`
          : "";
      const profitNote =
        row.status !== "settled"
          ? "只等待快照之后的新数据"
          : goalPair
            ? `单选 ${ledgerProfit(row.simulatedProfit)} · 双选 ${ledgerProfit(goalPair.simulatedProfit)}`
            : `模拟盈亏 ${ledgerProfit(row.simulatedProfit)}`;
      return `
        <div class="ledger-fixture-market scope-${row.sameLeague ? "same" : "all"}" role="row">
          <div class="ledger-market-name" role="cell">
            <strong>${escapeHtml(marketLine)}</strong>
            <small><b class="ledger-scope-badge">${escapeHtml(row.sampleScope || "全部联赛")}</b>${Number(row.samples || 0).toLocaleString()} 场相似</small>
          </div>
          <div role="cell">
            <span class="ledger-grade ${escapeHtml(row.reliabilityLevel)}">${escapeHtml(row.reliabilityLabel)}</span>
          </div>
          <div class="ledger-market-prediction" role="cell">
            <strong>${escapeHtml(row.predicted)}</strong>
            <small>${pct(row.selectedProbability)} · 赔率 ${Number(row.selectedOdds).toFixed(2)}</small>
            ${pairPrediction}
          </div>
          <div class="ledger-market-result" role="cell">
            <strong>${result}</strong>
            <small>${profitNote}</small>
          </div>
          <div class="ledger-market-verdict" role="cell">${verdict}${pairVerdict}</div>
        </div>`;
        })
        .join("");

      return `
        <article class="ledger-fixture-card" role="listitem" style="--fixture-index: ${fixtureIndex}">
          <button class="ledger-fixture-head ledger-fixture-toggle" type="button" data-fixture-key="${escapeHtml(encodeURIComponent(fixture.key))}" aria-expanded="${expanded}">
            <div class="ledger-fixture-sequence">${String(fixtures.length - fixtureIndex).padStart(2, "0")}</div>
            <div class="ledger-fixture-meta">
              <time datetime="${escapeHtml(fixture.capturedAt)}">${escapeHtml(ledgerDate(fixture.capturedAt))}</time>
              <span>${escapeHtml(fixture.league)}</span>
              ${fixture.matchId ? `<small>MATCH ${escapeHtml(fixture.matchId)}</small>` : ""}
            </div>
            <h3>${escapeHtml(fixture.home)} <span>vs</span> ${escapeHtml(fixture.away)}</h3>
            <strong class="ledger-fixture-status ${statusClass}">${statusText}</strong>
            <span class="ledger-expand-action">${expanded ? "收起" : "展开"}</span>
          </button>
          <div class="ledger-fixture-details" ${expanded ? "" : "hidden"}>
            <div class="ledger-fixture-columns" aria-hidden="true">
              <span>玩法</span><span>等级</span><span>赛前预测</span><span>实际赛果 / 盈亏</span><span>核对</span>
            </div>
            <div class="ledger-fixture-markets" role="table" aria-label="${escapeHtml(fixture.home)}对${escapeHtml(fixture.away)}的两种样本口径预测">
              ${marketRows}
            </div>
          </div>
        </article>`;
    })
    .join("");

  $$(".ledger-fixture-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const key = decodeURIComponent(button.dataset.fixtureKey);
      if (state.ledgerExpandedFixtures.has(key)) state.ledgerExpandedFixtures.delete(key);
      else state.ledgerExpandedFixtures.add(key);
      renderLedgerRows(rows);
    });
  });
}

function renderParlayLedger(parlays) {
  const totals = parlays?.filtered || parlays?.totals || {};
  const standard = parlays?.filtered?.byMode?.standard || parlays?.byMode?.standard || {};
  const goalsPair = parlays?.filtered?.byMode?.goalsPair || parlays?.byMode?.goalsPair || {};
  $("#ledger-parlay-summary").innerHTML = `
    <article>
      <span>已记录组合</span>
      <strong>${Number(totals.total || 0).toLocaleString()}</strong>
      <small>${Number(totals.pending || 0).toLocaleString()} 组待结算</small>
    </article>
    <article>
      <span>常规串关</span>
      <strong>${ledgerMetric(standard.accuracy)}</strong>
      <small>${Number(standard.correct || 0)} 中 / ${Number(standard.settled || 0)} 组</small>
    </article>
    <article>
      <span>进球双选串</span>
      <strong>${ledgerMetric(goalsPair.accuracy)}</strong>
      <small>${Number(goalsPair.correct || 0)} 中 / ${Number(goalsPair.settled || 0)} 组</small>
    </article>
    <article>
      <span>组合累计盈亏</span>
      <strong>${totals.settled ? ledgerProfit(totals.simulatedProfit) : "—"}</strong>
      <small>ROI ${ledgerMetric(totals.roi)}</small>
    </article>`;

  const rows = parlays?.rows || [];
  const body = $("#ledger-parlay-rows");
  if (!rows.length) {
    body.innerHTML =
      '<div class="ledger-empty">还没有保存串关。生成组合后，点击“记录此组合”才会进入这里。</div>';
    return;
  }
  body.innerHTML = rows
    .map((row, rowIndex) => {
      const expanded = state.ledgerExpandedParlays.has(String(row.id));
      const actualByMatch = new Map(
        (row.actualResults || []).map((result) => [
          String(result.matchId),
          result,
        ]),
      );
      const statusClass =
        row.status !== "settled"
          ? "pending"
          : row.correct
            ? "hit"
            : "miss";
      const statusText =
        row.status !== "settled"
          ? "待结算"
          : row.correct
            ? "整组命中"
            : "整组未中";
      const sourceText =
        row.selectionSource === "system_default" ? "系统默认" : "自选规则";
      const modeText =
        row.mode === "goalsPair"
          ? "进球双选 · 2串1"
          : `${row.legs.length}串1 · 常规`;
      const legs = row.legs
        .map((leg, legIndex) => {
          const actual = actualByMatch.get(String(leg.matchId));
          const picks = leg.selections
            .map((selection) => selection.label)
            .join(" / ");
          const odds = leg.selections
            .map((selection) => Number(selection.odds).toFixed(2))
            .join(" / ");
          return `
            <div class="ledger-parlay-leg">
              <span>${legIndex + 1}</span>
              <div>
                <small>${escapeHtml(leg.league)} · ${escapeHtml(leg.marketLabel)}</small>
                <strong>${escapeHtml(leg.home)} <em>vs</em> ${escapeHtml(leg.away)}</strong>
              </div>
              <div>
                <small>赛前选择</small>
                <strong>${escapeHtml(picks)} <i>@ ${escapeHtml(odds)}</i></strong>
              </div>
              <div>
                <small>实际赛果</small>
                <strong>${actual ? `${escapeHtml(actual.actualResult)}${leg.market === "goalsPair" ? "球" : ""} · ${escapeHtml(actual.score)}` : "等待赛果"}</strong>
              </div>
              <b class="${actual ? (actual.correct ? "hit" : "miss") : "pending"}">${actual ? (actual.correct ? "命中" : "未中") : "待定"}</b>
            </div>`;
        })
        .join("");
      return `
        <article class="ledger-parlay-card" style="--parlay-index:${rowIndex}">
          <button class="ledger-parlay-head ledger-parlay-toggle" type="button" data-parlay-id="${escapeHtml(String(row.id))}" aria-expanded="${expanded}">
            <div>
              <span>PARLAY ${String(row.id).padStart(3, "0")}</span>
              <time datetime="${escapeHtml(row.capturedAt)}">${escapeHtml(ledgerDate(row.capturedAt))}</time>
            </div>
            <strong>${escapeHtml(modeText)}</strong>
            <small>${escapeHtml(sourceText)}</small>
            <b class="${statusClass}">${statusText}</b>
            <span class="ledger-expand-action">${expanded ? "收起" : "展开"}</span>
          </button>
          <div class="ledger-parlay-details" ${expanded ? "" : "hidden"}>
            <div class="ledger-parlay-legs">${legs}</div>
            <footer>
              <span>成本 <strong>${Number(row.totalStake).toFixed(0)} 注</strong></span>
              <span>赛前估算 <strong>${pct(row.hitProbability, 2)}</strong></span>
              <span>回报指数 <strong>${Number(row.valueIndex).toFixed(3)}</strong></span>
              <span>实际盈亏 <strong>${row.status === "settled" ? ledgerProfit(row.simulatedProfit) : "待结算"}</strong></span>
            </footer>
          </div>
        </article>`;
    })
    .join("");

  $$(".ledger-parlay-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const id = String(button.dataset.parlayId);
      if (state.ledgerExpandedParlays.has(id)) state.ledgerExpandedParlays.delete(id);
      else state.ledgerExpandedParlays.add(id);
      renderParlayLedger(parlays);
    });
  });
}

function setLedgerTab(tab) {
  state.ledgerTab = ["overview", "single", "parlay"].includes(tab)
    ? tab
    : "overview";
  $$('[data-ledger-tab]').forEach((button) => {
    const active = button.dataset.ledgerTab === state.ledgerTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $$('[data-ledger-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.ledgerPanel !== state.ledgerTab;
  });
}

function populateLedgerLeagues(leagues = []) {
  const select = $("#ledger-single-league");
  const current = select.value || "all";
  select.innerHTML = [
    '<option value="all">全部联赛</option>',
    ...leagues.map(
      (league) => `<option value="${escapeHtml(league)}">${escapeHtml(league)}</option>`,
    ),
  ].join("");
  select.value = leagues.includes(current) ? current : "all";
}

function renderLedgerPagination(prefix, pageData = {}) {
  const page = Number(pageData.page || 1);
  const totalPages = Number(pageData.totalPages || 1);
  const totalItems = Number(pageData.totalItems || 0);
  $(`#ledger-${prefix}-page`).textContent =
    `第 ${page} / ${totalPages} 页 · 共 ${totalItems.toLocaleString()} ${prefix === "single" ? "场" : "组"}`;
  $(`#ledger-${prefix}-prev`).disabled = page <= 1;
  $(`#ledger-${prefix}-next`).disabled = page >= totalPages;
}

function ledgerRequestParams(settle = false) {
  return new URLSearchParams({
    settle: String(settle),
    pageSize: "20",
    singleStatus: $("#ledger-single-status").value,
    singleMarket: $("#ledger-single-market").value,
    singleScope: $("#ledger-single-scope").value,
    singleLeague: $("#ledger-single-league").value,
    singleQuery: $("#ledger-single-query").value.trim(),
    singleFrom: $("#ledger-single-from").value,
    singleTo: $("#ledger-single-to").value,
    singlePage: String(state.ledgerSinglePage),
    parlayStatus: $("#ledger-parlay-status").value,
    parlayMode: $("#ledger-parlay-mode").value,
    parlaySource: $("#ledger-parlay-source").value,
    parlayQuery: $("#ledger-parlay-query").value.trim(),
    parlayFrom: $("#ledger-parlay-from").value,
    parlayTo: $("#ledger-parlay-to").value,
    parlayPage: String(state.ledgerParlayPage),
  });
}

function renderLedger(data) {
  state.ledgerData = data;
  const recommended = data.byReliability?.recommended || {};
  const parlayTotals = data.parlays?.totals || {};
  $("#ledger-policy-version").textContent = data.policyVersion || "—";
  $("#ledger-policy-version").title = data.policyVersion || "";
  $("#ledger-source-updated").textContent = data.sourceUpdatedAt
    ? `历史库更新 ${ledgerDate(data.sourceUpdatedAt)}`
    : "历史库时间未知";
  const pendingTotal =
    Number(data.totals?.pendingFixtures || 0) + Number(parlayTotals.pending || 0);
  $("#ledger-pending").textContent = pendingTotal.toLocaleString();
  $("#ledger-pending-detail").textContent =
    `${Number(data.totals?.pendingFixtures || 0)} 场单场 · ${Number(parlayTotals.pending || 0)} 组串关`;
  $("#ledger-single-accuracy").textContent = ledgerMetric(recommended.accuracy);
  $("#ledger-single-record").textContent = recommended.settled
    ? `${recommended.correct} 中 / ${recommended.settled} 条已结算`
    : "等待首批结算";
  $("#ledger-parlay-accuracy").textContent = ledgerMetric(parlayTotals.accuracy);
  $("#ledger-parlay-record").textContent = parlayTotals.settled
    ? `${parlayTotals.correct} 中 / ${parlayTotals.settled} 组已结算`
    : "等待首批结算";
  const combinedProfit =
    Number(recommended.simulatedProfit || 0) + Number(parlayTotals.simulatedProfit || 0);
  const combinedStake =
    Number(recommended.settled || 0) + Number(parlayTotals.stakeUnits || 0);
  $("#ledger-total-profit").textContent = combinedStake
    ? ledgerProfit(combinedProfit)
    : "待结算";
  $("#ledger-total-roi").textContent = combinedStake
    ? `合计 ROI ${ledgerMetric(combinedProfit / combinedStake)}`
    : "单场建议与已保存串关合计";
  const settledTotal =
    Number(data.settledNow || 0) + Number(data.parlaySettledNow || 0);
  $("#ledger-settlement-note").textContent = settledTotal
    ? `本次刷新新结算 ${Number(data.settledNow || 0)} 条单场、${Number(data.parlaySettledNow || 0)} 组串关；只匹配快照之后新增的历史行。`
    : "未发现新赛果；只用快照之后新增的历史行结算。";
  renderLedgerMarkets(data);
  renderParlayLedger(data.parlays);
  renderLedgerRows(data.rows || []);
  populateLedgerLeagues(data.filters?.leagues || []);
  const singleFiltered = data.filtered || {};
  $("#ledger-single-summary").innerHTML = `
    <span><strong>${Number(singleFiltered.fixtures || 0).toLocaleString()}</strong> 场</span>
    <span>命中率 <strong>${ledgerMetric(singleFiltered.accuracy)}</strong></span>
    <span>盈亏 <strong>${singleFiltered.settled ? ledgerProfit(singleFiltered.simulatedProfit) : "—"}</strong></span>`;
  const parlayFiltered = data.parlays?.filtered || {};
  $("#ledger-parlay-filter-summary").innerHTML = `
    <span><strong>${Number(parlayFiltered.total || 0).toLocaleString()}</strong> 组</span>
    <span>命中率 <strong>${ledgerMetric(parlayFiltered.accuracy)}</strong></span>
    <span>盈亏 <strong>${parlayFiltered.settled ? ledgerProfit(parlayFiltered.simulatedProfit) : "—"}</strong></span>`;
  renderLedgerPagination("single", data.page);
  renderLedgerPagination("parlay", data.parlays?.page);
  setLedgerTab(state.ledgerTab);
}

async function loadLedger({ settle = false } = {}) {
  const refresh = $("#ledger-refresh");
  refresh.disabled = true;
  refresh.classList.add("busy");
  $("#ledger-loading").hidden = false;
  try {
    const data = await fetchJson(`/api/ledger?${ledgerRequestParams(settle)}`);
    state.ledgerLoaded = true;
    renderLedger(data);
  } catch (error) {
    $("#ledger-loading").textContent = `实战账本读取失败：${error.message}`;
  } finally {
    $("#ledger-loading").hidden = state.ledgerLoaded;
    refresh.disabled = false;
    refresh.classList.remove("busy");
  }
}

function renderMatchList(query = "") {
  const normalized = query.trim().toLowerCase();
  const matches = state.matches.filter((match) =>
    `${match.displayName} ${match.league}`.toLowerCase().includes(normalized),
  );
  $("#match-list").innerHTML = matches
    .map((match) => {
      const active = match.id === state.selectedId ? "active" : "";
      const hasSpf = Boolean(match.had);
      const fallback = match.hhad;
      const odds = hasSpf
        ? [match.had.h, match.had.d, match.had.a]
        : fallback
          ? [fallback.h, fallback.d, fallback.a]
          : [];
      const handicap = Number(fallback?.goalLine);
      const marketText = hasSpf
        ? oddsText(odds)
        : fallback
          ? `仅让球 ${handicap > 0 ? "+" : ""}${handicap}　${oddsText(odds)}`
          : "普通胜平负未开售";
      return `
        <button class="match-button ${active} ${hasSpf ? "" : "limited-market"}" data-id="${escapeHtml(match.id)}">
          <span class="league-monogram">${escapeHtml(match.league.slice(0, 2))}</span>
          <span>
            <strong>${escapeHtml(match.home)} · ${escapeHtml(match.away)}</strong>
            <small>${escapeHtml(match.league)}　${escapeHtml(marketText)}</small>
            ${hasSpf ? "" : '<em class="market-status">普通胜平负未开售</em>'}
          </span>
        </button>`;
    })
    .join("");

  $$(".match-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.id;
      state.spfPage = 1;
      state.hhadPage = 1;
      state.goalPage = 1;
      renderMatchList($("#match-search").value);
      loadPrediction();
    });
  });
}

function predictionUrl() {
  const params = new URLSearchParams({
    matchId: state.selectedId,
    spfTolerance: Number($("#spf-tolerance").value) / 100,
    hhadTolerance: Number($("#hhad-tolerance").value) / 100,
    goalTolerance: Number($("#goal-tolerance").value) / 1000,
    sameLeague: $("#parlay-scope").value === "same",
    spfPage: state.spfPage,
    hhadPage: state.hhadPage,
    goalPage: state.goalPage,
    pageSize: 18,
  });
  return `/api/predict?${params}`;
}

function recommendationValues() {
  const markets = state.modelConfig?.markets;
  const thresholds = state.productionPolicy?.thresholds;
  if (!markets || !thresholds) return null;
  return {
    spf: Math.round(thresholds.spf * 100),
    hhad: Math.round(thresholds.hhad * 100),
    goals: Math.round(thresholds.goals * 1000),
  };
}

function validatedThresholdText(value, market) {
  return market === "goals"
    ? `${(Number(value) * 100).toFixed(1)}pp`
    : `${(Number(value) * 100).toFixed(0)}%`;
}

function thresholdValidationStatus({ excludeGoals = false } = {}) {
  const names = { spf: "胜平负", hhad: "让球", goals: "进球" };
  return Object.entries(names)
    .map(([market, name]) => {
      if (excludeGoals && market === "goals") return null;
      const config = state.modelConfig?.markets?.[market];
      if (!config) return null;
      const production = validatedThresholdText(config.threshold, market);
      const current = validatedThresholdText(
        config.currentThreshold,
        market,
      );
      const candidate = validatedThresholdText(
        config.candidateThreshold,
        market,
      );
      return config.changed
        ? config.gate?.significancePassed
          ? `${name}${current}→${production}·严格通过`
          : `${name}${current}→${production}·观察中`
        : config.gate?.validationPassed &&
            !config.gate?.significancePassed &&
            Math.abs(
              Number(config.candidateThreshold) -
                Number(config.currentThreshold),
            ) > 1e-12
          ? `${name}${candidate}无明确优势·保留${production}`
        : `${name}回测保留${production}`;
    })
    .filter(Boolean)
    .join("、");
}

function updateModelConfigStatus() {
  const recommended = recommendationValues();
  if (!recommended) return;
  const thresholdStale = Boolean(state.modelConfig?.stale);
  const advancedStale = Boolean(
    state.weightingConfig?.stale ||
    state.movementConfig?.stale ||
    state.smoothingConfig?.stale ||
    state.challengerConfig?.stale,
  );
  const requested = {
    spf: Number($("#spf-tolerance").value),
    hhad: Number($("#hhad-tolerance").value),
    goals: Number($("#goal-tolerance").value),
  };
  const effective = state.data?.settings?.effectiveThresholds;
  const current = effective
    ? {
        spf: Number(effective.spf) * 100,
        hhad: Number(effective.hhad) * 100,
        goals: Number(effective.goals) * 1000,
      }
    : requested;
  const deviations = [
    requested.spf !== recommended.spf ? "胜平负" : null,
    requested.hhad !== recommended.hhad ? "让球" : null,
    requested.goals !== recommended.goals ? "进球" : null,
  ].filter(Boolean);
  const sameLeague = $("#same-league").checked;
  const adaptiveApplied = Object.values(
    state.data?.settings?.adaptive || {},
  ).some((scope) => scope?.enabled);
  const segmentedApplied = Object.values(
    state.data?.settings?.segmentation || {},
  ).some((scope) => scope?.enabled);
  const segmentedScopes = state.data?.settings?.segmentation || {};
  const zeroOddsScope = state.data?.settings?.zeroOdds;
  const zeroOddsApplied = Boolean(zeroOddsScope?.enabled);
  $("#spf-tolerance-label").textContent = `${compactNumber(requested.spf)}%`;
  $("#hhad-tolerance-label").textContent = `${compactNumber(requested.hhad)}%`;
  $("#goal-tolerance-label").textContent =
    `${compactNumber(requested.goals / 10)}pp`;
  if (segmentedScopes.spf?.enabled) {
    $("#spf-tolerance-label").textContent =
      `${compactNumber(requested.spf)}% → 本场 ${compactNumber(current.spf)}%`;
  }
  if (segmentedScopes.hhad?.enabled) {
    $("#hhad-tolerance-label").textContent =
      `${compactNumber(requested.hhad)}% → 本场 ${compactNumber(current.hhad)}%`;
  }
  if (segmentedScopes.goals?.enabled) {
    $("#goal-tolerance-label").textContent =
      `${compactNumber(requested.goals / 10)}pp → 本场 ${compactNumber(current.goals / 10)}pp`;
  }
  if (zeroOddsApplied) {
    $("#goal-tolerance-label").textContent = "五档区间";
  }
  const scopeLabel = zeroOddsApplied
    ? "本场0球赔率区间采用"
    : segmentedApplied
    ? "本场赔率类型采用"
    : adaptiveApplied
      ? "本场动态采用"
      : "当前使用";
  const goalScopeText = zeroOddsApplied
    ? `0球${zeroOddsScope.intervalLabel || "五档"}${zeroOddsScope.distanceEnabled ? ` · 七项≤${compactNumber(Number(zeroOddsScope.threshold) * 100)}pp` : " · 整档统计"}`
    : `${compactNumber(current.goals / 10)}pp`;
  $("#control-scope-summary").textContent =
    `${scopeLabel}：${sameLeague ? "只匹配同联赛" : "全部联赛"} · 胜平负 ±${compactNumber(current.spf)}% · 让球 ±${compactNumber(current.hhad)}% · 进球 ${goalScopeText}`;
  $("#model-config-status").textContent = deviations.length
    ? `${deviations.join("、")}使用自定义阈值`
    : thresholdStale
      ? "数据库已更新 · 三项阈值待重新验证"
      : `最新回测：${thresholdValidationStatus({ excludeGoals: zeroOddsApplied })}`;
  if (state.adaptiveConfig) {
    const adaptiveEnabled = Object.values(
      state.adaptiveConfig.markets || {},
    ).some((market) => market?.enabled);
    $("#model-config-status").textContent += state.adaptiveConfig.stale
      ? " · 动态范围待验证"
      : adaptiveEnabled
        ? " · 动态范围已启用"
        : " · 动态范围未胜出";
  }
  if (state.goalZeroConfig) {
    $("#model-config-status").textContent += state.goalZeroConfig.stale
      ? " · 0球区间待验证"
      : state.goalZeroConfig.enabled
        ? " · 进球五档区间已验证并启用"
        : " · 0球区间未通过";
  }
  if (advancedStale) {
    $("#model-config-status").textContent +=
      " · 高级修正待重新验证并已停用";
  }
}

function updateToleranceLabels() {
  $("#spf-tolerance-label").textContent = `${$("#spf-tolerance").value}%`;
  $("#hhad-tolerance-label").textContent = `${$("#hhad-tolerance").value}%`;
  $("#goal-tolerance-label").textContent =
    `${(Number($("#goal-tolerance").value) / 10).toFixed(1)}pp`;
  updateModelConfigStatus();
}

function applyModelConfig(
  config,
  policy,
  adaptiveConfig,
  segmentConfig,
  goalZeroConfig,
  weightingConfig,
  movementConfig,
  smoothingConfig,
  challengerConfig,
) {
  state.modelConfig = config;
  state.productionPolicy = policy;
  state.adaptiveConfig = adaptiveConfig;
  state.segmentConfig = segmentConfig;
  state.goalZeroConfig = goalZeroConfig;
  state.weightingConfig = weightingConfig;
  state.movementConfig = movementConfig;
  state.smoothingConfig = smoothingConfig;
  state.challengerConfig = challengerConfig;
  const recommended = recommendationValues();
  if (!recommended) return;
  $("#spf-tolerance").value = recommended.spf;
  $("#hhad-tolerance").value = recommended.hhad;
  $("#goal-tolerance").value = recommended.goals;
  const recommendationText = (market, value) => {
    const marketConfig = config.markets?.[market];
    if (config.stale) return `待验证 ${value}`;
    if (marketConfig?.changed && marketConfig.gate?.significancePassed) {
      return `严格通过 ${value}`;
    }
    if (marketConfig?.changed) return `回测更好·观察中 ${value}`;
    return `回测保留 ${value}`;
  };
  $("#spf-recommendation").textContent =
    recommendationText("spf", `${recommended.spf}%`);
  $("#hhad-recommendation").textContent =
    recommendationText("hhad", `${recommended.hhad}%`);
  $("#goal-recommendation").textContent =
    goalZeroConfig?.enabled && !goalZeroConfig?.stale
      ? "五档区间已验证"
      : recommendationText(
          "goals",
          `${(recommended.goals / 10).toFixed(1)}pp`,
        );
  updateToleranceLabels();
}

async function loadPrediction({ quiet = false } = {}) {
  if (!state.selectedId) return;
  state.requestController?.abort();
  state.requestController = new AbortController();
  if (!quiet) setLoading(true);
  try {
    const payload = await fetchJson(predictionUrl(), {
      signal: state.requestController.signal,
    });
    state.data = payload;
    renderDashboard();
    setLoading(false);
  } catch (error) {
    if (error.name !== "AbortError") showError(error);
  }
}

function renderDashboard() {
  const { match, spf, hhad, goals, stability, method, dataStats } = state.data;
  updateModelConfigStatus();
  const primary = spf || hhad;
  const primaryMarket = spf ? "spf" : hhad ? "hhad" : null;
  const primaryOdds = spf ? match.had : hhad ? match.hhad : null;
  const primaryAvailable = Boolean(primary && primary.available !== false);
  const goalsAvailable = Boolean(goals && goals.available !== false);
  const primaryLabels =
    primaryMarket === "hhad"
      ? ["让胜", "让平", "让负"]
      : ["主胜", "平局", "客胜"];
  $("#league-badge").textContent = match.league;
  $("#match-id").textContent = `MATCH ${match.id}`;
  $("#home-team").textContent = match.home;
  $("#away-team").textContent = match.away;
  $("#primary-market-label").textContent =
    primaryMarket === "hhad"
      ? `让球胜平负预测 · ${hhad.handicap > 0 ? "+" : ""}${hhad.handicap}`
      : primaryMarket === "spf"
        ? "胜平负预测"
        : "暂无三项玩法";
  $("#prediction-label").textContent = predictionText(
    primary,
    primaryMarket === "hhad" ? "让" : "",
  );
  $(".prediction-seal").classList.toggle("tie", Boolean(primary?.isTie));
  $("#confidence-label").textContent = primaryAvailable
    ? `置信度 ${primary.confidence}`
    : primary
      ? "无法生成历史预测"
      : "普通胜平负与让球均未开售";
  $("#spf-hero-sample").textContent =
    primary?.weighting?.enabled
      ? `相似 ${primary.stats.total.toLocaleString()} · 加权等效 ${effectiveSamples(primary).toFixed(1)}`
      : primary
        ? `相似样本 ${primary.stats.total.toLocaleString()} 场 · 等权`
        : "无可用三项赔率";
  ["win", "draw", "loss"].forEach((key, index) => {
    $(`#prob-label-${key}`).textContent = primaryLabels[index];
    $(`#prob-${key}`).textContent = primaryAvailable
      ? pct(primary.final[index])
      : "—";
  });
  $("#odds-win").textContent = primaryOdds
    ? `赔率 ${Number(primaryOdds.h).toFixed(2)}`
    : "赔率 —";
  $("#odds-draw").textContent = primaryOdds
    ? `赔率 ${Number(primaryOdds.d).toFixed(2)}`
    : "赔率 —";
  $("#odds-loss").textContent = primaryOdds
    ? `赔率 ${Number(primaryOdds.a).toFixed(2)}`
    : "赔率 —";
  $("#expected-goals").textContent = Number.isFinite(goals?.expected)
    ? goals.expected.toFixed(2)
    : "—";
  $("#top-goals").textContent = goalsAvailable
    ? `精确首选 ${goals.predicted} 球`
    : "无相似进球样本";
  const goalPair = goals?.goalPair;
  $("#goal-exact-label").textContent = goalsAvailable
    ? `${goals.predicted}球`
    : "—";
  $("#goal-pair-label").textContent =
    goalsAvailable && goalPair?.available
      ? `${goalPair.labels.join(" / ")}球`
      : "—";
  $("#goal-pair-probability").textContent =
    goalsAvailable && goalPair?.available
      ? pct(goalPair.probability)
      : "—";
  $("#goal-pair-meter").style.width =
    goalsAvailable && goalPair?.available
      ? `${Math.min(100, goalPair.probability * 100)}%`
      : "0%";
  $("#goal-pair-odds").textContent =
    goalsAvailable && goalPair?.odds?.length === 2
      ? `对应赔率 ${goalPair.odds.map((odd) => Number(odd).toFixed(2)).join(" / ")} · 两注成本`
      : "每场按两个选项、两注成本独立统计";
  $("#spf-sample-chip").textContent = sampleText(primary);
  $("#goal-sample-chip").textContent = sampleText(goals);
  $("#control-spf-samples").textContent = ledgerSampleText(spf);
  $("#control-hhad-samples").textContent = hhad
    ? ledgerSampleText(hhad)
    : "未开售";
  $("#control-goal-samples").textContent = ledgerSampleText(goals);
  $("#method-note").textContent = [method.spf, method.hhad, method.goals]
    .filter(Boolean)
    .join("；");
  $("#prediction-method-legend").textContent = smoothingLabel(primary);
  $("#probability-panel-title").textContent =
    primaryMarket === "hhad"
      ? "让球胜平负：市场、原始占比与稳定概率"
      : "胜平负：市场、原始占比与稳定概率";
  $("#history-stats").textContent =
    `统一已校验 ${dataStats.verifiedHistory.toLocaleString()} / 全部统一比赛 ${dataStats.unifiedHistory.toLocaleString()}`;
  $("#spf-tolerance").disabled = !spf;
  syncHistoryTabs({ spf: Boolean(spf), hhad: Boolean(hhad), goals: Boolean(goals) });

  renderHhad(hhad, match.hhad);
  renderReliability(spf, hhad, goals);
  renderStability(stability);
  renderProbabilityBars(primary, primaryMarket);
  renderMovementInsights(spf, hhad, goals);
  renderSmoothingInsights(spf, hhad, goals);
  updateAdvancedCorrections(spf, hhad, goals);
  renderOutcomeDonut(spf, hhad);
  renderGoalChart(goals);
  const movementAvailability = {
    spf: Boolean(match.hadTimeline?.length),
    hhad: Boolean(match.hhadTimeline?.length),
    goals: Boolean(match.goalTimeline?.length),
  };
  if (!movementAvailability[state.movementMarket]) {
    state.movementMarket = ["spf", "hhad", "goals"].find(
      (market) => movementAvailability[market],
    ) || "spf";
  }
  renderMovementPanel();
  renderHistoryTable();
}

function reliabilityCard(title, prediction) {
  const reliability = prediction?.reliability;
  if (!reliability) {
    return `
      <article class="reliability-card skip">
        <header><span>${escapeHtml(title)}</span><strong>建议跳过</strong></header>
        <div class="reliability-current unavailable">
          <div><small>当前预测</small><b>没有可用结果</b></div>
        </div>
        <p class="reliability-plain-reason">当前比赛没有该玩法赔率，或没有找到可用的相似历史比赛。</p>
      </article>`;
  }
  const observed = reliability.observed || {};
  const test = reliability.test;
  const labels = prediction.topLabels?.length
    ? prediction.topLabels
    : [prediction.predicted].filter(Boolean);
  const currentPrediction = labels.length
    ? labels
        .map((label) =>
          title === "总进球"
            ? `${label}球`
            : title === "让球胜平负"
              ? `让${label}`
              : label,
        )
        .join(" / ")
    : "没有可用结果";
  const currentProbability = Math.max(
    0,
    ...(prediction.final || prediction.empirical || [0]).map(Number),
  );
  const oldVerified = Number(
    state.challengerConfig?.data?.verifiedMatches || 0,
  );
  const currentVerified = Number(
    state.data?.dataStats?.verifiedHistory || 0,
  );
  const addedMatches = Math.max(0, currentVerified - oldVerified);
  const stale = String(reliability.reason || "").includes("历史数据已更新");
  const plainReason = stale
    ? addedMatches
      ? `历史库比上次验证新增了 ${addedMatches} 场比赛，这套筛选规则还没用新数据重新验证。`
      : "历史库已经更新，这套筛选规则还没用新数据重新验证。"
    : reliability.reason;
  const statusText =
    reliability.level === "recommended"
      ? "可以重点参考"
      : reliability.level === "skip"
        ? "建议跳过"
        : "谨慎参考";
  const oldMetrics = test
    ? `<div><span>上次测试场次</span><strong>${Number(test.selected || 0).toLocaleString()} 场</strong></div>
       <div><span>上次测试命中</span><strong>${pct(test.selectedAccuracy || 0, 1)}</strong></div>
       <div><span>筛选覆盖范围</span><strong>${pct(test.coverage || 0, 1)}</strong></div>`
    : `<div><span>历史验证</span><strong>尚无可用结果</strong></div>`;
  return `
    <article class="reliability-card ${escapeHtml(reliability.level)}">
      <header>
        <span>${escapeHtml(title)}</span>
        <strong>${escapeHtml(statusText)}</strong>
      </header>
      <div class="reliability-current">
        <div>
          <small>当前预测</small>
          <b>${escapeHtml(currentPrediction)}</b>
        </div>
        <div>
          <small>当前概率</small>
          <b>${pct(currentProbability, 1)}</b>
        </div>
        <div>
          <small>相似比赛</small>
          <b>${Number(observed.samples || 0).toLocaleString()} 场</b>
        </div>
      </div>
      <p class="reliability-plain-reason">${escapeHtml(plainReason)}</p>
      <details class="reliability-details">
        <summary>查看验证详情</summary>
        <p>以下是筛选规则的历史验证，不是本场比赛的预测概率。</p>
        <div class="reliability-detail-grid">
          ${oldMetrics}
          <div><span>当前第一名领先</span><strong>${pct(observed.margin || 0, 1)}</strong></div>
          <div><span>不同阈值方向</span><strong>${observed.stable ? "一致" : "有变化"}</strong></div>
        </div>
      </details>
    </article>`;
}

function renderReliability(spf, hhad, goals) {
  $("#reliability-cards").innerHTML = [
    reliabilityCard("胜平负", spf),
    reliabilityCard("让球胜平负", hhad),
    reliabilityCard("总进球", goals),
  ].join("");
}

function stabilityPredictionText(point, market) {
  if (!point.available) return "无样本";
  const labels = point.topLabels?.length
    ? point.topLabels
    : [point.predicted].filter(Boolean);
  const formatted = labels.map((label) =>
    market === "hhad"
      ? `让${label}`
      : market === "goals"
        ? `${label}球`
        : label,
  );
  return `${formatted.join(" / ")}${point.isTie ? "并列" : ""}`;
}

function stabilityThresholdText(value, market) {
  return market === "goals"
    ? `${(value * 100).toFixed(1)}pp`
    : `${(value * 100).toFixed(0)}%`;
}

function stabilityCard(title, market, analysis) {
  if (!analysis) {
    return `
      <article class="stability-card insufficient">
        <header><span>${escapeHtml(title)}</span><strong>未接入</strong></header>
        <p>当前比赛没有该玩法赔率。</p>
      </article>`;
  }
  const statusText =
    analysis.status === "stable"
      ? `方向稳定 · ${stabilityPredictionText({ available: true, predicted: analysis.direction, topLabels: [analysis.direction], isTie: false }, market)}`
      : analysis.status === "unstable"
        ? "方向不稳定"
        : "样本不足或存在并列";
  const points = analysis.points
    .map((point) => {
      const selected =
        Math.abs(point.threshold - analysis.selectedThreshold) < 1e-9
          ? "selected"
          : "";
      return `
        <li class="${selected}">
          <span>${stabilityThresholdText(point.threshold, market)}</span>
          <strong>${escapeHtml(stabilityPredictionText(point, market))}</strong>
          <small>${point.samples.toLocaleString()} 场${point.available ? ` · ${pct(point.topProbability)}` : ""}</small>
        </li>`;
    })
    .join("");
  return `
    <article class="stability-card ${analysis.status}">
      <header>
        <span>${escapeHtml(title)}</span>
        <strong>${escapeHtml(statusText)}</strong>
      </header>
      <ol>${points}</ol>
    </article>`;
}

function renderStability(stability) {
  $("#stability-grid").innerHTML = [
    stabilityCard("胜平负", "spf", stability?.spf),
    stabilityCard("让球胜平负", "hhad", stability?.hhad),
    stabilityCard("总进球", "goals", stability?.goals),
  ].join("");
}

function renderHhad(hhad, market) {
  $("#hhad-deck").hidden = !hhad || !market;
  if (!hhad || !market) return;
  const available = hhad.available !== false;
  const line = `${hhad.handicap > 0 ? "+" : ""}${hhad.handicap}`;
  $("#hhad-line").textContent = line;
  $("#hhad-prediction-label").textContent = predictionText(hhad, "让");
  $(".hhad-prediction").classList.toggle("tie", Boolean(hhad.isTie));
  $("#hhad-confidence-label").textContent = available
    ? `置信度 ${hhad.confidence}`
    : "无法生成历史预测";
  $("#hhad-prob-win").textContent = available ? pct(hhad.final[0]) : "—";
  $("#hhad-prob-draw").textContent = available ? pct(hhad.final[1]) : "—";
  $("#hhad-prob-loss").textContent = available ? pct(hhad.final[2]) : "—";
  $("#hhad-odds-win").textContent = `赔率 ${Number(market.h).toFixed(2)}`;
  $("#hhad-odds-draw").textContent = `赔率 ${Number(market.d).toFixed(2)}`;
  $("#hhad-odds-loss").textContent = `赔率 ${Number(market.a).toFixed(2)}`;
  $("#hhad-sample-count").textContent = `${hhad.stats.total.toLocaleString()} 场`;
  const matchingLabel = hhad.matchingLabel || "让球单盘口匹配";
  $("#hhad-weighting-note").textContent =
    hhad.weighting.enabled
      ? `${matchingLabel} · 核心 ${hhad.weighting.coreSamples.toLocaleString()} · 加权等效 ${effectiveSamples(hhad).toFixed(1)}`
      : `${matchingLabel} · 等权统计`;
  $("#hhad-movement-note").textContent = hhad.movement?.referenceOnly
    ? `走势验证未通过 · ${hhad.movement.sampleSize.toLocaleString()} 场仅参考`
    : hhad.movement?.applied
      ? `走势验证通过 · ${hhad.movement.sampleSize.toLocaleString()} 场按 ${pct(hhad.movement.weight)} 修正`
      : "本场走势无有效修正 · 使用基础预测";
}

function renderProbabilityBars(prediction, market = "spf") {
  if (!prediction) {
    $("#probability-bars").innerHTML =
      '<div class="empty-state">本场没有可用的胜平负类赔率</div>';
    return;
  }
  const stable = stableProbabilities(prediction);
  const prefix = market === "hhad" ? "让" : "";
  $("#probability-bars").innerHTML = prediction.labels
    .map(
      (label, index) => `
      <div class="prob-row">
        <strong>${prefix}${label}</strong>
        <div class="bar-stack" aria-label="${prefix}${label}三层概率">
          <div class="bar-track"><div class="bar-fill market" style="width:${prediction.market[index] * 100}%"></div></div>
          <div class="bar-track"><div class="bar-fill history" style="width:${prediction.empirical[index] * 100}%"></div></div>
          <div class="bar-track"><div class="bar-fill model" style="width:${stable[index] * 100}%"></div></div>
        </div>
        <span>${prediction.available === false ? "—" : pct(stable[index])}</span>
      </div>`,
    )
    .join("");
}

function smoothingInsightCard(title, prediction, labels) {
  const smoothing = prediction?.smoothing;
  if (!prediction || !smoothing || prediction.available === false) {
    return `
      <article class="smoothing-insight unavailable">
        <header><span>${escapeHtml(title)}</span><strong>无基础样本</strong></header>
        <p>没有相似历史比赛，不使用先验生成预测。</p>
      </article>`;
  }
  if (!smoothing.strength) {
    return `
      <article class="smoothing-insight unavailable">
        <header><span>${escapeHtml(title)}</span><strong>未配置</strong></header>
        <p>最终概率继续使用原始历史占比。</p>
      </article>`;
  }
  const strongest = smoothing.adjustment
    .map((value, index) => ({ value, index }))
    .sort((left, right) => Math.abs(right.value) - Math.abs(left.value))[0];
  const status = smoothing.applied ? "验证通过 · 已采用" : "改善未显著 · 仅参考";
  const className = smoothing.applied ? "active" : "reference";
  return `
    <article class="smoothing-insight ${className}">
      <header>
        <span>${escapeHtml(title)}</span>
        <strong>${escapeHtml(status)}</strong>
      </header>
      <div class="smoothing-source">
        <b>${escapeHtml(smoothing.prior.sourceLabel)}</b>
        <span>${smoothing.prior.sampleSize.toLocaleString()} 场</span>
      </div>
      <p>先验强度 ${smoothing.strength}；原始 ${prediction.stats.total.toLocaleString()} 场仍完整保留。</p>
      <small>最大变化：${escapeHtml(labels[strongest.index])} ${signedPp(strongest.value)}${smoothing.applied ? "，已进入最终概率" : "，不影响最终预测"}</small>
    </article>`;
}

function renderSmoothingInsights(spf, hhad, goals) {
  const applied = [spf, hhad, goals].filter(
    (prediction) => prediction?.smoothing?.applied,
  ).length;
  $("#smoothing-policy").textContent = applied
    ? `${applied} 个玩法通过严格验证并启用`
    : "三个玩法均未通过显著性门禁 · 仅作稳定参考";
  $("#smoothing-insights").innerHTML = [
    smoothingInsightCard("胜平负", spf, ["主胜", "平局", "客胜"]),
    smoothingInsightCard("让球胜平负", hhad, ["让胜", "让平", "让负"]),
    smoothingInsightCard(
      "总进球",
      goals,
      goals.labels.map((label) => `${label}球`),
    ),
  ].join("");
}

function updateAdvancedCorrections(spf, hhad, goals) {
  const markets = [
    ["胜平负", spf],
    ["让球胜平负", hhad],
    ["总进球", goals],
  ];
  const movement = markets
    .filter(([, prediction]) => prediction?.movement?.applied)
    .map(([name]) => name);
  const smoothing = markets
    .filter(([, prediction]) => prediction?.smoothing?.applied)
    .map(([name]) => name);
  const section = $("#advanced-corrections");
  const active = movement.length > 0 || smoothing.length > 0;
  section.hidden = !active;
  if (!active) {
    $(".advanced-corrections-details").open = false;
    return;
  }
  const labels = [
    movement.length ? `赔率走势：${movement.join("、")}` : null,
    smoothing.length ? `小样本稳定：${smoothing.join("、")}` : null,
  ].filter(Boolean);
  $("#advanced-corrections-label").textContent = labels.join(" · ");
}

function challengerOutcomeRows(prediction, labels, limit = labels.length) {
  const challenger = prediction?.challenger;
  if (!challenger?.available) return "";
  const baseline = prediction.baselineFinal || prediction.final;
  const indices = challenger.probabilities
    .map((value, index) => ({ value, index }))
    .sort((left, right) => right.value - left.value)
    .slice(0, limit)
    .map(({ index }) => index);
  return indices
    .map(
      (index) => `
        <div class="challenger-prob-row">
          <span>${escapeHtml(labels[index])}</span>
          <i style="--baseline:${baseline[index] * 100}%;--challenger:${challenger.probabilities[index] * 100}%"></i>
          <small>${pct(baseline[index])} → <b>${pct(challenger.probabilities[index])}</b></small>
        </div>`,
    )
    .join("");
}

function challengerCard(title, prediction, labels, limit = labels.length) {
  const challenger = prediction?.challenger;
  if (!challenger?.available) {
    return `
      <article class="challenger-card unavailable">
        <header><span>${escapeHtml(title)}</span><strong>模型不可用</strong></header>
        <p>挑战模型尚未训练或历史数据更新后验证已经失效。</p>
      </article>`;
  }
  const test = challenger.test;
  const gatePassed = Boolean(challenger.gate?.passed);
  const accuracyDelta = test?.delta?.accuracy || 0;
  const status = gatePassed ? "通过门禁 · 已接管" : "未过门禁 · 仅对照";
  const statusClass = gatePassed ? "passed" : "rejected";
  return `
    <article class="challenger-card ${statusClass}">
      <header>
        <span>${escapeHtml(title)}</span>
        <strong>${escapeHtml(status)}</strong>
      </header>
      <div class="challenger-live-label">
        <b>当前比赛</b>
        <span>历史模型 → 历史增强随机森林</span>
      </div>
      <div class="challenger-probabilities">
        ${challengerOutcomeRows(prediction, labels, limit)}
      </div>
      <div class="challenger-scoreline">
        <span>
          <small>测试命中率</small>
          <b>${pct(test.baseline.accuracy, 2)} → ${pct(test.challenger.accuracy, 2)}</b>
        </span>
        <em class="${accuracyDelta >= 0 ? "positive" : "negative"}">${signedPp(accuracyDelta, 2)}</em>
      </div>
      <p>Log Loss ${test.baseline.logLoss.toFixed(3)} → ${test.challenger.logLoss.toFixed(3)} · Brier ${test.baseline.brier.toFixed(3)} → ${test.challenger.brier.toFixed(3)}</p>
      <small>${escapeHtml(challenger.gate.reason)}</small>
    </article>`;
}

function renderChallengerInsights(spf, hhad, goals) {
  const predictions = [spf, hhad, goals];
  const passed = predictions.filter(
    (prediction) => prediction?.challenger?.enabled,
  ).length;
  $("#challenger-policy").textContent = passed
    ? `${passed} 个玩法通过门禁并进入正式预测`
    : "0 / 3 通过 · 正式预测继续使用历史相似模型";
  $("#challenger-insights").innerHTML = [
    challengerCard("胜平负", spf, ["主胜", "平局", "客胜"]),
    challengerCard("让球胜平负", hhad, ["让胜", "让平", "让负"]),
    challengerCard(
      "总进球",
      goals,
      goals.labels.map((label) => `${label}球`),
      3,
    ),
  ].join("");
}

function movementInsightCard(title, prediction, labels) {
  const movement = prediction?.movement;
  if (!movement) {
    return `
      <article class="movement-insight fallback">
        <header><span>${escapeHtml(title)}</span><strong>未接入</strong></header>
        <p>当前玩法没有可用赔率数据。</p>
      </article>`;
  }
  const delta = movement.delta || [];
  const adjustment = movement.adjustment || [];
  const strongest = (values) =>
    values.length
      ? values
          .map((value, index) => ({ value, index }))
          .sort((left, right) => Math.abs(right.value) - Math.abs(left.value))[0]
      : { value: 0, index: 0 };
  const direction = strongest(delta);
  const correction = strongest(adjustment);
  const validated = Boolean(movement.validation?.validated);
  const status =
    movement.reason === "reference-only"
      ? movement.validation?.significanceStatus === "uncertain"
        ? "改善不显著"
        : validated
        ? "当前未启用"
        : "验证未通过"
      : movement.reason === "applied"
        ? "验证通过"
      : movement.reason === "insufficient-samples"
        ? "样本不足"
        : movement.reason === "missing-initial"
          ? "缺少初赔"
          : "自动回退";
  const detail =
    movement.reason === "reference-only"
      ? `${movement.sampleSize.toLocaleString()} 场相似走势 · 仅展示历史走势占比`
      : movement.reason === "applied"
        ? `${movement.sampleSize.toLocaleString()} 场相似走势 · 修正权重 ${pct(movement.weight)}`
      : movement.reason === "insufficient-samples"
        ? `仅 ${movement.sampleSize.toLocaleString()} 场相似走势，低于 ${movement.minSamples} 场门槛`
        : movement.reason === "missing-initial"
          ? `没有完整初始赔率，继续使用${weightingLabel(prediction)}预测`
          : `初赔与最新赔率没有有效变化，继续使用${weightingLabel(prediction)}预测`;
  const trendDistribution =
    movement.sampleSize > 0 && Array.isArray(movement.empirical)
    ? movement.empirical
        .map(
          (value, index) => `
            <span>
              <i>${escapeHtml(labels[index])}</i>
              <b>${pct(value)}</b>
            </span>`,
        )
        .join("")
    : "";
  return `
    <article class="movement-insight ${movement.applied ? "active" : "fallback"}">
      <header>
        <span>${escapeHtml(title)}</span>
        <strong>${escapeHtml(status)}</strong>
      </header>
      <div class="movement-signal">
        ${escapeHtml(delta.length ? `${labels[direction.index]}隐含概率 ${signedPp(direction.value)}` : "没有可计算的概率变化")}
      </div>
      <p>${escapeHtml(detail)}</p>
      ${trendDistribution ? `<div class="movement-distribution" aria-label="${escapeHtml(title)}走势样本占比">${trendDistribution}</div>` : ""}
      <small>${escapeHtml(movement.referenceOnly ? "最终概率不受初赔走势影响" : movement.applied ? `最终${labels[correction.index]} ${signedPp(correction.value)}` : "最终概率未做走势修正")}</small>
    </article>`;
}

function renderMovementInsights(spf, hhad, goals) {
  const enabled = [spf, hhad, goals].filter(
    (prediction) => prediction?.movement?.validation?.enabled,
  );
  $("#movement-policy").textContent = enabled.length
    ? `${enabled.length} 个玩法通过验证 · 按验证比例修正`
    : "三个玩法均未通过验证 · 仅展示走势占比";
  $("#movement-insights").innerHTML = [
    movementInsightCard("胜平负", spf, ["主胜", "平局", "客胜"]),
    movementInsightCard("让球胜平负", hhad, ["让胜", "让平", "让负"]),
    movementInsightCard(
      "总进球",
      goals,
      goals.labels.map((label) => `${label}球`),
    ),
  ].join("");
}

function renderOutcomeChart(prediction, {
  donutSelector,
  totalSelector,
  legendSelector,
  labels,
}) {
  const stats = prediction.stats;
  const win = stats.probabilities["胜"] || 0;
  const draw = stats.probabilities["平"] || 0;
  const winEnd = win * 100;
  const drawEnd = (win + draw) * 100;
  $(donutSelector).style.background =
    `conic-gradient(var(--win) 0 ${winEnd}%, var(--draw) ${winEnd}% ${drawEnd}%, var(--loss) ${drawEnd}% 100%)`;
  $(totalSelector).textContent = stats.total.toLocaleString();
  const config = [
    ["胜", labels[0], "--win"],
    ["平", labels[1], "--draw"],
    ["负", labels[2], "--loss"],
  ];
  const stable = stableProbabilities(prediction);
  $(legendSelector).innerHTML = config
    .map(
      ([key, label, color], index) => `
      <div class="outcome-item">
        <i style="background:var(${color})"></i>
        <span>${label} · ${stats.counts[key].toLocaleString()} 场 · 原始 ${pct(stats.probabilities[key])}</span>
        <strong>稳定 ${pct(stable[index])}</strong>
      </div>`,
    )
    .join("");
}

function renderOutcomeDonut(spf, hhad) {
  $("#spf-outcome-market").hidden = !spf;
  if (spf) {
    renderOutcomeChart(spf, {
      donutSelector: "#outcome-donut",
      totalSelector: "#donut-total",
      legendSelector: "#outcome-legend",
      labels: ["主胜", "平局", "客胜"],
    });
  }
  $("#hhad-outcome-market").hidden = !hhad;
  if (!hhad) return;
  renderOutcomeChart(hhad, {
    donutSelector: "#hhad-outcome-donut",
    totalSelector: "#hhad-donut-total",
    legendSelector: "#hhad-outcome-legend",
    labels: ["让胜", "让平", "让负"],
  });
}

function renderGoalChart(goals) {
  const stable = stableProbabilities(goals);
  const max = Math.max(...stable, 0.01);
  $("#goal-chart").innerHTML = goals.labels
    .map((label, index) => {
      const value = stable[index];
      const top = label === goals.predicted ? "model-top" : "";
      return `
        <div class="goal-column ${top}">
          <div class="goal-bar-wrap">
            <span class="goal-value">${pct(value)}</span>
            <small class="goal-raw">原始 ${pct(goals.empirical[index])}</small>
            <div class="goal-bar" style="height:${Math.max(2, (value / max) * 88)}%"></div>
          </div>
          <span class="goal-label">${label}</span>
        </div>`;
    })
    .join("");
}

function movementTimeLabel(value, index) {
  const raw = String(value || "").trim();
  const dateTime = raw.match(/\d{4}-(\d{2})-(\d{2})[ T](\d{1,2}:\d{2})/);
  if (dateTime) return `${dateTime[1]}-${dateTime[2]} ${dateTime[3]}`;
  const time = raw.match(/(\d{1,2}:\d{2})(?::\d{2})?$/)?.[1];
  return time || `记录${index + 1}`;
}

function movementMarketConfig(market) {
  if (market === "hhad") {
    return {
      title: "让球胜平负赔率轨迹",
      labels: ["让胜", "让平", "让负"],
      keys: ["h", "d", "a"],
    };
  }
  if (market === "goals") {
    return {
      title: "总进球八档赔率记录",
      labels: ["0球", "1球", "2球", "3球", "4球", "5球", "6球", "7+球"],
      keys: ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7plus"],
    };
  }
  return {
    title: "胜平负赔率轨迹",
    labels: ["主胜", "平局", "客胜"],
    keys: ["h", "d", "a"],
  };
}

function renderGoalOddsMovement(points, config) {
  const times = points.map((point, index) =>
    movementTimeLabel(point.time, index),
  );
  const head = times.map((time) => `<th>${escapeHtml(time)}</th>`).join("");
  const relationsByPoint = points.map((point) =>
    exactGoalMultipleRelations(
      config.keys.map((key) => Number(point[key])),
      config.labels,
    ),
  );
  const rows = config.keys
    .map((key, rowIndex) => {
      const cells = points
        .map((point, pointIndex) => {
          const value = Number(point[key]);
          const previous = pointIndex ? Number(points[pointIndex - 1][key]) : value;
          const delta = value - previous;
          const direction = delta < -1e-9 ? "down" : delta > 1e-9 ? "up" : "flat";
          const deltaText = pointIndex
            ? `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`
            : "初始";
          const movementText = pointIndex
            ? `${direction === "up" ? "↑" : direction === "down" ? "↓" : "—"} ${deltaText}`
            : deltaText;
          const relations = relationsByPoint[pointIndex];
          const relation = relations.find((item) => item.index === rowIndex);
          const isMultiple = Boolean(relation || (rowIndex === 0 && relations.length));
          const multipleLabel = relation
            ? `<em class="movement-multiple-badge">×${relation.multiple}</em>`
            : "";
          const relationTitle = isMultiple
            ? ` title="${escapeHtml(
                relations
                  .map(
                    (item) =>
                      `0球赔率 = ${item.label}赔率 ×${item.multiple}`,
                  )
                  .join("；"),
              )}"`
            : "";
          return `<td class="${direction}${pointIndex === points.length - 1 ? " latest" : ""}${isMultiple ? " multiple" : ""}"${relationTitle}><strong>${value.toFixed(2)}${multipleLabel}</strong><small>${movementText}</small></td>`;
        })
        .join("");
      return `<tr><th>${escapeHtml(config.labels[rowIndex])}</th>${cells}</tr>`;
    })
    .join("");
  $("#movement-chart").innerHTML = `
    <div class="movement-goal-shell">
      <table class="movement-goal-table">
        <thead><tr><th>进球数</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  $("#movement-legend").innerHTML = `
    <span><i class="movement-multiple-key">×N</i>红色赔率：与同列0球赔率构成整数倍</span>
    <span><i class="movement-change-key up">↑</i>红色：赔率上升</span>
    <span><i class="movement-change-key down">↓</i>蓝色：赔率下降</span>
    <span><i class="movement-change-key flat">—</i>灰色：赔率不变</span>
    <span>每格为该时点的竞彩赔率，最右侧为最新</span>`;
}

function renderMovementChart(timeline, market = "spf") {
  const points = timeline?.length ? timeline : [];
  const config = movementMarketConfig(market);
  $("#movement-title").textContent = config.title;
  $("#movement-count").textContent = `${points.length} 次记录`;
  if (!points.length) {
    $("#movement-chart").innerHTML = '<div class="empty-state">暂无赔率变动记录</div>';
    $("#movement-legend").innerHTML = "";
    return;
  }
  if (market === "goals") {
    renderGoalOddsMovement(points, config);
    return;
  }
  const width = 760;
  const height = 250;
  const plot = { left: 48, right: 24, top: 36, bottom: 42 };
  const values = points
    .flatMap((point) => config.keys.map((key) => Number(point[key])))
    .filter(Number.isFinite);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const margin = Math.max(0.12, (rawMax - rawMin) * 0.12);
  const min = Math.max(1, rawMin - margin);
  const max = rawMax + margin;
  const span = max - min || 1;
  const x = (index) =>
    plot.left +
    (index / Math.max(1, points.length - 1)) *
      (width - plot.left - plot.right);
  const y = (value) =>
    height -
    plot.bottom -
    ((Number(value) - min) / span) *
      (height - plot.top - plot.bottom);
  const pathFor = (key) =>
    points.map((point, index) => `${index ? "L" : "M"} ${x(index)} ${y(point[key])}`).join(" ");
  const colors = { h: "var(--win)", d: "var(--draw)", a: "var(--loss)" };
  const lines = config.keys
    .map(
      (key) => `
        <path d="${pathFor(key)}" fill="none" stroke="${colors[key]}" stroke-width="3" vector-effect="non-scaling-stroke"/>
        ${points
          .map(
            (point, index) => `
              <circle cx="${x(index)}" cy="${y(point[key])}" r="4.5" fill="${colors[key]}" stroke="var(--paper-bright)" stroke-width="2"/>
              <text class="movement-point-value" x="${x(index)}" y="${y(point[key]) - 11}" text-anchor="middle" fill="${colors[key]}">${Number(point[key]).toFixed(2)}</text>`,
          )
          .join("")}`,
    )
    .join("");
  const grid = [0, 1, 2, 3, 4]
    .map((index) => {
      const ratio = index / 4;
      const yy = plot.top + ratio * (height - plot.top - plot.bottom);
      const value = max - ratio * span;
      return `<line x1="${plot.left}" x2="${width - plot.right}" y1="${yy}" y2="${yy}" stroke="rgba(16,33,38,.1)" stroke-dasharray="4 5"/><text class="movement-axis-value" x="${plot.left - 9}" y="${yy + 3}" text-anchor="end">${value.toFixed(2)}</text>`;
    })
    .join("");
  const timeLabels = points
    .map(
      (point, index) =>
        `<text class="movement-axis-time" x="${x(index)}" y="${height - 13}" text-anchor="middle">${escapeHtml(movementTimeLabel(point.time, index))}</text>`,
    )
    .join("");
  $("#movement-chart").innerHTML =
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(config.title)}，每个点标有对应赔率">${grid}${lines}${timeLabels}</svg>`;
  $("#movement-legend").innerHTML = config.keys
    .map((key, index) => {
      const first = Number(points[0][key]);
      const latest = Number(points.at(-1)[key]);
      return `<span><i style="background:${colors[key]}"></i><b>${escapeHtml(config.labels[index])}</b>${first.toFixed(2)} → <strong>${latest.toFixed(2)}</strong></span>`;
    })
    .join("");
}

function renderMovementPanel() {
  const match = state.data?.match;
  if (!match) return;
  const timelines = {
    spf: match.hadTimeline || [],
    hhad: match.hhadTimeline || [],
    goals: match.goalTimeline || [],
  };
  $$("[data-movement-market]").forEach((button) => {
    const market = button.dataset.movementMarket;
    const enabled = timelines[market].length > 0;
    const active = market === state.movementMarket;
    button.disabled = !enabled;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    if (market === "hhad" && match.hhad?.goalLine !== undefined) {
      const handicap = Number(match.hhad.goalLine);
      button.textContent = `让球 ${handicap > 0 ? "+" : ""}${handicap}`;
    }
  });
  renderMovementChart(timelines[state.movementMarket], state.movementMarket);
}

function syncHistoryTabs(available) {
  if (!available[state.activeTab]) {
    state.activeTab = ["spf", "hhad", "goals"].find(
      (market) => available[market],
    ) || "spf";
  }
  $$(".tab").forEach((tab) => {
    const enabled = Boolean(available[tab.dataset.tab]);
    tab.disabled = !enabled;
    tab.classList.toggle("active", tab.dataset.tab === state.activeTab);
    tab.title = enabled ? "" : "本场未开售该玩法";
  });
}

function renderHistoryTable() {
  const isSpf = state.activeTab === "spf";
  const isHhad = state.activeTab === "hhad";
  const page = isSpf
    ? state.data.similarSpf
    : isHhad
      ? state.data.similarHhad
      : state.data.similarGoals;
  $("#history-head").innerHTML = isSpf
    ? `<tr><th>联赛</th><th>历史比赛</th><th>比分</th><th>赛果</th><th>胜 / 平 / 负赔率</th><th>相似度</th><th>单场权重</th><th>概率贡献</th></tr>`
    : isHhad
      ? `<tr><th>联赛</th><th>历史比赛</th><th>让球</th><th>比分</th><th>让球赛果</th><th>让胜 / 让平 / 让负赔率</th><th>相似度</th><th>单场权重</th><th>概率贡献</th></tr>`
    : `<tr><th>联赛</th><th>历史比赛</th><th>总进球</th><th>0–7+ 赔率</th><th>相似度</th><th>单场权重</th><th>概率贡献</th></tr>`;
  $("#history-body").innerHTML = page.rows
    .map((row) =>
      isSpf ? renderSpfRow(row) : isHhad ? renderHhadRow(row) : renderGoalRow(row),
    )
    .join("");
  $("#empty-state").hidden = page.rows.length > 0;
  $("#page-summary").textContent =
    `共 ${page.total.toLocaleString()} 场 · 第 ${page.page} / ${page.totalPages} 页`;
  $("#prev-page").disabled = page.page <= 1;
  $("#next-page").disabled = page.page >= page.totalPages;
}

function renderHhadRow(row) {
  const line = `${row.handicap > 0 ? "+" : ""}${row.handicap}`;
  return `
    <tr>
      <td>${escapeHtml(row.league)}</td>
      <td>${escapeHtml(row.home)} <span class="versus-mini">vs</span> ${escapeHtml(row.away)}</td>
      <td class="numeric"><strong>${escapeHtml(line)}</strong></td>
      <td class="numeric">${escapeHtml(row.score || "—")}</td>
      <td><span class="result-pill ${resultClass(row.result)}">${escapeHtml(row.result)}</span></td>
      <td class="numeric">${escapeHtml(oddsText(row.odds))}</td>
      <td>${similarityCell(row.similarity)}</td>
      <td class="numeric weight-value">${Number(row.weight).toFixed(3)}</td>
      <td class="numeric contribution-value">${pct(row.contribution, 2)}</td>
    </tr>`;
}

function resultClass(result) {
  return result === "胜" ? "win" : result === "平" ? "draw" : "loss";
}

function similarityCell(value) {
  const percentage = Math.max(0, Math.min(100, value * 100));
  return `
    <span class="similarity-meter">
      <i style="--similarity:${percentage}%"></i>
      <span>${percentage.toFixed(1)}%</span>
    </span>`;
}

function renderSpfRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.league)}</td>
      <td>${escapeHtml(row.home)} <span class="versus-mini">vs</span> ${escapeHtml(row.away)}</td>
      <td class="numeric">${escapeHtml(row.score || "—")}</td>
      <td><span class="result-pill ${resultClass(row.result)}">${escapeHtml(row.result)}</span></td>
      <td class="numeric">${escapeHtml(oddsText(row.odds))}</td>
      <td>${similarityCell(row.similarity)}</td>
      <td class="numeric weight-value">${Number(row.weight).toFixed(3)}</td>
      <td class="numeric contribution-value">${pct(row.contribution, 2)}</td>
    </tr>`;
}

function renderGoalRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.league)}</td>
      <td>${escapeHtml(row.home)} <span class="versus-mini">vs</span> ${escapeHtml(row.away)}</td>
      <td class="numeric"><strong>${escapeHtml(row.goals)}</strong></td>
      <td class="numeric">${escapeHtml(row.odds.map((value) => Number(value).toFixed(2)).join(" · "))}</td>
      <td>${similarityCell(row.similarity)}</td>
      <td class="numeric weight-value">${Number(row.weight).toFixed(3)}</td>
      <td class="numeric contribution-value">${pct(row.contribution, 2)}</td>
    </tr>`;
}

function setLoading(loading) {
  $("#loading").hidden = !loading;
  if (loading) {
    $("#dashboard").hidden = true;
    $("#error-box").hidden = true;
  } else {
    $("#dashboard").hidden = false;
    $("#error-box").hidden = true;
  }
}

function showError(error) {
  $("#loading").hidden = true;
  $("#dashboard").hidden = true;
  $("#error-box").hidden = false;
  $("#error-message").textContent = error.message;
}

function parlaySettings() {
  const goalPairMode = state.parlayMode === "goalsPair";
  const minLegOdds = Math.max(
    MIN_PARLAY_LEG_ODDS,
    Number($("#parlay-min-leg-odds").value) || MIN_PARLAY_LEG_ODDS,
  );
  return {
    mode: state.parlayMode,
    legs: goalPairMode
      ? 2
      : Number($('input[name="parlay-legs"]:checked').value),
    ...(goalPairMode
      ? {}
      : {
          targetOdds: Number($("#parlay-target-odds").value) || 1.8,
          minLegOdds,
        }),
    sort: $("#parlay-sort").value,
    sameLeague: $("#same-league").checked,
  };
}

function eligibleStandardMarkets(candidate, minLegOdds = parlaySettings().minLegOdds) {
  return [candidate.markets.had, candidate.markets.hhad].filter(
    (market) => market && Number(market.odds) >= minLegOdds,
  );
}

function renderParlayCount() {
  const count = state.parlaySelected.size;
  $("#parlay-selected-count").textContent = count;
  $("#generate-parlay-hint").textContent = `已选 ${count} 场`;
}

function defaultParlaySelection(candidates, mode = state.parlayMode) {
  const selected = new Set();
  const markets = new Map();
  if (mode === "goalsPair") {
    for (const candidate of candidates) {
      markets.set(candidate.id, "goalsPair");
    }
    candidates
      .map((candidate) => candidate.markets.goalsPair)
      .filter(Boolean)
      .sort(
        (left, right) =>
          right.probability - left.probability ||
          right.samples - left.samples,
      )
      .slice(0, 2)
      .forEach((candidate) => selected.add(candidate.id));
    return { selected, markets };
  }
  const minLegOdds = parlaySettings().minLegOdds;
  for (const candidate of candidates) {
    const eligibleMarkets = eligibleStandardMarkets(candidate, minLegOdds);
    const hadRecommended =
      eligibleMarkets.includes(candidate.markets.had) &&
      candidate.markets.had?.reliability?.level === "recommended";
    const hhadRecommended =
      eligibleMarkets.includes(candidate.markets.hhad) &&
      candidate.markets.hhad?.reliability?.level === "recommended";
    const fallback = eligibleMarkets[0];
    const market = hadRecommended
      ? "had"
      : hhadRecommended
        ? "hhad"
        : fallback?.market;
    if (!market) continue;
    markets.set(candidate.id, market);
    if (hadRecommended || hhadRecommended) selected.add(candidate.id);
  }
  if (selected.size >= 2) return { selected, markets };
  return {
    selected: new Set(
      candidates
        .filter((candidate) => eligibleStandardMarkets(candidate, minLegOdds).length)
        .map((candidate) => candidate.id),
    ),
    markets,
  };
}

function renderCandidates() {
  $("#candidate-list").innerHTML = state.parlayCandidates
    .map((candidate, index) => {
      const goalPairMode = state.parlayMode === "goalsPair";
      const minLegOdds = parlaySettings().minLegOdds;
      const eligibleMarkets = goalPairMode
        ? []
        : eligibleStandardMarkets(candidate, minLegOdds);
      const requestedMarket = state.parlayMarkets.get(candidate.id);
      const selectedMarket = goalPairMode
        ? "goalsPair"
        : eligibleMarkets.some((market) => market.market === requestedMarket)
          ? requestedMarket
          : eligibleMarkets[0]?.market ||
            candidate.markets.had?.market ||
            candidate.markets.hhad?.market;
      const pick =
        candidate.markets[selectedMarket] ||
        candidate.markets.had ||
        candidate.markets.hhad;
      const selectable = goalPairMode
        ? Boolean(pick?.eligible)
        : eligibleMarkets.length > 0;
      const checked =
        selectable && state.parlaySelected.has(candidate.id);
      const hhadEligible = eligibleMarkets.includes(candidate.markets.hhad);
      const hadEligible = eligibleMarkets.includes(candidate.markets.had);
      const hhadOption = candidate.markets.hhad
        ? `<option value="hhad" ${selectedMarket === "hhad" ? "selected" : ""} ${hhadEligible ? "" : "disabled"}>让球 ${candidate.markets.hhad.handicap > 0 ? "+" : ""}${candidate.markets.hhad.handicap} · ${Number(candidate.markets.hhad.odds).toFixed(2)}${hhadEligible ? "" : "（低于门槛）"}</option>`
        : "";
      const hadOption = candidate.markets.had
        ? `<option value="had" ${selectedMarket === "had" ? "selected" : ""} ${hadEligible ? "" : "disabled"}>胜平负 · ${Number(candidate.markets.had.odds).toFixed(2)}${hadEligible ? "" : "（低于门槛）"}</option>`
        : "";
      const movementText = goalPairMode
        ? pick?.eligibilityReason || "缺少进球双选预测"
        : pick?.movement?.applied
          ? `走势 ${pick.movement.sampleSize.toLocaleString()} 场 · 权重 ${pct(pick.movement.weight)}`
          : "走势回退基础模型";
      const sampleDetail = !goalPairMode && !selectable
        ? `所有可用玩法赔率均低于 ${minLegOdds.toFixed(2)}，不参与串关`
        : `${pick.sampleScope || "全部联赛"}相似 ${pick.samples.toLocaleString()} 场 · 置信度 ${escapeHtml(pick.confidence)} · ${escapeHtml(movementText)}`;
      const reliability = pick?.reliability || {
        level: "cautious",
        label: "谨慎参考",
      };
      const marketControl = goalPairMode
        ? '<span class="candidate-market-fixed">总进球双选</span>'
        : `
            <select class="candidate-market-select" data-id="${escapeHtml(candidate.id)}" aria-label="${escapeHtml(candidate.home)}玩法" ${selectable ? "" : "disabled"}>
              ${hadOption}
              ${hhadOption}
            </select>`;
      const oddsText = goalPairMode
        ? (pick?.odds || [])
            .map((value) => Number(value).toFixed(2))
            .join(" / ")
        : Number(pick.odds).toFixed(2);
      return `
        <label class="candidate-card ${checked ? "selected" : ""} ${selectable ? "" : "unavailable"} ${goalPairMode ? "goal-pair" : ""}" style="--order:${index}">
          <input
            class="candidate-checkbox"
            type="checkbox"
            value="${escapeHtml(candidate.id)}"
            ${checked ? "checked" : ""}
            ${selectable ? "" : "disabled"}
          />
          <span class="candidate-check" aria-hidden="true"></span>
          <span class="candidate-index">${String(index + 1).padStart(2, "0")}</span>
          <span class="candidate-match">
            <span>
              <i>${escapeHtml(candidate.league)}</i>
              <small>${escapeHtml(candidate.id)}</small>
            </span>
            <strong>${escapeHtml(candidate.home)} <em>vs</em> ${escapeHtml(candidate.away)}</strong>
            <small><b class="candidate-reliability ${escapeHtml(reliability.level)}">${escapeHtml(reliability.label)}</b>${sampleDetail}</small>
          </span>
          <span class="candidate-pick">
            ${marketControl}
            <strong class="${goalPairMode ? "goal-pair-result" : resultClass(pick.predicted)}">${escapeHtml(pick.predicted)}</strong>
          </span>
          <span class="candidate-metric">
            <small>${goalPairMode ? "双选覆盖" : "概率"}</small>
            <strong>${pct(pick.probability)}</strong>
          </span>
          <span class="candidate-metric">
            <small>${goalPairMode ? "两档赔率" : "赔率"}</small>
            <strong>${escapeHtml(oddsText)}</strong>
          </span>
          <span class="candidate-metric candidate-value">
            <small>${goalPairMode ? "双注指数" : "单场指数"}</small>
            <strong>${Number(pick.valueIndex).toFixed(2)}</strong>
          </span>
        </label>`;
    })
    .join("");

  $$(".candidate-checkbox").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.parlaySelected.add(checkbox.value);
      else state.parlaySelected.delete(checkbox.value);
      checkbox.closest(".candidate-card").classList.toggle("selected", checkbox.checked);
      renderParlayCount();
    });
  });
  $$(".candidate-market-select").forEach((select) => {
    select.addEventListener("click", (event) => event.stopPropagation());
    select.addEventListener("change", (event) => {
      event.stopPropagation();
      state.parlayMarkets.set(select.dataset.id, select.value);
      renderCandidates();
    });
  });
  renderParlayCount();
}

function showParlayEmpty(title, detail) {
  $("#combination-list").innerHTML = `
    <div class="parlay-empty">
      <span>1 × 2</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(detail)}</p>
    </div>`;
}

function goalPairGateReason() {
  return (
    state.goalPairPolicy?.gate?.reason ||
    "滚动验证状态仅作风险提示，不影响候选生成"
  );
}

function applyParlayMode(mode) {
  state.parlayMode = mode === "goalsPair" ? "goalsPair" : "standard";
  const goalPairMode = state.parlayMode === "goalsPair";
  const legInputs = $$('input[name="parlay-legs"]');
  if (goalPairMode) {
    $('input[name="parlay-legs"][value="2"]').checked = true;
    $("#parlay-sort").value = "probability";
  }
  $("#parlay-target-field").hidden = goalPairMode;
  $("#parlay-min-leg-field").hidden = goalPairMode;
  $("#parlay-target-sort-option").disabled = goalPairMode;
  legInputs.forEach((input) => {
    input.disabled = goalPairMode && input.value !== "2";
  });
  $("#parlay-value-formula").textContent = goalPairMode
    ? "四注预期返还 ÷ 4"
    : "赔率 × 命中率";
  $("#parlay-value-note").textContent = goalPairMode
    ? "每场取相似历史占比最高的两个进球数；页面不逐注展开，后台按4注核算。"
    : "高于 1.00 代表模型概率下的理论正期望，不等于保证盈利。";
  $("#parlay-method-chip").textContent = goalPairMode
    ? state.parlayMethod?.tolerance || "进球 1.5pp / 历史前两名"
    : state.parlayMethod?.tolerance || "胜平负 / 让球";
  const scope = state.parlayMethod?.scope ||
    ($("#parlay-scope").value === "same" ? "只看同联赛" : "全部联赛");
  $("#parlay-rule-note").textContent = goalPairMode
    ? `${scope}；默认选择单场双选覆盖率最高的两场，不设最低组合赔率；${goalPairGateReason()}。`
    : `${scope}；每关赔率不低于 ${parlaySettings().minLegOdds.toFixed(2)}；${state.parlayMethod?.probability || "组合命中率按各场相乘"}。`;
  const defaults = defaultParlaySelection(
    state.parlayCandidates,
    state.parlayMode,
  );
  state.parlaySelected = defaults.selected;
  state.parlayMarkets = defaults.markets;
  renderCandidates();
  $("#combination-summary").textContent = goalPairMode
    ? "默认选择单场历史双选覆盖率最高的两场，样本数和稳定性仅作提示。"
    : "设置规则后生成串关组合。";
  showParlayEmpty(
    "组合结果会出现在这里",
    goalPairMode
      ? "已默认选择单场覆盖率最高的两场，点击“生成组合”即可。"
      : "先选择至少两场比赛，再点击“生成组合”。",
  );
}

async function loadParlayCandidates() {
  $("#candidate-loading").hidden = false;
  $("#parlay-error").hidden = true;
  try {
    const params = new URLSearchParams({
      mode: state.parlayMode,
      legs: 2,
      targetOdds: 1.8,
      limit: 20,
      spfTolerance: Number($("#spf-tolerance").value) / 100,
      hhadTolerance: Number($("#hhad-tolerance").value) / 100,
      goalTolerance: Number($("#goal-tolerance").value) / 1000,
      sameLeague: $("#parlay-scope").value === "same",
      minLegOdds: Math.max(
        MIN_PARLAY_LEG_ODDS,
        Number($("#parlay-min-leg-odds").value) || MIN_PARLAY_LEG_ODDS,
      ),
    });
    const payload = await fetchJson(`/api/parlay?${params}`);
    state.parlayCandidates = payload.candidates;
    state.goalPairPolicy = payload.goalPairPolicy;
    const defaults = defaultParlaySelection(payload.candidates);
    state.parlaySelected = defaults.selected;
    state.parlayMarkets = defaults.markets;
    state.parlayMethod = payload.method;
    state.parlayLoaded = true;
    $("#candidate-loading").hidden = true;
    $("#parlay-method-chip").textContent = payload.method.tolerance;
    $("#parlay-rule-note").textContent =
      `${payload.method.scope}；${payload.method.probability}。`;
    renderCandidates();
  } catch (error) {
    $("#candidate-loading").hidden = true;
    $("#parlay-error").hidden = false;
    $("#parlay-error-message").textContent = error.message;
  }
}

function sameSet(left, right) {
  return (
    left.size === right.size &&
    [...left].every((value) => right.has(value))
  );
}

function isDefaultParlayCombination(index) {
  if (index !== 0) return false;
  const settings = parlaySettings();
  const defaults = defaultParlaySelection(
    state.parlayCandidates,
    state.parlayMode,
  );
  if (!sameSet(state.parlaySelected, defaults.selected)) return false;
  for (const id of state.parlaySelected) {
    if (state.parlayMarkets.get(id) !== defaults.markets.get(id)) return false;
  }
  const thresholds = state.productionPolicy?.thresholds || {};
  const defaultTolerances =
    Math.abs(
      Number($("#spf-tolerance").value) / 100 - Number(thresholds.spf),
    ) < 1e-9 &&
    Math.abs(
      Number($("#hhad-tolerance").value) / 100 - Number(thresholds.hhad),
    ) < 1e-9 &&
    Math.abs(
      Number($("#goal-tolerance").value) / 1000 - Number(thresholds.goals),
    ) < 1e-9;
  if (!defaultTolerances) return false;
  if (settings.sameLeague) return false;
  return state.parlayMode === "goalsPair"
    ? settings.legs === 2 && settings.sort === "probability"
    : settings.legs === 2 &&
        settings.sort === "value" &&
        Math.abs(settings.minLegOdds - MIN_PARLAY_LEG_ODDS) < 1e-9 &&
        Math.abs(settings.targetOdds - 1.8) < 1e-9;
}

async function saveParlayCombination(button, query) {
  const params = new URLSearchParams(query);
  params.set("combinationId", button.dataset.combinationId);
  params.set("selectionSource", button.dataset.selectionSource);
  button.disabled = true;
  button.classList.add("busy");
  button.textContent = "正在记录…";
  try {
    const payload = await fetchJson(`/api/parlay/save?${params}`, {
      method: "POST",
    });
    button.classList.remove("busy");
    button.classList.add("saved");
    button.textContent = payload.duplicate ? "已存在账本" : "已记录待结算";
    state.ledgerLoaded = false;
  } catch (error) {
    button.disabled = false;
    button.classList.remove("busy");
    button.textContent = "记录失败，重试";
    button.title = error.message;
  }
}

function bindCombinationSaveButtons(query) {
  $$(".combination-save-button").forEach((button) => {
    button.addEventListener("click", () =>
      saveParlayCombination(button, query),
    );
  });
}

function renderCombinations(payload, saveQuery) {
  if (payload.mode === "goalsPair") {
    renderGoalPairCombinations(payload);
    bindCombinationSaveButtons(saveQuery);
    return;
  }
  const { rows, total, eligible, settings } = payload.combinations;
  $("#combination-summary").textContent =
    `每关赔率 ≥ ${settings.minLegOdds.toFixed(2)}；共计算 ${total.toLocaleString()} 种，${eligible.toLocaleString()} 种达到组合赔率 ${settings.targetOdds.toFixed(2)}，展示前 ${rows.length} 种。`;

  if (!rows.length) {
    showParlayEmpty(
      "没有达到当前规则的组合",
      "可降低最低组合赔率、减少串关数，或多选择几场比赛。",
    );
    return;
  }

  $("#combination-list").innerHTML = rows
    .map((combination, index) => {
      const positive = combination.valueIndex >= 1;
      return `
        <article class="combination-card" style="--order:${index}">
          <header>
            <span class="combination-rank">组合 ${String(index + 1).padStart(2, "0")}</span>
            <span class="combination-type">${settings.legs} 串 1</span>
          </header>
          <div class="combination-legs">
            ${combination.legs
              .map(
                (leg, legIndex) => `
                <div class="combination-leg">
                  <span class="leg-number">${legIndex + 1}</span>
                  <span class="leg-match">
                    <small>${escapeHtml(leg.league)}</small>
                    <strong>${escapeHtml(leg.home)} <em>vs</em> ${escapeHtml(leg.away)}</strong>
                    <span class="leg-market">${escapeHtml(leg.marketLabel)}</span>
                  </span>
                  <span class="leg-result ${resultClass(leg.predicted)}">${escapeHtml(leg.predicted)}</span>
                  <span class="leg-stat"><small>概率</small>${pct(leg.probability)}</span>
                  <span class="leg-stat"><small>赔率</small>${Number(leg.odds).toFixed(2)}</span>
                </div>`,
              )
              .join("")}
          </div>
          <footer>
            <div>
              <small>组合赔率</small>
              <strong>${Number(combination.combinedOdds).toFixed(2)}</strong>
            </div>
            <div>
              <small>估算命中率</small>
              <strong>${pct(combination.hitProbability, 2)}</strong>
            </div>
            <div class="return-index ${positive ? "positive" : ""}">
              <small>回报指数</small>
              <strong>${Number(combination.valueIndex).toFixed(3)}</strong>
              <span>${positive ? "理论正期望" : "低于平衡线"}</span>
            </div>
            <div class="combination-save-cell">
              <button
                class="combination-save-button"
                type="button"
                data-combination-id="${escapeHtml(combination.id)}"
                data-selection-source="${isDefaultParlayCombination(index) ? "system_default" : "user_saved"}"
              >记录此组合</button>
              <small>${isDefaultParlayCombination(index) ? "系统默认" : "自选规则"}</small>
            </div>
          </footer>
        </article>`;
    })
    .join("");
  bindCombinationSaveButtons(saveQuery);
}

function renderGoalPairCombinations(payload) {
  const { rows, total } = payload.combinations;
  $("#combination-summary").textContent =
    `共计算 ${total.toLocaleString()} 组双选2串1；不设最低组合赔率，每组后台按4注核算。`;
  if (!rows.length) {
    showParlayEmpty(
      "暂时无法生成总进球双选组合",
      "至少选择两场具有两个有效进球数选项的比赛。",
    );
    return;
  }
  $("#combination-list").innerHTML = rows
    .map((combination, index) => {
      const positive = combination.valueIndex >= 1;
      return `
        <article class="combination-card goal-pair-combination" style="--order:${index}">
          <header>
            <span class="combination-rank">双选组合 ${String(index + 1).padStart(2, "0")}</span>
            <span class="combination-type">2 串 1 · 双选</span>
          </header>
          <div class="combination-legs">
            ${combination.legs
              .map(
                (leg, legIndex) => `
                <div class="combination-leg goal-pair-leg">
                  <span class="leg-number">${legIndex + 1}</span>
                  <span class="leg-match">
                    <small>${escapeHtml(leg.league)}</small>
                    <strong>${escapeHtml(leg.home)} <em>vs</em> ${escapeHtml(leg.away)}</strong>
                    <span class="leg-market">总进球双选 · ${Number(leg.samples).toLocaleString()}场相似</span>
                  </span>
                  <span class="leg-result goal-pair-result">${escapeHtml(leg.predicted)}</span>
                  <span class="leg-stat"><small>覆盖率</small>${pct(leg.probability)}</span>
                  <span class="leg-stat"><small>两档赔率</small>${leg.odds.map((odd) => Number(odd).toFixed(2)).join(" / ")}</span>
                </div>`,
              )
              .join("")}
          </div>
          <footer>
            <div>
              <small>总成本</small>
              <strong>${combination.totalStake} 注</strong>
            </div>
            <div>
              <small>估算两场均覆盖 · 仅展示</small>
              <strong>${pct(combination.hitProbability, 2)}</strong>
            </div>
            <div class="return-index ${positive ? "positive" : ""}">
              <small>四注回报指数</small>
              <strong>${Number(combination.valueIndex).toFixed(3)}</strong>
              <span>${positive ? "理论正期望" : "低于平衡线"}</span>
            </div>
            <div class="combination-save-cell">
              <button
                class="combination-save-button"
                type="button"
                data-combination-id="${escapeHtml(combination.id)}"
                data-selection-source="${isDefaultParlayCombination(index) ? "system_default" : "user_saved"}"
              >记录此组合</button>
              <small>${isDefaultParlayCombination(index) ? "系统默认" : "自选规则"}</small>
            </div>
          </footer>
        </article>`;
    })
    .join("");
}

async function generateParlay() {
  const settings = parlaySettings();
  if (state.parlaySelected.size < settings.legs) {
    showParlayEmpty(
      settings.mode === "goalsPair"
        ? "至少需要两场进球双选候选"
        : `至少需要选择 ${settings.legs} 场比赛`,
      settings.mode === "goalsPair"
        ? `当前选择了 ${state.parlaySelected.size} 场，请再选择比赛。`
        : `当前只选择了 ${state.parlaySelected.size} 场，请补充候选或降低串关数。`,
    );
    return;
  }

  const params = new URLSearchParams({
    mode: settings.mode,
    legs: settings.legs,
    sort: settings.sort,
    limit: 20,
    spfTolerance: Number($("#spf-tolerance").value) / 100,
    hhadTolerance: Number($("#hhad-tolerance").value) / 100,
    goalTolerance: Number($("#goal-tolerance").value) / 1000,
    sameLeague: settings.sameLeague,
    selected: [...state.parlaySelected].join(","),
    markets: [...state.parlayMarkets]
      .map(([id, market]) => `${id}:${market}`)
      .join(","),
  });
  if (settings.mode !== "goalsPair") {
    params.set("targetOdds", settings.targetOdds);
    params.set("minLegOdds", settings.minLegOdds);
  }
  const button = $("#generate-parlay");
  button.disabled = true;
  button.classList.add("busy");
  try {
    const payload = await fetchJson(`/api/parlay?${params}`);
    renderCombinations(payload, params);
    $("#combination-list").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    showParlayEmpty("组合生成失败", error.message);
  } finally {
    button.disabled = false;
    button.classList.remove("busy");
  }
}

function resetParlay() {
  $('input[name="parlay-mode"][value="standard"]').checked = true;
  state.parlayMode = "standard";
  $('input[name="parlay-legs"][value="2"]').checked = true;
  $("#parlay-min-leg-odds").value = String(MIN_PARLAY_LEG_ODDS);
  $("#parlay-target-odds").value = "1.8";
  $("#parlay-sort").value = "value";
  applyParlayMode("standard");
}

let controlTimer;
function refreshFromControls() {
  updateToleranceLabels();
  state.spfPage = 1;
  state.hhadPage = 1;
  state.goalPage = 1;
  state.parlayLoaded = false;
  clearTimeout(controlTimer);
  controlTimer = setTimeout(() => {
    loadPrediction({ quiet: true });
    if (state.activeView === "parlay") loadParlayCandidates();
  }, 180);
}

$("#match-search").addEventListener("input", (event) => renderMatchList(event.target.value));
$("#spf-tolerance").addEventListener("input", refreshFromControls);
$("#hhad-tolerance").addEventListener("input", refreshFromControls);
$("#goal-tolerance").addEventListener("input", refreshFromControls);
$("#same-league").addEventListener("change", () => {
  $("#parlay-scope").value = $("#same-league").checked ? "same" : "all";
  refreshFromControls();
});
$("#parlay-scope").addEventListener("change", () => {
  $("#same-league").checked = $("#parlay-scope").value === "same";
  refreshFromControls();
});
$("#parlay-min-leg-odds").addEventListener("change", () => {
  const input = $("#parlay-min-leg-odds");
  input.value = Math.max(
    MIN_PARLAY_LEG_ODDS,
    Number(input.value) || MIN_PARLAY_LEG_ODDS,
  ).toFixed(2);
  state.parlayLoaded = false;
  loadParlayCandidates();
});
$("#retry-button").addEventListener("click", loadMatches);
$("#parlay-retry").addEventListener("click", loadParlayCandidates);
$("#ledger-refresh").addEventListener("click", () => loadLedger({ settle: true }));
$$('[data-ledger-tab]').forEach((button) => {
  button.addEventListener("click", () => setLedgerTab(button.dataset.ledgerTab));
});

let ledgerFilterTimer;
function reloadLedgerSection(section, { delayed = false } = {}) {
  if (section === "single") state.ledgerSinglePage = 1;
  else state.ledgerParlayPage = 1;
  clearTimeout(ledgerFilterTimer);
  const run = () => loadLedger({ settle: false });
  if (delayed) ledgerFilterTimer = setTimeout(run, 220);
  else run();
}

[
  "#ledger-single-status",
  "#ledger-single-market",
  "#ledger-single-scope",
  "#ledger-single-league",
  "#ledger-single-from",
  "#ledger-single-to",
].forEach((selector) => {
  $(selector).addEventListener("change", () => reloadLedgerSection("single"));
});
[
  "#ledger-parlay-status",
  "#ledger-parlay-mode",
  "#ledger-parlay-source",
  "#ledger-parlay-from",
  "#ledger-parlay-to",
].forEach((selector) => {
  $(selector).addEventListener("change", () => reloadLedgerSection("parlay"));
});
$("#ledger-single-query").addEventListener("input", () =>
  reloadLedgerSection("single", { delayed: true }),
);
$("#ledger-parlay-query").addEventListener("input", () =>
  reloadLedgerSection("parlay", { delayed: true }),
);
$("#ledger-single-reset").addEventListener("click", () => {
  $("#ledger-single-status").value = "pending";
  $("#ledger-single-market").value = "all";
  $("#ledger-single-scope").value = "global";
  $("#ledger-single-league").value = "all";
  $("#ledger-single-query").value = "";
  $("#ledger-single-from").value = "";
  $("#ledger-single-to").value = "";
  reloadLedgerSection("single");
});
$("#ledger-parlay-reset").addEventListener("click", () => {
  $("#ledger-parlay-status").value = "pending";
  $("#ledger-parlay-mode").value = "all";
  $("#ledger-parlay-source").value = "all";
  $("#ledger-parlay-query").value = "";
  $("#ledger-parlay-from").value = "";
  $("#ledger-parlay-to").value = "";
  reloadLedgerSection("parlay");
});
$("#ledger-single-prev").addEventListener("click", () => {
  state.ledgerSinglePage = Math.max(1, state.ledgerSinglePage - 1);
  loadLedger({ settle: false });
});
$("#ledger-single-next").addEventListener("click", () => {
  state.ledgerSinglePage += 1;
  loadLedger({ settle: false });
});
$("#ledger-parlay-prev").addEventListener("click", () => {
  state.ledgerParlayPage = Math.max(1, state.ledgerParlayPage - 1);
  loadLedger({ settle: false });
});
$("#ledger-parlay-next").addEventListener("click", () => {
  state.ledgerParlayPage += 1;
  loadLedger({ settle: false });
});
$("#generate-parlay").addEventListener("click", generateParlay);
$("#reset-parlay").addEventListener("click", resetParlay);
$("#select-all-matches").addEventListener("click", () => {
  state.parlaySelected = new Set(
    state.parlayCandidates
      .filter(
        (candidate) => state.parlayMode === "goalsPair"
          ? candidate.markets.goalsPair?.eligible
          : eligibleStandardMarkets(candidate).length > 0,
      )
      .map((candidate) => candidate.id),
  );
  renderCandidates();
});
$("#clear-all-matches").addEventListener("click", () => {
  state.parlaySelected.clear();
  renderCandidates();
});

$$('[data-movement-market]').forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    state.movementMarket = button.dataset.movementMarket;
    renderMovementPanel();
  });
});

$$('input[name="parlay-mode"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) {
      applyParlayMode(input.value);
      state.parlayLoaded = false;
      loadParlayCandidates();
    }
  });
});

$$(".mode-button").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.activeTab = tab.dataset.tab;
    $$(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    renderHistoryTable();
  });
});

$("#prev-page").addEventListener("click", () => {
  if (state.activeTab === "spf") state.spfPage -= 1;
  else if (state.activeTab === "hhad") state.hhadPage -= 1;
  else state.goalPage -= 1;
  loadPrediction({ quiet: true });
});

$("#next-page").addEventListener("click", () => {
  if (state.activeTab === "spf") state.spfPage += 1;
  else if (state.activeTab === "hhad") state.hhadPage += 1;
  else state.goalPage += 1;
  loadPrediction({ quiet: true });
});

loadMatches();
