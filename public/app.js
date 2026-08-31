import {
  exactGoalOddsEqualities,
  exactGoalMultipleRelations,
  goalOddsEqualitiesForMarket,
  goalMultipleRelationsForMarket,
} from "./goal-multiples.js";
import {
  capitalLedgerMetrics,
  calculateDoubleChance,
  crossValidateScoreAndGoals,
  formatOddsWithMovement,
  matchHasOddsMovement,
  settledLedgerCounts,
  timelineHasOddsMovement,
} from "./ledger-metrics.js";

const state = {
  matches: [],
  selectedId: null,
  matchReliability: new Map(),
  matchReliabilityLoaded: false,
  matchReliabilityLoading: false,
  matchReliabilityError: null,
  matchReliabilityFilter: "all",
  matchReliabilityController: null,
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
  ledgerDrilldown: null,
  parlayLoaded: false,
  parlayCandidates: [],
  parlaySelected: new Set(),
  parlayMarkets: new Map(),
  parlayMode: "standard",
  parlayMethod: null,
  movementMarket: "spf",
  goalPairPolicy: null,
  previousSpfMatch: null,
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
const MARKET_BASELINE_SINGLE_LEG_RTP = 0.886;
const GOAL_DISPLAY_LABELS = [
  "0球",
  "1球",
  "2球",
  "3球",
  "4球",
  "5球",
  "6球",
  "7+球",
];
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

function marketComparisonLabel(labels, market) {
  const safeLabels = Array.isArray(labels) ? labels : [];
  return safeLabels
    .map((label) => {
      if (market === "goals") return `${label}球`;
      if (market === "hhad") return `让${label}`;
      return label;
    })
    .join(" / ");
}

function marketComparisonMarkup(prediction, market, { detailed = false } = {}) {
  const comparison = prediction?.marketComparison;
  if (!comparison?.available || !comparison.selected) {
    return '<p class="market-comparison-empty">缺少完整市场基准，暂时无法比较。</p>';
  }
  const selected = comparison.selected;
  const statusClass = comparison.status === "historical-divergence"
    ? "divergent"
    : "aligned";
  const historicalLabel = marketComparisonLabel(
    comparison.historicalTopLabels,
    market,
  );
  const marketLabel = marketComparisonLabel(comparison.marketTopLabels, market);
  const breakEven = selected.breakEvenProbability !== null &&
    selected.breakEvenProbability !== undefined &&
    Number.isFinite(Number(selected.breakEvenProbability))
    ? `<span><small>保本线差</small><strong>${signedPp(selected.breakEvenDelta)}</strong></span>`
    : "";
  const details = detailed
    ? `<p>${escapeHtml(comparison.reason)}；正差值仍需由账本滚动验证，当前不构成优势信号。</p>`
    : `<p>${escapeHtml(comparison.reason)}</p>`;
  return `
    <div class="market-comparison-head">
      <strong class="market-comparison-status ${statusClass}">${escapeHtml(comparison.label)}</strong>
      <span>市场 ${escapeHtml(marketLabel)} · 历史 ${escapeHtml(historicalLabel)}</span>
    </div>
    <div class="market-comparison-metrics">
      <span><small>历史概率</small><strong>${pct(selected.historicalProbability)}</strong></span>
      <span><small>去水市场</small><strong>${pct(selected.marketProbability)}</strong></span>
      <span><small>历史－市场</small><strong>${signedPp(selected.probabilityDelta)}</strong></span>
      ${breakEven}
    </div>
    ${details}`;
}

function renderMarketComparisons(spf, hhad, goals) {
  [
    ["#spf-market-comparison", spf, "spf"],
    ["#hhad-market-comparison", hhad, "hhad"],
    ["#goal-market-comparison", goals, "goals"],
  ].forEach(([selector, prediction, market]) => {
    const element = $(selector);
    if (!element) return;
    element.innerHTML = marketComparisonMarkup(prediction, market);
    element.classList.toggle(
      "divergent",
      prediction?.marketComparison?.status === "historical-divergence",
    );
  });
}

function showToast(message, options = {}) {
  const container = $("#toast-container");
  if (!container) return;
  const {
    type = "success",
    actionText = null,
    onAction = null,
    duration = 4200,
  } = options;

  const item = document.createElement("div");
  item.className = `toast-item ${escapeHtml(type)}`;

  const msgSpan = document.createElement("span");
  msgSpan.className = "toast-message";
  msgSpan.textContent = message;
  item.appendChild(msgSpan);

  if (actionText && typeof onAction === "function") {
    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "toast-action";
    actionBtn.textContent = actionText;
    actionBtn.addEventListener("click", () => {
      onAction();
      dismissToast(item);
    });
    item.appendChild(actionBtn);
  }

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "toast-close";
  closeBtn.setAttribute("aria-label", "关闭提示");
  closeBtn.innerHTML = "×";
  closeBtn.addEventListener("click", () => dismissToast(item));
  item.appendChild(closeBtn);

  container.appendChild(item);

  let timer = setTimeout(() => dismissToast(item), duration);
  item.addEventListener("mouseenter", () => clearTimeout(timer));
  item.addEventListener("mouseleave", () => {
    timer = setTimeout(() => dismissToast(item), 2000);
  });
}

function dismissToast(item) {
  if (!item || item.classList.contains("toast-out")) return;
  item.classList.add("toast-out");
  setTimeout(() => {
    item.remove();
  }, 220);
}

function initTheme() {
  const saved = localStorage.getItem("betwin_theme") || "light";
  const isDark = saved === "dark";
  document.body.classList.toggle("dark-mode", isDark);
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
  $("#theme-color")?.setAttribute("content", isDark ? "#0c1215" : "#102126");
  const btn = $("#theme-toggle-btn");
  if (btn) {
    btn.textContent = isDark ? "☀️ 浅色" : "🌙 深色";
    btn.setAttribute(
      "aria-label",
      isDark ? "切换为浅色日间模式" : "切换为夜间深色模式",
    );
  }
}

function toggleTheme() {
  const isDark = document.body.classList.toggle("dark-mode");
  const theme = isDark ? "dark" : "light";
  localStorage.setItem("betwin_theme", theme);
  document.documentElement.style.colorScheme = theme;
  $("#theme-color")?.setAttribute("content", isDark ? "#0c1215" : "#102126");
  const btn = $("#theme-toggle-btn");
  if (btn) {
    btn.textContent = isDark ? "☀️ 浅色" : "🌙 深色";
    btn.setAttribute(
      "aria-label",
      isDark ? "切换为浅色日间模式" : "切换为夜间深色模式",
    );
  }
}

function outcomeOdds(marketOdds, label) {
  if (!marketOdds) return null;
  const str = String(label || "").trim();
  if (str === "胜" || str === "主胜" || str === "让胜" || str === "H") {
    return Number(marketOdds.h);
  }
  if (str === "平" || str === "平局" || str === "让平" || str === "D") {
    return Number(marketOdds.d);
  }
  if (str === "负" || str === "客胜" || str === "让负" || str === "A") {
    return Number(marketOdds.a);
  }
  return null;
}

function outcomeFullName(label, isHhad = false) {
  const str = String(label || "").trim();
  if (str === "胜" || str === "主胜" || str === "让胜" || str === "H") {
    return isHhad ? "让胜" : "主胜";
  }
  if (str === "平" || str === "平局" || str === "让平" || str === "D") {
    return isHhad ? "让平" : "平局";
  }
  if (str === "负" || str === "客胜" || str === "让负" || str === "A") {
    return isHhad ? "让负" : "客胜";
  }
  return str || "—";
}

function buildMarketSignals(match, spfPrediction, hhadResult) {
  const signals = [];
  if (!match) return signals;

  const hadOdds = match.had
    ? [Number(match.had.h), Number(match.had.d), Number(match.had.a)]
    : null;
  const hadTl = match.hadTimeline || [];
  const sampleCount = Number(spfPrediction?.stats?.total || 0);

  if (
    hadOdds &&
    hadOdds.every(Number.isFinite) &&
    spfPrediction &&
    spfPrediction.available !== false &&
    sampleCount >= 25
  ) {
    const inv = hadOdds.map((o) => 1 / o);
    const sumInv = inv.reduce((a, b) => a + b, 0);
    const pMarket = inv.map((v) => v / sumInv);
    const pEmpirical = spfPrediction.final || spfPrediction.empirical;

    if (pEmpirical && pEmpirical.length === 3) {
      const awayDiff = pEmpirical[2] - pMarket[2];
      const drawDiff = pEmpirical[1] - pMarket[1];
      const winDiff = pMarket[0] - pEmpirical[0];

      if (awayDiff >= 0.08 && hadOdds[2] >= 2.4) {
        signals.push({
          type: "value",
          tag: "📊 历史样本观察",
          desc: `历史相似样本客胜率(${(pEmpirical[2] * 100).toFixed(0)}%)高于当前赔率去水水平(${(pMarket[2] * 100).toFixed(0)}%)`,
        });
      } else if (drawDiff >= 0.08 && hadOdds[1] >= 3.0) {
        signals.push({
          type: "value",
          tag: "📊 历史样本观察",
          desc: `历史相似样本平局率(${(pEmpirical[1] * 100).toFixed(0)}%)高于当前赔率去水水平(${(pMarket[1] * 100).toFixed(0)}%)`,
        });
      }

      if (
        hadOdds[0] <= 1.65 &&
        (winDiff >= 0.12 || pEmpirical[1] + pEmpirical[2] >= 0.45)
      ) {
        signals.push({
          type: "danger",
          tag: "📊 历史样本观察",
          desc: `历史同盘口平负打出率为 ${((pEmpirical[1] + pEmpirical[2]) * 100).toFixed(0)}%，与当前低赔主胜结构存在描述性差异`,
        });
      }
    }
  }

  if (hadTl.length > 1) {
    const firstH = Number(hadTl[0].h);
    const lastH = Number(hadTl.at(-1).h);
    const firstA = Number(hadTl[0].a);
    const lastA = Number(hadTl.at(-1).a);

    if (lastH - firstH <= -0.1) {
      signals.push({
        type: "defense",
        tag: "📉 赔率变化记录",
        desc: `主胜赔率较初始值下调 ${(firstH - lastH).toFixed(2)}，仅描述初终赔变化`,
      });
    } else if (lastA - firstA <= -0.1) {
      signals.push({
        type: "defense",
        tag: "📉 赔率变化记录",
        desc: `客胜赔率较初始值下调 ${(firstA - lastA).toFixed(2)}，仅描述初终赔变化`,
      });
    }
  }

  if (!signals.length) {
    signals.push({
      type: "balanced",
      tag: "⚖️ 未触发观察阈值",
      desc: "当前差异未达到页面预设的描述阈值",
    });
  }

  return signals;
}

const effectiveSamples = (prediction) =>
  Number(prediction?.weighting?.effectiveSamples || 0);
const weightingLabel = (prediction) =>
  prediction?.weighting?.enabled ? "距离加权" : "等权统计";
const finalProbabilities = (prediction) =>
  prediction?.final?.length
    ? prediction.final
    : prediction?.market || [];
const smoothingLabel = (prediction) =>
  prediction?.probabilityModel?.enabled
    ? "最终概率 · 赔率与历史融合"
    : Number(prediction?.empiricalWeight || 0) >= 1 - 1e-12
    ? "相似历史概率"
    : Number(prediction?.empiricalWeight || 0) === 0
    ? "最终概率 · 终赔去水"
    : prediction?.smoothing?.applied
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

function reliabilityDisplay(prediction) {
  const reliability = prediction?.reliability;
  if (!reliability) {
    return {
      level: "skip",
      label: "建议跳过",
      reason: "当前没有可用玩法赔率，或没有找到可用的相似历史比赛。",
    };
  }
  const level = ["recommended", "cautious", "skip"].includes(reliability.level)
    ? reliability.level
    : "cautious";
  return {
    level,
    label:
      level === "recommended"
        ? "历史稳定"
        : level === "skip"
          ? "样本不足"
          : "历史观察",
    reason: reliability.reason || "当前结果尚缺少足够的历史验证依据。",
  };
}

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
    void loadMatchReliability();
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
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  [
    "#single-view",
    "#parlay-view",
    "#ledger-view",
    ".workspace",
    ".ledger-workspace",
    ".parlay-layout",
  ].forEach((sel) => {
    const el = $(sel);
    if (el) el.scrollTop = 0;
  });
}

const ledgerMarketNames = {
  spf: "胜平负",
  hhad: "让球胜平负",
  goals: "总进球",
  goalsPair: "总进球双选",
  goalMultiple: "0球倍数双选",
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

const ledgerSampleLabels = {
  empty: "尚无结果",
  insufficient: "样本不足",
  preliminary: "初步观察",
  reference: "阶段参考",
};

function ledgerInterval(metrics) {
  if (metrics?.accuracyLow === null || metrics?.accuracyLow === undefined) {
    return "—";
  }
  return `${pct(metrics.accuracyLow)}–${pct(metrics.accuracyHigh)}`;
}

function renderLedgerMarkets(data) {
  const scopeCell = (metrics, label, { metricsOnly = false } = {}) => {
    const settled = Number(metrics?.settled || 0);
    const correct = Number(metrics?.correct || 0);
    const accuracy = metrics?.accuracy;
    const sampleLevel = metrics?.sampleLevel || "empty";
    const multi = metrics?.multiSelection || {};
    const multiText = Number(multi.settled || 0)
      ? `双选覆盖 ${Number(multi.correct || 0)} 中 / ${Number(multi.settled)} 条 · ${ledgerMetric(multi.coverageAccuracy)}`
      : "";
    if (!settled) {
      return `<div class="ledger-scope-audit empty"><span>${escapeHtml(label)}</span><strong>暂无已结算样本</strong><small>—</small></div>`;
    }
    const profitText = metricsOnly || metrics?.roi === null || metrics?.roi === undefined
      ? "仅统计命中率"
      : `模拟ROI ${ledgerMetric(metrics.roi)}`;
    return `<div class="ledger-scope-audit">
      <span>${escapeHtml(label)}</span>
      <strong>${ledgerMetric(accuracy)}</strong>
      <small>${correct} 中 / ${settled} 条 · 95%区间 ${escapeHtml(ledgerInterval(metrics))}</small>
      <small>${escapeHtml(profitText)}</small>
      ${multiText ? `<small>${escapeHtml(multiText)}</small>` : ""}
      <em class="ledger-sample-badge ${escapeHtml(sampleLevel)}">${escapeHtml(ledgerSampleLabels[sampleLevel] || sampleLevel)}</em>
    </div>`;
  };
  $("#ledger-accuracy-body").innerHTML = [
    "spf",
    "hhad",
    "goals",
    "goalsPair",
    "goalMultiple",
  ]
    .map((market) => {
      const scopes = data.byMarketScope?.[market] || {};
      const allMetrics = scopes.all || {};
      const sameLeagueMetrics = scopes.sameLeague || {};
      return `
        <tr>
          <th scope="row">${escapeHtml(ledgerMarketNames[market])}<small>${market === "goalMultiple" ? "独立倍数历史规则" : "两种范围分别核对"}</small></th>
          <td data-label="全部联赛">${scopeCell(allMetrics, "ALL LEAGUES", { metricsOnly: market === "goalMultiple" })}</td>
          <td data-label="同联赛">${scopeCell(sameLeagueMetrics, "SAME LEAGUE", { metricsOnly: market === "goalMultiple" })}</td>
        </tr>`;
    })
    .join("");
}

function ledgerLift(value) {
  if (value === null || value === undefined) return "—";
  const points = Number(value) * 100;
  return `${points > 0 ? "+" : ""}${points.toFixed(1)}pp`;
}

function ledgerProbability(value) {
  if (value === null || value === undefined) return "—";
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function renderLedgerBenchmarkPriority(data) {
  const statusLabels = {
    empty: "暂无对照",
    insufficient: "样本不足",
    better: "支持模型更优",
    worse: "终赔基准更优",
    uncertain: "尚未证明",
  };
  const markets = ["spf", "hhad", "goals"];
  $("#ledger-benchmark-priority-grid").innerHTML = markets
    .map((market) => {
      const all = data.oddsBenchmark?.byMarketScope?.[market]?.all || {};
      const same = data.oddsBenchmark?.byMarketScope?.[market]?.sameLeague || {};
      const status = all.liftStatus || "empty";
      const interval =
        all.liftLow === null || all.liftLow === undefined
          ? "—"
          : `${ledgerLift(all.liftLow)} ～ ${ledgerLift(all.liftHigh)}`;
      const sameLift = same.lift === null || same.lift === undefined
        ? "暂无同联赛对照"
        : `同联赛提升 ${ledgerLift(same.lift)} · ${Number(same.compared || 0)}条`;
      return `<article class="ledger-benchmark-card ${escapeHtml(status)}">
        <header>
          <span>${escapeHtml(ledgerMarketNames[market])}</span>
          <em>${escapeHtml(statusLabels[status] || status)}</em>
        </header>
        <div class="ledger-benchmark-score">
          <span><small>历史模型</small><strong>${ledgerMetric(all.modelAccuracy)}</strong></span>
          <i>VS</i>
          <span><small>终赔基准</small><strong>${ledgerMetric(all.oddsAccuracy)}</strong></span>
        </div>
        <div class="ledger-benchmark-lift">
          <strong>${ledgerLift(all.lift)}</strong>
          <span>相对提升 · ${Number(all.compared || 0).toLocaleString()}条同场对照</span>
        </div>
        <p>时间分块95%区间 ${escapeHtml(interval)} · 优于基准概率 ${escapeHtml(ledgerProbability(all.liftImprovementProbability))}</p>
        <small class="ledger-benchmark-same">${escapeHtml(sameLift)}</small>
      </article>`;
    })
    .join("");
}

function renderLedgerKeyFindings(data) {
  const liftStatusLabels = {
    better: "已支持模型更优",
    worse: "终赔基准暂时更优",
    uncertain: "区间仍跨过0，尚未证明",
    insufficient: "样本不足",
    empty: "暂无对照",
  };
  const marketEntries = ["spf", "hhad", "goals"]
    .map((market) => ({
      market,
      metrics: data.oddsBenchmark?.byMarketScope?.[market]?.all || {},
    }))
    .filter(({ metrics }) =>
      Number(metrics.compared || 0) >= 20 &&
      metrics.lift !== null &&
      metrics.lift !== undefined &&
      Number.isFinite(Number(metrics.lift)),
    );
  const ranked = [...marketEntries].sort(
    (left, right) => Number(right.metrics.lift) - Number(left.metrics.lift),
  );
  const best = ranked[0] || null;
  const weakest = ranked.at(-1) || null;
  const calibrationBins = (data.calibrationByScope?.all?.bins || [])
    .filter((bin) =>
      Number(bin.settled || 0) > 0 &&
      bin.predictedAverage !== null &&
      bin.predictedAverage !== undefined &&
      bin.actualAccuracy !== null &&
      bin.actualAccuracy !== undefined &&
      Number.isFinite(Number(bin.predictedAverage)) &&
      Number.isFinite(Number(bin.actualAccuracy)),
    )
    .sort((left, right) =>
      Number(right.predictedAverage) - Number(left.predictedAverage),
    );
  const confidence = calibrationBins[0] || null;
  const confidenceMature = Number(confidence?.settled || 0) >= 20;
  const confidenceGap = confidence
    ? Number(confidence.actualAccuracy) - Number(confidence.predictedAverage)
    : null;
  const confidenceVerdict = confidenceGap === null
    ? "等待结算"
    : confidenceGap <= -0.15
      ? "明显虚高"
      : confidenceGap <= -0.05
        ? "略显虚高"
        : confidenceGap >= 0.05
          ? "相对保守"
          : "基本可信";
  const confidenceClass = confidenceGap !== null && confidenceGap <= -0.05
    ? "warning"
    : "stable";

  const findingCard = ({ tone, kicker, label, value, detail }) => `
    <article class="ledger-key-card ${escapeHtml(tone)}">
      <span>${escapeHtml(kicker)}</span>
      <h3>${escapeHtml(label)}</h3>
      <strong>${escapeHtml(value)}</strong>
      <p>${escapeHtml(detail)}</p>
    </article>`;

  $("#ledger-key-findings").innerHTML = [
    findingCard(best
      ? {
          tone: Number(best.metrics.lift) >= 0 ? "best" : "weak",
          kicker: "相对提升最高",
          label: ledgerMarketNames[best.market],
          value: ledgerLift(best.metrics.lift),
          detail: `模型 ${ledgerMetric(best.metrics.modelAccuracy)}，终赔 ${ledgerMetric(best.metrics.oddsAccuracy)}；${liftStatusLabels[best.metrics.liftStatus] || "等待判断"}。`,
        }
      : {
          tone: "empty",
          kicker: "相对提升最高",
          label: "样本尚未成熟",
          value: "—",
          detail: "至少有一个玩法完成20条同场终赔对照后再比较。",
        }),
    findingCard(weakest
      ? {
          tone: Number(weakest.metrics.lift) < 0 ? "weak" : "best",
          kicker: "相对提升最低",
          label: ledgerMarketNames[weakest.market],
          value: ledgerLift(weakest.metrics.lift),
          detail: `模型 ${ledgerMetric(weakest.metrics.modelAccuracy)}，终赔 ${ledgerMetric(weakest.metrics.oddsAccuracy)}；${liftStatusLabels[weakest.metrics.liftStatus] || "等待判断"}。`,
        }
      : {
          tone: "empty",
          kicker: "相对提升最低",
          label: "样本尚未成熟",
          value: "—",
          detail: "当前还不能按相对终赔基准区分玩法强弱。",
        }),
    findingCard(confidence && confidenceMature
      ? {
          tone: confidenceClass,
          kicker: "高概率检查",
          label: confidenceVerdict,
          value: `${ledgerMetric(confidence.predictedAverage)} → ${ledgerMetric(confidence.actualAccuracy)}`,
          detail: `${confidence.label}档：左边是页面平均预测，右边是真实命中，共${Number(confidence.settled || 0)}条。`,
        }
      : confidence
        ? {
            tone: "empty",
            kicker: "高概率检查",
            label: "样本不足",
            value: `${Number(confidence.settled || 0)} 条`,
            detail: `${confidence.label}档尚未达到20条，不评价概率是否虚高。`,
          }
        : {
          tone: "empty",
          kicker: "高概率检查",
          label: "暂无可用数据",
          value: "—",
          detail: "等待带预测概率的基础玩法完成结算。",
        }),
  ].join("");
}

function renderLedgerScopeComparison(data) {
  const markets = ["spf", "hhad", "goals"];
  $("#ledger-scope-comparison").innerHTML = markets
    .map((market) => {
      const scopes = data.byMarketScope?.[market] || {};
      const rows = [
        ["all", "全部联赛"],
        ["sameLeague", "同联赛"],
      ].map(([key, label]) => {
        const metrics = scopes[key] || {};
        const accuracy = metrics.accuracy;
        const width = accuracy === null || accuracy === undefined
          ? 0
          : Math.max(0, Math.min(100, accuracy * 100));
        return `<div class="ledger-scope-row">
          <span>${label}</span>
          <div aria-hidden="true"><i style="width:${width.toFixed(1)}%"></i></div>
          <strong>${ledgerMetric(accuracy)}</strong>
          <small>${Number(metrics.correct || 0)}/${Number(metrics.settled || 0)}</small>
        </div>`;
      }).join("");
      return `<article><h3>${escapeHtml(ledgerMarketNames[market])}</h3>${rows}</article>`;
    })
    .join("");
}

function renderLedgerCalibration(data) {
  const calibration = data.calibrationByScope?.all || data.calibration || { settled: 0, bins: [] };
  if (!calibration.settled) {
    $("#ledger-calibration").innerHTML =
      '<div class="ledger-analysis-empty">当前口径尚无已结算的基础预测，暂时无法检验概率是否可信。</div>';
    return;
  }
  $("#ledger-calibration").innerHTML = calibration.bins
    .map((bin) => {
      const predicted = bin.predictedAverage;
      const actual = bin.actualAccuracy;
      const predictedWidth = predicted === null ? 0 : predicted * 100;
      const actualWidth = actual === null ? 0 : actual * 100;
      return `<article class="ledger-calibration-bin">
        <header><strong>${escapeHtml(bin.label)}</strong><small>${Number(bin.correct || 0)} 中 / ${Number(bin.settled || 0)} 条</small></header>
        <div class="ledger-calibration-row predicted"><span>平均预测</span><div aria-hidden="true"><i style="width:${predictedWidth.toFixed(1)}%"></i></div><strong>${predicted === null ? "—" : ledgerMetric(predicted)}</strong></div>
        <div class="ledger-calibration-row actual"><span>实际命中</span><div aria-hidden="true"><i style="width:${actualWidth.toFixed(1)}%"></i></div><strong>${actual === null ? "—" : ledgerMetric(actual)}</strong></div>
      </article>`;
    })
    .join("");
}

function signedRecord(value) {
  const number = Number(value || 0);
  return `${number > 0 ? "+" : ""}${number}`;
}

function comparisonClass(value) {
  const number = Number(value || 0);
  return number > 0 ? "positive" : number < 0 ? "negative" : "neutral";
}

function renderLedgerFairComparison(data) {
  const benchmarkRows = ["spf", "hhad", "goals"].flatMap((market) =>
    [
      ["all", "全部联赛"],
      ["sameLeague", "同联赛"],
    ].map(([scope, scopeLabel]) => ({
      market,
      scopeLabel,
      metrics: data.oddsBenchmark?.byMarketScope?.[market]?.[scope] || {},
    })),
  ).filter((row) => Number(row.metrics.compared || 0) > 0);
  $("#ledger-odds-benchmark").innerHTML = benchmarkRows.length
    ? `<table class="ledger-fair-table">
        <thead><tr><th>玩法/范围</th><th>配对</th><th>模型</th><th>终赔</th><th>方向不同</th><th>模型净胜</th></tr></thead>
        <tbody>${benchmarkRows.map(({ market, scopeLabel, metrics }) => `
          <tr>
            <th scope="row">${escapeHtml(ledgerMarketNames[market])}<small>${escapeHtml(scopeLabel)}</small></th>
            <td data-label="配对">${Number(metrics.compared || 0)}</td>
            <td data-label="模型">${ledgerMetric(metrics.modelAccuracy)}<small>${Number(metrics.modelCorrect || 0)}中</small></td>
            <td data-label="终赔">${ledgerMetric(metrics.oddsAccuracy)}<small>${Number(metrics.oddsCorrect || 0)}中</small></td>
            <td data-label="方向不同">${Number(metrics.directionsDiffer || 0)}</td>
            <td data-label="模型净胜"><strong class="ledger-net ${comparisonClass(metrics.netWins)}">${signedRecord(metrics.netWins)}</strong></td>
          </tr>`).join("")}</tbody>
      </table>`
    : '<div class="ledger-analysis-empty">当前口径尚无可与终赔方向公平比较的已结算预测。</div>';

  const scopeRows = ["spf", "hhad", "goals"]
    .map((market) => ({
      market,
      metrics: data.scopeComparison?.byMarket?.[market] || {},
    }))
    .filter((row) => Number(row.metrics.paired || 0) > 0);
  $("#ledger-scope-pairs").innerHTML = scopeRows.length
    ? `<table class="ledger-fair-table">
        <thead><tr><th>玩法</th><th>配对</th><th>全部联赛</th><th>同联赛</th><th>方向不同</th><th>同联赛净胜</th></tr></thead>
        <tbody>${scopeRows.map(({ market, metrics }) => `
          <tr>
            <th scope="row">${escapeHtml(ledgerMarketNames[market])}</th>
            <td data-label="配对">${Number(metrics.paired || 0)}</td>
            <td data-label="全部联赛">${ledgerMetric(metrics.allAccuracy)}<small>${Number(metrics.allCorrect || 0)}中</small></td>
            <td data-label="同联赛">${ledgerMetric(metrics.sameLeagueAccuracy)}<small>${Number(metrics.sameLeagueCorrect || 0)}中</small></td>
            <td data-label="方向不同">${Number(metrics.directionsDiffer || 0)}</td>
            <td data-label="同联赛净胜"><strong class="ledger-net ${comparisonClass(metrics.sameLeagueNetWins)}">${signedRecord(metrics.sameLeagueNetWins)}</strong></td>
          </tr>`).join("")}</tbody>
      </table>`
    : '<div class="ledger-analysis-empty">当前口径尚无两种范围同时结算、且模型版本一致的同场配对记录。</div>';
}

function diagnosisSampleBadge(metrics) {
  const sampleLevel = metrics?.sampleLevel || "empty";
  return `<span class="ledger-sample-badge ${escapeHtml(sampleLevel)}">${escapeHtml(ledgerSampleLabels[sampleLevel] || sampleLevel)}</span>`;
}

function diagnosisRate(metrics, field = "missRate") {
  return Number(metrics?.settled || 0) > 0 ? ledgerMetric(metrics?.[field]) : "—";
}

function diagnosisTable(rows, firstColumn) {
  if (!rows.length) {
    return '<div class="ledger-analysis-empty">当前口径尚无可诊断的已结算记录。</div>';
  }
  return `<table class="ledger-diagnosis-table">
    <thead><tr><th>${escapeHtml(firstColumn)}</th><th>已结算</th><th>失误</th><th>失误率</th><th>样本判断</th></tr></thead>
    <tbody>${rows.map((row) => `
      <tr>
        <th scope="row">${escapeHtml(row.label)}</th>
        <td data-label="已结算">${Number(row.settled || 0)}</td>
        <td data-label="失误">${Number(row.misses || 0)}</td>
        <td data-label="失误率"><strong>${ledgerMetric(row.missRate)}</strong></td>
        <td data-label="样本判断">${diagnosisSampleBadge(row)}</td>
      </tr>`).join("")}</tbody>
  </table>`;
}

function confusionLabel(market, label) {
  return market === "goals" ? `${label}球` : label;
}

function renderConfusionMatrix(data) {
  const confusion = data.errorDiagnosis?.confusion || {};
  const cards = ["spf", "hhad", "goals"].map((market) => {
    const metrics = confusion[market] || {};
    const labels = metrics.labels || [];
    const matrix = metrics.matrix || [];
    const single = Number(metrics.singlePredictions || 0);
    if (!single) {
      return `<article class="ledger-confusion-card market-${escapeHtml(market)}">
        <header><span>${escapeHtml(ledgerMarketNames[market])}</span><strong>尚无唯一方向的已结算预测</strong></header>
        <div class="ledger-analysis-empty">等待当前统计口径产生可进入矩阵的实际结果。</div>
      </article>`;
    }
    const topError = metrics.topErrors?.[0];
    const maxCell = Math.max(1, Number(metrics.maxCell || 0));
    const table = `<div class="ledger-confusion-table-wrap"><table class="ledger-confusion-table">
      <caption>${escapeHtml(ledgerMarketNames[market])}预测值与实际结果交叉表</caption>
      <thead><tr><th scope="col">预测↓ / 实际→</th>${labels.map((label) => `<th scope="col">${escapeHtml(confusionLabel(market, label))}</th>`).join("")}</tr></thead>
      <tbody>${labels.map((predicted, predictedIndex) => `
        <tr><th scope="row">${escapeHtml(confusionLabel(market, predicted))}</th>${labels.map((actual, actualIndex) => {
          const count = Number(matrix[predictedIndex]?.[actualIndex] || 0);
          const diagonal = predictedIndex === actualIndex;
          const intensity = count / maxCell;
          const description = `预测${confusionLabel(market, predicted)}，实际${confusionLabel(market, actual)}，共${count}条`;
          const title = `${description}${count ? " · 点击下钻筛选单场明细" : ""}`;
          return `<td><button type="button" class="ledger-confusion-cell ${diagonal ? "correct" : "error"}" style="--matrix-error-alpha:${(0.06 + intensity * 0.32).toFixed(4)};--matrix-correct-alpha:${(0.08 + intensity * 0.48).toFixed(4)}" aria-label="${escapeHtml(description)}${count ? "，点击查看比赛" : ""}" title="${escapeHtml(title)}" ${count ? `data-confusion-market="${escapeHtml(market)}" data-confusion-predicted="${escapeHtml(predicted)}" data-confusion-actual="${escapeHtml(actual)}"` : "disabled"}><strong>${count}</strong><small>${diagonal ? "命中" : "误判"}</small></button></td>`;
        }).join("")}</tr>`).join("")}</tbody>
    </table></div>`;
    const commonErrors = (metrics.topErrors || []).slice(0, 3);
    const bias = metrics.bias;
    const insight = market === "goals" && bias
      ? `<div class="ledger-confusion-bias">
          <span>预测偏低<strong>${Number(bias.predictedLow || 0)}</strong></span>
          <span>完全命中<strong>${Number(bias.exact || 0)}</strong></span>
          <span>预测偏高<strong>${Number(bias.predictedHigh || 0)}</strong></span>
          <span>仅差1球<strong>${Number(bias.offByOne || 0)}</strong></span>
          <span>相差2档以上<strong>${Number(bias.far || 0)}</strong></span>
        </div>`
      : `<div class="ledger-confusion-errors">${commonErrors.length
          ? commonErrors.map((error) => `<span>预测${escapeHtml(error.predicted)} → 实际${escapeHtml(error.actual)}<strong>${Number(error.count)}条</strong></span>`).join("")
          : "<span>当前唯一方向预测全部命中</span>"}</div>`;
    return `<article class="ledger-confusion-card market-${escapeHtml(market)}">
      <header>
        <span>${escapeHtml(ledgerMarketNames[market])}</span>
        <strong>${Number(metrics.correct || 0)} 中 / ${single} 条 · ${ledgerMetric(metrics.accuracy)}</strong>
        <small>${topError ? `最常见误判：预测${confusionLabel(market, topError.predicted)} → 实际${confusionLabel(market, topError.actual)}，${Number(topError.count)}条` : "当前没有误判"}${Number(metrics.ambiguous || 0) ? ` · 另有${Number(metrics.ambiguous)}条并列方向未入矩阵` : ""}</small>
      </header>
      ${table}
      ${insight}
    </article>`;
  });
  $("#ledger-confusion").innerHTML = cards.join("");
  $$("[data-confusion-market]").forEach((button) => {
    button.addEventListener("click", () => {
      const market = button.dataset.confusionMarket;
      const predicted = button.dataset.confusionPredicted;
      const actual = button.dataset.confusionActual;
      state.ledgerDrilldown = { market, predicted, actual };
      $("#ledger-single-policy").value = $("#ledger-overview-policy").value;
      $("#ledger-single-status").value = "settled";
      $("#ledger-single-market").value = market;
      $("#ledger-single-scope").value = "all";
      $("#ledger-single-league").value = "all";
      $("#ledger-single-query").value = "";
      $("#ledger-single-from").value = "";
      $("#ledger-single-to").value = "";
      state.ledgerSinglePage = 1;
      setLedgerTab("single");
      loadLedger({ settle: false });
    });
  });
}

function renderLedgerErrorDiagnosis(data) {
  const diagnosis = data.errorDiagnosis || {};
  const overall = diagnosis.overall || {};
  const summary = $("#ledger-diagnosis-summary");
  if (!Number(overall.settled || 0)) {
    summary.innerHTML =
      '<div class="ledger-analysis-empty">当前统计口径还没有已结算的胜平负、让球或进球数预测，结算后这里会自动形成失误画像。</div>';
    $("#ledger-diagnosis-signals").innerHTML = "";
    $("#ledger-diagnosis-odds").innerHTML = "";
    $("#ledger-diagnosis-leagues").innerHTML = "";
    renderConfusionMatrix(data);
    return;
  }

  const marketRows = ["spf", "hhad", "goals"]
    .map((market) => ({
      market,
      label: ledgerMarketNames[market],
      ...(diagnosis.byMarket?.[market] || {}),
    }))
    .filter((row) => Number(row.settled || 0) > 0)
    .sort(
      (left, right) =>
        Number(right.misses || 0) - Number(left.misses || 0) ||
        Number(right.missRate || 0) - Number(left.missRate || 0),
    );
  const worst = marketRows[0];
  const movement = diagnosis.movementDirection || {};
  summary.innerHTML = [
    {
      label: "总失误",
      value: `${Number(overall.misses || 0)} / ${Number(overall.settled || 0)}`,
      detail: `失误率 ${ledgerMetric(overall.missRate)} · ${ledgerSampleLabels[overall.sampleLevel] || "样本未知"}`,
    },
    {
      label: "错误最多玩法",
      value: Number(worst?.misses || 0) ? worst.label : "暂未出现",
      detail: worst
        ? `${Number(worst.misses || 0)} 条失误 / ${Number(worst.settled || 0)} 条 · ${ledgerMetric(worst.missRate)}`
        : "等待更多已结算记录",
    },
    {
      label: "初终赔诊断覆盖",
      value: `${Number(movement.available || 0)} / ${Number(overall.settled || 0)}`,
      detail: Number(movement.unavailable || 0)
        ? `${Number(movement.unavailable)} 条旧记录未保存初赔`
        : "已结算记录均有初赔留档",
    },
  ].map((card) => `<article><span>${escapeHtml(card.label)}</span><strong>${escapeHtml(card.value)}</strong><small>${escapeHtml(card.detail)}</small></article>`).join("");

  const signalGroup = (title, rows, unavailableText) => `
    <section>
      <header><h4>${escapeHtml(title)}</h4><small>${escapeHtml(unavailableText)}</small></header>
      ${rows.map(([label, metrics]) => `
        <div class="ledger-diagnosis-signal-row">
          <span>${escapeHtml(label)}</span>
          <strong>${Number(metrics?.misses || 0)} 错 / ${Number(metrics?.settled || 0)} 条</strong>
          <em>${diagnosisRate(metrics)} 失误率</em>
          ${diagnosisSampleBadge(metrics)}
        </div>`).join("")}
    </section>`;
  const oddsDirection = diagnosis.oddsDirection || {};
  $("#ledger-diagnosis-signals").innerHTML = [
    signalGroup(
      "模型 vs 终赔最低赔率",
      [
        ["方向一致", oddsDirection.same],
        ["方向不同", oddsDirection.different],
      ],
      Number(oddsDirection.unavailable || 0)
        ? `${Number(oddsDirection.unavailable)} 条赔率不可比较`
        : "全部可比较",
    ),
    signalGroup(
      "初赔 vs 终赔最低赔率",
      [
        ["方向未变", movement.stable],
        ["方向变化", movement.changed],
      ],
      Number(movement.unavailable || 0)
        ? `${Number(movement.unavailable)} 条缺少初赔留档`
        : "全部有初赔",
    ),
  ].join("");

  $("#ledger-diagnosis-odds").innerHTML = diagnosisTable(
    (diagnosis.byOddsBand || []).filter((row) => Number(row.settled || 0) > 0),
    "所选赔率",
  );
  $("#ledger-diagnosis-leagues").innerHTML = diagnosisTable(
    diagnosis.byLeague || [],
    "联赛",
  );
  renderConfusionMatrix(data);
}

function renderLedgerSecondary(data, parlays) {
  const single = data.overall || {};
  const standard = parlays?.byMode?.standard || {};
  const goalsPair = parlays?.byMode?.goalsPair || {};
  const cards = [
    {
      label: "单场模拟盈亏",
      value: single.settled ? ledgerProfit(single.simulatedProfit) : "—",
      detail: single.settled
        ? `${single.stakeUnits} 注 · ROI ${ledgerMetric(single.roi)}`
        : "等待基础玩法结算",
    },
    {
      label: "常规串关",
      value: ledgerMetric(standard.accuracy),
      detail: standard.settled
        ? `${standard.correct} 中 / ${standard.settled} 组 · 盈亏 ${ledgerProfit(standard.simulatedProfit)}`
        : "尚无已结算组合",
    },
    {
      label: "进球双选串",
      value: ledgerMetric(goalsPair.accuracy),
      detail: goalsPair.settled
        ? `${goalsPair.correct} 中 / ${goalsPair.settled} 组 · 盈亏 ${ledgerProfit(goalsPair.simulatedProfit)}`
        : "尚无已结算组合",
    },
  ];
  $("#ledger-secondary-grid").innerHTML = cards
    .map((card) => `<article><span>${escapeHtml(card.label)}</span><strong>${escapeHtml(card.value)}</strong><small>${escapeHtml(card.detail)}</small></article>`)
    .join("");
}

function renderLedgerEvidence(data) {
  const evidence = data.evidence || {};
  const current = evidence.current || {};
  const lifetime = evidence.lifetime || {};
  const historical = evidence.historical || {};
  const currentLevel = current.sampleLevel || "empty";
  const currentFixtures = Number(current.settledFixtures || 0);
  const lifetimeFixtures = Number(lifetime.settledFixtures || 0);
  const historyMatches = Number(historical.unifiedHistory || 0);
  const verifiedHistory = Number(historical.verifiedHistory || 0);

  $("#ledger-evidence-current").textContent =
    `${currentFixtures.toLocaleString()} 场`;
  $("#ledger-evidence-current-detail").textContent =
    `同一算法跨数据更新时间累计：全部联赛 ${Number(current.allLeaguePredictions || 0).toLocaleString()} 条、同联赛 ${Number(current.sameLeaguePredictions || 0).toLocaleString()} 条。`;
  const currentStatus = $("#ledger-evidence-current-status");
  currentStatus.className = `sample-${currentLevel}`;
  currentStatus.textContent = ledgerSampleLabels[currentLevel] || "核对中";

  $("#ledger-evidence-lifetime").textContent =
    `${lifetimeFixtures.toLocaleString()} 场`;
  $("#ledger-evidence-lifetime-detail").textContent =
    `共 ${Number(lifetime.settledPredictions || 0).toLocaleString()} 条基础玩法赛前预测；包含多个历史规则版本，只用于长期回顾。`;

  $("#ledger-evidence-history").textContent =
    `${historyMatches.toLocaleString()} 场`;
  $("#ledger-evidence-history-detail").textContent =
    `${verifiedHistory.toLocaleString()} 场通过完整性校验，可按时间顺序用于匹配和独立验证。`;
  const historyStatus = $("#ledger-evidence-history-status");
  historyStatus.className = historical.stale ? "stale" : "verified";
  historyStatus.textContent = historical.stale ? "报告待重验" : "滚动验证有效";

  const validationLabels = {
    spf: "胜平负",
    hhad: "让球",
    goals: "总进球",
  };
  const validationRows = ["spf", "hhad", "goals"]
    .map((market) => ({
      market,
      metrics: historical.markets?.[market],
    }))
    .filter(({ metrics }) => metrics && Number(metrics.evaluated || 0) > 0);
  $("#ledger-evidence-validation").innerHTML = validationRows.length
    ? validationRows
        .map(({ market, metrics }) => `
          <span>
            <b>${escapeHtml(validationLabels[market])}</b>
            <strong>${ledgerMetric(metrics.accuracy)}</strong>
            <small>最新独立段 ${Number(metrics.evaluated || 0).toLocaleString()} 场</small>
          </span>`)
        .join("")
    : '<small class="ledger-evidence-validation-empty">尚无与当前历史库一致的滚动验证报告。</small>';
}

function renderLedgerMaturity(data) {
  const totals = data.totals || {};
  const overall = data.overall || {};
  const mode = data.policyMode || "current";
  const sampleLevel = totals.fixtureSampleLevel || "empty";
  const settledCounts = settledLedgerCounts(totals, data.coreByScope || {});
  $("#ledger-fixtures").textContent = settledCounts.fixtures.toLocaleString();
  $("#ledger-fixtures-detail").textContent =
    mode === "current"
      ? "当前算法版本 · 不含待结算"
      : "全部历史版本 · 不含待结算";
  $("#ledger-settled-all").textContent = settledCounts.allPredictions.toLocaleString();
  $("#ledger-settled-all-detail").textContent =
    mode === "current" ? "同一算法跨数据版本累计" : "包含不同历史版本";
  $("#ledger-settled-same").textContent = settledCounts.sameLeaguePredictions.toLocaleString();
  $("#ledger-settled-same-detail").textContent = "与全部联赛分开计算";
  $("#ledger-pending").textContent = Number(totals.corePendingFixtures || 0).toLocaleString();
  $("#ledger-pending-detail").textContent =
    `${Number(totals.corePending || 0)} 条基础玩法预测待结算`;
  $("#ledger-maturity").textContent = ledgerSampleLabels[sampleLevel] || "—";
  $("#ledger-maturity-detail").textContent =
    sampleLevel === "empty"
      ? "至少结算20条后再作初步判断"
      : sampleLevel === "insufficient"
        ? "少于20条，不宜据此下结论"
        : sampleLevel === "preliminary"
          ? "20–49条，只作初步观察"
          : "50条以上，可作阶段参考";
  const note = $("#ledger-maturity-note");
  note.className = `ledger-maturity-note ${sampleLevel}`;
  if (mode === "all") {
    note.textContent = `这里展示全部版本的赛前实战账本，只用于长期回顾；不能把混合结果当作当前版本准确率。`;
  } else if (!settledCounts.fixtures) {
    note.textContent = `当前算法还没有独立比赛完成结算；这不代表历史数据库没有样本。`;
  } else {
    note.textContent = `“${ledgerSampleLabels[sampleLevel] || "统计中"}”描述当前算法的赛前实战：已有 ${settledCounts.fixtures} 场独立比赛完成结算；数据更新不会重置，规则或阈值变化才切换版本。`;
  }
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

  const marketOrder = { spf: 0, hhad: 1, goals: 2, goalMultiple: 3 };
  body.innerHTML = fixtures
    .map((fixture, fixtureIndex) => {
      const expanded = state.ledgerExpandedFixtures.has(fixture.key);
      const fixtureRows = [...fixture.rows].sort(
        (left, right) =>
          (marketOrder[left.market] ?? 99) - (marketOrder[right.market] ?? 99),
      );
      const settledRows = fixtureRows.filter((row) => row.status === "settled");
      const pendingCount = fixtureRows.filter((row) => row.status !== "settled").length;

      const actualScore = fixtureRows.find((row) => row.score)?.score || "";
      const scoreBadgeHtml = actualScore
        ? `<span class="ledger-actual-score-badge">完场 ${escapeHtml(actualScore)}</span>`
        : "";

      const validSettled = settledRows.filter((row) => !row.noPrediction);
      const hitCount = validSettled.filter((row) => row.correct).length;
      const missCount = validSettled.filter((row) => !row.correct).length;

      let statusClass = "pending";
      let statusText = `${pendingCount} 项待结算`;
      if (pendingCount === 0 && validSettled.length > 0) {
        if (missCount === 0) {
          statusClass = "all-hit";
          statusText = `🎯 ${hitCount}中 0全中`;
        } else if (hitCount > 0) {
          statusClass = "partial-hit";
          statusText = `🎯 ${hitCount}中 ${missCount}错`;
        } else {
          statusClass = "miss";
          statusText = `0中 ${missCount}错`;
        }
      } else if (validSettled.length > 0) {
        statusClass = "pending";
        statusText = `${hitCount}中 ${missCount}错 · ${pendingCount}待结算`;
      }

      const quickOutcomesHtml = fixtureRows.map((row) => {
        const marketName = ledgerMarketNames[row.market] || row.market;
        if (row.status !== "settled") {
          return `<span class="fixture-outcome-chip pending" title="${escapeHtml(marketName)}: 待结算">${escapeHtml(marketName)} ⏳</span>`;
        }
        if (row.noPrediction) {
          return `<span class="fixture-outcome-chip pending" title="${escapeHtml(marketName)}: 无单选预测">${escapeHtml(marketName)} (无预测)</span>`;
        }
        const predText = row.predicted ? `${escapeHtml(row.predicted)}${row.market === "goalMultiple" ? "球" : ""}` : "";
        const actualText = row.actualResult ? `${escapeHtml(row.actualResult)}${row.market === "goalMultiple" ? "球" : ""}` : "";
        if (row.correct) {
          return `<span class="fixture-outcome-chip hit" title="${escapeHtml(marketName)} · 预测[${predText}] 实际[${actualText}]">✓ ${escapeHtml(marketName)} (${predText})</span>`;
        }
        return `<span class="fixture-outcome-chip miss" title="${escapeHtml(marketName)} · 预测[${predText}] 实际[${actualText}]">✗ ${escapeHtml(marketName)} (${predText})</span>`;
      }).join("");

      const marketRows = fixtureRows
        .map((row) => {
      const marketLine =
        row.market === "hhad" && Number.isFinite(Number(row.handicap))
          ? `${ledgerMarketNames[row.market]} (${Number(row.handicap) > 0 ? "+" : ""}${row.handicap})`
          : ledgerMarketNames[row.market];
      const result =
        row.status === "settled"
          ? `${escapeHtml(row.actualResult)}${row.market === "goalMultiple" ? "球" : ""}${row.score ? ` · ${escapeHtml(row.score)}` : ""}`
          : "等待赛果";
      const verdict =
        row.status !== "settled"
          ? `<span class="ledger-verdict pending">待结算</span>`
          : row.noPrediction
            ? `<span class="ledger-verdict pending">无预测</span>`
          : row.multiSelection
            ? row.correct
              ? `<span class="ledger-verdict hit">覆盖命中</span>`
              : `<span class="ledger-verdict miss">未覆盖</span>`
          : row.correct
            ? `<span class="ledger-verdict hit">命中</span>`
            : `<span class="ledger-verdict miss">未中</span>`;
      const goalPair = row.market === "goals" ? row.goalPair : null;
      const goalMultiple =
        row.market === "goalMultiple" ? row.goalMultiple : null;
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
          : goalMultiple
            ? "只统计双选命中率，不计算模拟盈亏"
          : row.noPrediction
            ? "覆盖全部结果，不计入命中率和盈亏"
          : row.multiSelection
            ? `覆盖 ${Number(row.selectionCount || 0)} 项 · 成本 ${Number(row.stakeUnits || 0)} 注 · 模拟盈亏 ${ledgerProfit(row.simulatedProfit)}`
          : goalPair
            ? `单选 ${ledgerProfit(row.simulatedProfit)} · 双选 ${ledgerProfit(goalPair.simulatedProfit)}`
            : `模拟盈亏 ${ledgerProfit(row.simulatedProfit)}`;
      return `
        <div class="ledger-fixture-market market-${escapeHtml(row.market)} scope-${row.sameLeague ? "same" : "all"}" role="row">
          <div class="ledger-market-name" role="cell">
            <strong>${escapeHtml(marketLine)}</strong>
            <small><b class="ledger-scope-badge">${goalMultiple ? "精确0球档" : escapeHtml(row.sampleScope || "全部联赛")}</b>${Number(row.samples || 0).toLocaleString()} 场${goalMultiple ? "倍数历史" : "相似"}</small>
          </div>
          <div role="cell">
            <span class="ledger-grade ${escapeHtml(row.reliabilityLevel)}">${escapeHtml(row.reliabilityLabel)}</span>
          </div>
          <div class="ledger-market-prediction" role="cell">
            <strong>${escapeHtml(row.predicted)}${goalMultiple ? "球" : ""}</strong>
            <small>${pct(row.selectedProbability)} · ${goalMultiple ? `0球终赔 ${Number(goalMultiple.zeroOdds).toFixed(2)}` : `赔率 ${Number(row.selectedOdds).toFixed(2)}`}</small>
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
            <div class="ledger-fixture-match-info">
              <h3>
                ${escapeHtml(fixture.home)} <span class="vs-sep">vs</span> ${escapeHtml(fixture.away)}
                ${scoreBadgeHtml}
              </h3>
              <div class="ledger-fixture-quick-outcomes">
                ${quickOutcomesHtml}
              </div>
            </div>
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
          ? "⏳ 待结算"
          : row.correct
            ? `🎉 已红单 +${(row.simulatedProfit || 0).toFixed(2)}元`
            : `❌ 未中 (-${(row.stake || 1).toFixed(0)}注)`;
      const sourceText =
        row.selectionSource === "system_default" ? "测算默认" : "自选规则";
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

function ledgerRequestParams() {
  return new URLSearchParams({
    pageSize: "20",
    overviewPolicy: $("#ledger-overview-policy").value,
    singleStatus: $("#ledger-single-status").value,
    singlePolicy: $("#ledger-single-policy").value,
    singleMarket: $("#ledger-single-market").value,
    singleScope: $("#ledger-single-scope").value,
    singleLeague: $("#ledger-single-league").value,
    singleQuery: $("#ledger-single-query").value.trim(),
    singlePredicted: state.ledgerDrilldown?.predicted || "",
    singleActual: state.ledgerDrilldown?.actual || "",
    singleFrom: $("#ledger-single-from").value,
    singleTo: $("#ledger-single-to").value,
    singlePage: String(state.ledgerSinglePage),
    parlayStatus: $("#ledger-parlay-status").value,
    parlayPolicy: $("#ledger-parlay-policy").value,
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
  const overview = data.overview || data;
  const overviewParlays = overview.parlays || data.parlays || {};
  $("#ledger-policy-version").textContent = data.policyVersion || "—";
  $("#ledger-policy-version").title = data.policyVersion || "";
  $("#ledger-source-updated").textContent = data.sourceUpdatedAt
    ? `历史库更新 ${ledgerDate(data.sourceUpdatedAt)}`
    : "历史库时间未知";
  renderLedgerEvidence(overview);
  renderLedgerMaturity(overview);
  renderLedgerMarkets(overview);
  renderLedgerBenchmarkPriority(overview);
  renderLedgerKeyFindings(overview);
  renderLedgerScopeComparison(overview);
  renderLedgerCalibration(overview);
  renderLedgerFairComparison(overview);
  renderLedgerErrorDiagnosis(overview);
  renderLedgerSecondary(overview, overviewParlays);

  const capital = capitalLedgerMetrics(
    overview.overall || {},
    overviewParlays.totals || {},
  );

  if ($("#capital-total-fixtures")) {
    $("#capital-total-fixtures").textContent = `${capital.total.toLocaleString()} 条`;
    $("#capital-accuracy").textContent = ledgerMetric(capital.accuracy);
    $("#capital-accuracy-detail").textContent =
      `${capital.correct.toLocaleString()} 中 / ${capital.settled.toLocaleString()} 已结算`;
    const profitEl = $("#capital-profit");
    if (profitEl) {
      const sign = capital.simulatedProfit > 0 ? "+" : "";
      const profitYuan = (capital.simulatedProfit * 2).toFixed(2);
      profitEl.textContent = `${sign}${profitYuan} 元 (${sign}${capital.simulatedProfit.toFixed(2)} 注)`;
    }
    const returnYuan = (capital.simulatedReturn * 2).toFixed(2);
    const stakeYuan = (capital.stakeUnits * 2).toFixed(0);
    $("#capital-return").textContent =
      `总返奖 ${returnYuan} 元 (${capital.simulatedReturn.toFixed(2)} 注) / 本金 ${stakeYuan} 元 (${capital.stakeUnits.toLocaleString()} 注)`;
    $("#capital-roi").textContent = ledgerMetric(capital.roi);
    $("#capital-roi-detail").textContent = capital.stakeUnits
      ? `按 ${capital.stakeUnits.toLocaleString()} 注 (${(capital.stakeUnits * 2).toLocaleString()} 元) 成本计算`
      : "暂无已结算投注成本";
  }

  const settledTotal =
    Number(data.settledNow || 0) + Number(data.parlaySettledNow || 0);
  const backfilledTotal = Number(data.parlayBackfilledNow || 0);
  if (settledTotal) {
    const backfilledText = backfilledTotal
      ? `，并补齐 ${backfilledTotal} 组已结算串关的迟到赛果`
      : "";
    $("#ledger-settlement-note").textContent =
      `本次刷新新结算 ${Number(data.settledNow || 0)} 条单场、${Number(data.parlaySettledNow || 0)} 组串关${backfilledText}；只匹配快照之后新增的历史行。`;
  } else if (backfilledTotal) {
    $("#ledger-settlement-note").textContent =
      `本次刷新补齐 ${backfilledTotal} 组已结算串关的迟到赛果。`;
  } else {
    $("#ledger-settlement-note").textContent =
      "未发现新赛果；只用快照之后新增的历史行结算。";
  }
  renderParlayLedger(data.parlays);
  renderLedgerRows(data.rows || []);
  populateLedgerLeagues(data.filters?.leagues || []);
  const singleFiltered = data.filtered || {};
  const drilldown = state.ledgerDrilldown;
  $("#ledger-single-summary").innerHTML = `
    ${drilldown ? `<button id="ledger-drilldown-clear" class="ledger-drilldown-chip" type="button" title="清除矩阵筛选">${escapeHtml(ledgerMarketNames[drilldown.market])} · 预测${escapeHtml(confusionLabel(drilldown.market, drilldown.predicted))} → 实际${escapeHtml(confusionLabel(drilldown.market, drilldown.actual))}<b aria-hidden="true">×</b></button>` : ""}
    <span><strong>${Number(singleFiltered.fixtures || 0).toLocaleString()}</strong> 场</span>
    <span>命中率 <strong>${ledgerMetric(singleFiltered.accuracy)}</strong></span>
    <span>盈亏 <strong>${singleFiltered.settled ? ledgerProfit(singleFiltered.simulatedProfit) : "—"}</strong></span>`;
  $("#ledger-drilldown-clear")?.addEventListener("click", () => {
    state.ledgerDrilldown = null;
    reloadLedgerSection("single");
  });
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
    const endpoint = settle ? "/api/ledger/settle" : "/api/ledger";
    const data = await fetchJson(`${endpoint}?${ledgerRequestParams()}`, {
      method: settle ? "POST" : "GET",
    });
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

function matchReliabilitySummary(matchId) {
  return state.matchReliability.get(String(matchId)) || null;
}

function isRecommendedMarket(summary, market) {
  return summary?.[market]?.level === "recommended";
}

function matchGoalMultipleRelations(match) {
  return goalMultipleRelationsForMarket(match?.goals);
}

function matchGoalEqualities(match) {
  return goalOddsEqualitiesForMarket(match?.goals);
}

function matchesReliabilityFilter(match, filter) {
  if (filter === "all") return true;
  if (filter === "movement") {
    return matchHasOddsMovement(match);
  }
  if (filter === "multiple") {
    return matchGoalMultipleRelations(match).length > 0;
  }
  if (filter === "equal") {
    return matchGoalEqualities(match).length > 0;
  }
  const summary = matchReliabilitySummary(match.id);
  const spfRecommended = isRecommendedMarket(summary, "spf");
  const hhadRecommended = isRecommendedMarket(summary, "hhad");
  if (filter === "spf") return spfRecommended;
  if (filter === "hhad") return hhadRecommended;
  return spfRecommended || hhadRecommended;
}

function matchReliabilityBadges(match) {
  const summary = matchReliabilitySummary(match.id);
  const badges = [];
  if (!summary) {
    const label = state.matchReliabilityError
      ? "评估暂不可用"
      : state.matchReliabilityLoaded
        ? "暂无稳定项"
        : "评估中";
    badges.push(`<em class="match-reliability-badge">${label}</em>`);
  } else {
    if (isRecommendedMarket(summary, "spf")) {
      badges.push('<em class="match-reliability-badge recommended">胜平负 · 稳定</em>');
    }
    if (isRecommendedMarket(summary, "hhad")) {
      badges.push('<em class="match-reliability-badge recommended">让球 · 稳定</em>');
    }
    if (!badges.length) {
      badges.push('<em class="match-reliability-badge">暂无稳定项</em>');
    }
  }
  const relations = matchGoalMultipleRelations(match);
  if (relations.length) {
    const multiples = [...new Set(relations.map((relation) => `×${relation.multiple}`))];
    badges.push(
      `<em class="match-reliability-badge multiple">倍数 · ${escapeHtml(multiples.join(" / "))}</em>`,
    );
  }
  const equalities = matchGoalEqualities(match);
  if (equalities.length) {
    badges.push(
      `<em class="match-reliability-badge equal">同赔 · ${escapeHtml(equalities.map((item) => item.label).join(" / "))}</em>`,
    );
  }
  if (matchHasOddsMovement(match)) {
    badges.push('<em class="match-reliability-badge movement">变盘</em>');
  }
  return `<div class="match-reliability-badges">${badges.join("")}</div>`;
}

function matchQuickPicksHtml(match) {
  const summary = matchReliabilitySummary(match.id);
  if (!summary) return "";
  const picks = [];
  const spfRec = isRecommendedMarket(summary, "spf");
  const hhadRec = isRecommendedMarket(summary, "hhad");

  if (hhadRec && summary.hhadPick && !spfRec) {
    picks.push(
      `<span class="match-quick-pick hhad highlight">历史↑ ${escapeHtml(summary.hhadPick)}</span>`,
    );
  } else if (summary.hadPick) {
    picks.push(
      `<span class="match-quick-pick spf ${spfRec ? "highlight" : ""}">历史↑ ${escapeHtml(summary.hadPick)}</span>`,
    );
  } else if (summary.hhadPick) {
    picks.push(
      `<span class="match-quick-pick hhad ${hhadRec ? "highlight" : ""}">历史↑ ${escapeHtml(summary.hhadPick)}</span>`,
    );
  }
  if (summary.goalsPick) {
    picks.push(
      `<span class="match-quick-pick goals">⚽ ${escapeHtml(summary.goalsPick)}</span>`,
    );
  }
  if (!picks.length) return "";
  return `<div class="match-quick-picks">${picks.join("")}</div>`;
}

function updateMatchFilterControls() {
  const allMatches = state.matches || [];
  const search = ($("#match-search")?.value || "").trim().toLowerCase();
  const searchFiltered = allMatches.filter((match) =>
    `${match.displayName} ${match.league}`.toLowerCase().includes(search),
  );

  $$("[data-match-filter]").forEach((button) => {
    const filterKey = button.dataset.matchFilter;
    const active = filterKey === state.matchReliabilityFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");

    const count = searchFiltered.filter((match) =>
      matchesReliabilityFilter(match, filterKey),
    ).length;

    const countEl = button.querySelector(".filter-count");
    if (countEl) {
      countEl.textContent = count;
    }

    const needsReliability = ["recommended", "spf", "hhad"].includes(
      filterKey,
    );
    button.disabled =
      needsReliability &&
      (!state.matchReliabilityLoaded || state.matchReliabilityLoading) &&
      filterKey !== "all";
  });
}

function renderMatchList(query = $("#match-search")?.value || "") {
  const normalized = query.trim().toLowerCase();
  const matches = state.matches
    .filter((match) =>
      `${match.displayName} ${match.league}`.toLowerCase().includes(normalized),
    )
    .filter((match) => matchesReliabilityFilter(match, state.matchReliabilityFilter));
  updateMatchFilterControls();
  $("#match-list").innerHTML = matches.length
    ? matches
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
            ${matchQuickPicksHtml(match)}
            ${hasSpf ? "" : '<em class="market-status">普通胜平负未开售</em>'}
            ${matchReliabilityBadges(match)}
          </span>
        </button>`;
    })
    .join("")
    : `<p class="match-list-empty">${
        state.matchReliabilityFilter === "all"
          ? "没有找到符合搜索条件的比赛。"
          : state.matchReliabilityFilter === "multiple"
            ? "当前没有0球赔率存在整数倍关系的比赛。"
            : state.matchReliabilityFilter === "equal"
              ? "当前没有总进球赔率存在同赔关系的比赛。"
            : "当前条件下没有历史方向足够稳定的比赛。"
      }</p>`;

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

function matchReliabilityUrl() {
  const params = new URLSearchParams({
    spfTolerance: Number($("#spf-tolerance").value) / 100,
    hhadTolerance: Number($("#hhad-tolerance").value) / 100,
    goalTolerance: Number($("#goal-tolerance").value) / 1000,
    sameLeague: $("#parlay-scope").value === "same",
    limit: 1,
  });
  return `/api/parlay?${params}`;
}

function updateSelectedMatchReliability(payload) {
  if (!payload?.match?.id) return;
  const existing = state.matchReliability.get(String(payload.match.id)) || {};
  const spfPredicted = payload.spf?.predicted;
  const spfOddsVal = outcomeOdds(payload.match.had, spfPredicted);
  const spfPick = spfPredicted && spfOddsVal
    ? `${outcomeFullName(spfPredicted, false)} @${spfOddsVal.toFixed(2)}`
    : null;

  const hhadPredicted = payload.hhad?.predicted;
  const hhadOddsVal = outcomeOdds(payload.match.hhad, hhadPredicted);
  const hhadPick = hhadPredicted && hhadOddsVal
    ? `${outcomeFullName(hhadPredicted, true)} @${hhadOddsVal.toFixed(2)}`
    : null;

  const goalsPick = payload.goals?.goalPair?.labels?.length
    ? `${payload.goals.goalPair.labels.join("/")}球`
    : payload.goals?.predicted
      ? `${payload.goals.predicted}球`
      : null;

  state.matchReliability.set(String(payload.match.id), {
    ...existing,
    spf: payload.spf?.reliability || existing.spf || null,
    hhad: payload.hhad?.reliability || existing.hhad || null,
    hadPick: spfPick || existing.hadPick || null,
    hhadPick: hhadPick || existing.hhadPick || null,
    goalsPick: goalsPick || existing.goalsPick || null,
  });
}

async function loadMatchReliability() {
  state.matchReliabilityController?.abort();
  const controller = new AbortController();
  state.matchReliabilityController = controller;
  state.matchReliabilityLoading = true;
  state.matchReliabilityError = null;
  $("#match-list").setAttribute("aria-busy", "true");
  updateMatchFilterControls();
  try {
    const payload = await fetchJson(matchReliabilityUrl(), {
      signal: controller.signal,
    });
    state.matchReliability = new Map(
      (payload.candidates || []).map((candidate) => [
        String(candidate.id),
        {
          spf: candidate.markets?.had?.reliability || null,
          hhad: candidate.markets?.hhad?.reliability || null,
          hadPick:
            candidate.markets?.had?.predicted &&
            Number.isFinite(Number(candidate.markets?.had?.odds))
              ? `${outcomeFullName(candidate.markets.had.predicted, false)} @${Number(candidate.markets.had.odds).toFixed(2)}`
              : null,
          hhadPick:
            candidate.markets?.hhad?.predicted &&
            Number.isFinite(Number(candidate.markets?.hhad?.odds))
              ? `${outcomeFullName(candidate.markets.hhad.predicted, true)} @${Number(candidate.markets.hhad.odds).toFixed(2)}`
              : null,
          goalsPick: candidate.markets?.goalsPair?.labels
            ? `${candidate.markets.goalsPair.labels.join("/")}球`
            : null,
        },
      ]),
    );
    state.matchReliabilityLoaded = true;
    renderMatchList();
  } catch (error) {
    if (error.name !== "AbortError") {
      state.matchReliabilityLoaded = false;
      state.matchReliabilityError = error.message;
      renderMatchList();
    }
  } finally {
    if (state.matchReliabilityController === controller) {
      state.matchReliabilityLoading = false;
      $("#match-list").setAttribute("aria-busy", "false");
      updateMatchFilterControls();
    }
  }
}

function predictionUrl({ snapshot = false } = {}) {
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
  const route = snapshot ? "/api/predict/snapshot" : "/api/predict";
  return `${route}?${params}`;
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
    state.smoothingConfig?.stale,
  );
  const offlineChallengerStale = Boolean(state.challengerConfig?.stale);
  const requested = {
    spf: Number($("#spf-tolerance").value),
    hhad: Number($("#hhad-tolerance").value),
    goals: Number($("#goal-tolerance").value),
  };
  const effective = state.data?.settings?.effectiveThresholds;
  const availableMarkets = {
    spf: Boolean(state.data?.match?.had),
    hhad: Boolean(state.data?.match?.hhad),
    goals: Boolean(state.data?.match?.goals),
  };
  const current = effective
    ? {
        spf: availableMarkets.spf ? Number(effective.spf) * 100 : null,
        hhad: availableMarkets.hhad ? Number(effective.hhad) * 100 : null,
        goals: availableMarkets.goals ? Number(effective.goals) * 1000 : null,
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
    $("#goal-tolerance-label").textContent =
      `0球±${Number(zeroOddsScope.tolerance).toFixed(2)}`;
  }
  const scopeLabel = zeroOddsApplied
    ? "本场0球赔率近邻采用"
    : segmentedApplied
    ? "本场赔率类型采用"
    : adaptiveApplied
      ? "本场动态采用"
      : "当前使用";
  const goalScopeText = !availableMarkets.goals
    ? "未开售"
    : zeroOddsApplied
    ? `0球${zeroOddsScope.intervalLabel || "固定近邻"} · 综合距离加权 · 全部${Number(zeroOddsScope.samples || 0).toLocaleString()}场`
    : `${compactNumber(current.goals / 10)}pp`;
  const spfScopeText = availableMarkets.spf
    ? `±${compactNumber(current.spf)}%`
    : "未开售";
  const hhadScopeText = availableMarkets.hhad
    ? `±${compactNumber(current.hhad)}%`
    : "未开售";
  $("#control-scope-summary").textContent =
    `${scopeLabel}：${sameLeague ? "只匹配同联赛" : "全部联赛"} · 胜平负 ${spfScopeText} · 让球 ${hhadScopeText} · 进球 ${goalScopeText}`;
  $("#model-config-status").textContent = deviations.length
    ? `${deviations.join("、")}使用自定义阈值`
    : thresholdStale
      ? state.modelConfig?.productionLocked
        ? "正式阈值已锁定 · 离线候选报告待更新（不影响预测）"
        : "数据库已更新 · 三项阈值待重新验证"
      : `最新回测：${thresholdValidationStatus({ excludeGoals: zeroOddsApplied })}`;
  if (state.adaptiveConfig) {
    const adaptiveCandidatePassed = Object.values(
      state.adaptiveConfig.markets || {},
    ).some((market) => market?.enabled);
    const adaptiveEnabled = Boolean(
      state.adaptiveConfig.runtimeEnabled && adaptiveCandidatePassed,
    );
    $("#model-config-status").textContent += state.adaptiveConfig.stale
      ? " · 动态范围待验证"
      : adaptiveEnabled
        ? " · 动态范围已启用"
        : adaptiveCandidatePassed && state.adaptiveConfig.candidateOnly
          ? " · 动态范围候选通过（未上线）"
        : " · 动态范围未胜出";
  }
  if (state.goalZeroConfig) {
    $("#model-config-status").textContent += state.goalZeroConfig.stale
      ? " · 历史数据更新后需复核进球规则"
      : state.goalZeroConfig.enabled
        ? " · 进球固定近邻已启用（区间报告不参与预测）"
        : " · 进球近邻规则未启用";
  }
  if (advancedStale) {
    $("#model-config-status").textContent +=
      " · 高级修正待重新验证并已停用";
  }
  if (offlineChallengerStale) {
    $("#model-config-status").textContent +=
      " · 离线挑战模型待重训（不影响正式预测）";
  }
}

function updateToleranceLabels() {
  $("#spf-tolerance-label").textContent = `${$("#spf-tolerance").value}%`;
  $("#hhad-tolerance-label").textContent = `${$("#hhad-tolerance").value}%`;
  $("#goal-tolerance-label").textContent =
    `0球±${$("#same-league").checked ? "2.50" : "2.00"}`;
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
    "全部±2.00 / 同联赛±2.50";
  updateToleranceLabels();
}

async function loadPrediction({ quiet = false } = {}) {
  if (!state.selectedId) return;
  state.requestController?.abort();
  state.requestController = new AbortController();
  if (!quiet) setLoading(true);
  try {
    const payload = await fetchJson(predictionUrl({ snapshot: true }), {
      method: "POST",
      signal: state.requestController.signal,
    });
    state.data = payload;
    updateSelectedMatchReliability(payload);
    renderMatchList();
    renderDashboard();
    setLoading(false);
  } catch (error) {
    if (error.name !== "AbortError") showError(error);
  }
}

function extractTopScores(data) {
  if (data?.topScores && data.topScores.length) {
    return {
      topScores: data.topScores,
      topScoresSuggest: data.topScoresSuggest || "",
    };
  }
  const rows =
    data?.similarGoals?.rows ||
    [];
  const counts = new Map();
  let total = 0;
  for (const row of rows) {
    if (!row.score) continue;
    const norm = String(row.score).replace(":", "-").trim();
    if (!/^\d+-\d+$/.test(norm)) continue;
    counts.set(norm, (counts.get(norm) || 0) + 1);
    total++;
  }
  if (!total) return { topScores: [], topScoresSuggest: "" };
  const list = [];
  for (const [score, count] of counts.entries()) {
    list.push({ score, count, probability: count / total });
  }
  list.sort((a, b) => b.probability - a.probability);
  const top = list.slice(0, 4);
  const suggest = top.length
    ? `历史出现较多 ${top[0].score}${top[1] ? ` · 其次 ${top[1].score}` : ""}`
    : "";
  return { topScores: top, topScoresSuggest: suggest };
}

function renderDashboard() {
  const {
    match,
    spf,
    hhad,
    goals,
    goalMultiple,
    goalEquality,
    stability,
    method,
    dataStats,
  } = state.data;
  updateModelConfigStatus();
  const primary = spf;
  const primaryMarket = "spf";
  const primaryOdds = match.had;
  const primaryAvailable = Boolean(spf && spf.available !== false);
  const goalsAvailable = Boolean(goals && goals.available !== false);
  const primaryLabels = ["主胜", "平局", "客胜"];
  $(".spf-decision").hidden = !spf;
  $("#league-badge").textContent = match.league;
  $("#match-id").textContent = `MATCH ${match.id}`;
  $("#home-team").textContent = match.home;
  $("#away-team").textContent = match.away;
  $("#primary-market-label").textContent = "相似历史分布";
  $("#prediction-label").textContent = predictionText(spf, "");
  $(".spf-decision").classList.toggle("tie", Boolean(spf?.isTie));
  $("#confidence-label").textContent = primaryAvailable
    ? `样本置信度：${spf.confidence}`
    : "普通胜平负未开售";
  $("#spf-hero-sample").textContent =
    spf?.weighting?.enabled
      ? `相似 ${spf.stats.total.toLocaleString()} · 加权等效 ${effectiveSamples(spf).toFixed(1)}`
      : spf
        ? `相似样本 ${spf.stats.total.toLocaleString()} 场 · 等权`
        : "无可用胜平负赔率";
  const leadingIndex = primaryAvailable && primary?.final
    ? primary.final.indexOf(Math.max(...primary.final))
    : -1;
  ["win", "draw", "loss"].forEach((key, index) => {
    $(`#prob-label-${key}`).textContent = primaryLabels[index];
    const probVal = primaryAvailable && primary?.final ? Number(primary.final[index]) : 0;
    $(`#prob-${key}`).textContent = primaryAvailable
      ? pct(probVal)
      : "—";
    const bar = $(`#prob-bar-${key}`);
    if (bar) {
      bar.style.width = primaryAvailable ? `${Math.min(100, Math.max(0, probVal * 100))}%` : "0%";
    }
    const prevMarker = $(`#prob-prev-${key}`);
    const prevMatch = state.previousSpfMatch;
    if (prevMarker) {
      if (
        prevMatch &&
        prevMatch.matchId !== match.id &&
        Array.isArray(prevMatch.final) &&
        prevMatch.final.length === 3 &&
        primaryAvailable
      ) {
        const prevVal = Number(prevMatch.final[index]);
        if (Number.isFinite(prevVal) && prevVal >= 0 && prevVal <= 1) {
          prevMarker.hidden = false;
          prevMarker.style.left = `${Math.min(100, Math.max(0, prevVal * 100))}%`;
          const diffPct = (probVal - prevVal) * 100;
          const diffSign = diffPct > 0 ? "+" : "";
          prevMarker.title = `上场参考 (${prevMatch.home} vs ${prevMatch.away}): ${primaryLabels[index]} ${(prevVal * 100).toFixed(1)}% (本场较上场 ${diffSign}${diffPct.toFixed(1)}%)`;
        } else {
          prevMarker.hidden = true;
        }
      } else {
        prevMarker.hidden = true;
      }
    }
    const cell = $(`#prob-label-${key}`)?.closest(".win, .draw, .loss");
    if (cell) {
      const isLead = index === leadingIndex && primaryAvailable;
      cell.classList.toggle("leading", isLead);
      let crown = cell.querySelector(".leading-crown");
      if (isLead) {
        if (!crown) {
          crown = document.createElement("span");
          crown.className = "leading-crown";
          cell.appendChild(crown);
        }
        crown.textContent =
          primary?.reliability?.level === "recommended" ? "★ 历史稳定" : "★ 历史最高";
      } else if (crown) {
        crown.remove();
      }
    }
  });

  const initialPrimaryOdds = match.had?.history?.initial;
  const winFmt = formatOddsWithMovement(primaryOdds?.h, initialPrimaryOdds?.h);
  const drawFmt = formatOddsWithMovement(primaryOdds?.d, initialPrimaryOdds?.d);
  const lossFmt = formatOddsWithMovement(primaryOdds?.a, initialPrimaryOdds?.a);

  $("#odds-win").innerHTML = winFmt.html;
  $("#odds-draw").innerHTML = drawFmt.html;
  $("#odds-loss").innerHTML = lossFmt.html;

  const spfDouble = calculateDoubleChance(primary, primaryOdds, primaryMarket === "hhad");
  const spfDoubleEl = $("#spf-double-chance");
  if (spfDoubleEl) {
    if (
      spfDouble &&
      primaryAvailable &&
      primary?.reliability?.level === "recommended"
    ) {
      spfDoubleEl.hidden = false;
      $("#spf-double-chance-picks").textContent = spfDouble.pairLabel;
      $("#spf-double-chance-cover").textContent = `覆盖率 ${pct(spfDouble.combinedCover)}`;
      $("#spf-double-chance-odds").textContent = spfDouble.combinedOdds
        ? `分配后等效返还 ${spfDouble.combinedOdds.toFixed(2)} (${spfDouble.o1.toFixed(2)} / ${spfDouble.o2.toFixed(2)})`
        : "仅作概率前两项观察";
    } else {
      spfDoubleEl.hidden = true;
    }
  }

  $("#expected-goals").textContent = Number.isFinite(goals?.expected)
    ? goals.expected.toFixed(2)
    : "—";
  $("#top-goals").textContent = goalsAvailable
    ? `历史最高 ${goals.predicted} 球`
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

  const signals = buildMarketSignals(match, spf, hhad);
  const signalsContainer = $("#match-market-signals");
  if (signalsContainer) {
    signalsContainer.innerHTML = `
      <div class="market-signal-notice">研究观察 · 未经时间滚动验证 · 不改变当前历史分布结论</div>
      ${signals
        .map(
          (sig) => `
      <div class="market-signal-pill ${sig.type}">
        <strong class="signal-tag">${escapeHtml(sig.tag)}</strong>
        <span class="signal-desc">${escapeHtml(sig.desc)}</span>
      </div>`,
        )
        .join("")}`;
  }

  const { topScores, topScoresSuggest } = extractTopScores(state.data);
  const topScoresBox = $("#top-scores-box");
  const targetGoalLabels = goalPair?.available
    ? goalPair.labels.map(String)
    : (goals?.predicted ? [String(goals.predicted)] : []);

  if (topScoresBox) {
    topScoresBox.hidden = !topScores.length;
    $("#top-scores-suggest").textContent =
      topScoresSuggest || "基于相似历史样本统计";

    const validated = crossValidateScoreAndGoals(topScores, targetGoalLabels);
    $("#top-scores-chips").innerHTML = validated.chips
      .map(
        (item) => `
        <span class="score-chip">
          <strong class="score-num">${escapeHtml(item.score)}</strong>
          <small class="score-pct">${pct(item.probability, 1)}</small>
          ${item.isGoalMatch ? `<span class="score-goal-match" title="与总进球历史高频档吻合">⚽ ${item.sumGoals}球✓</span>` : ""}
        </span>`,
      )
      .join("");

    const validationEl = $("#top-scores-validation");
    if (validationEl) {
      if (validated.status === "verified") {
        validationEl.hidden = false;
        validationEl.className = "cross-validation-badge verified";
        validationEl.textContent = "两项与进球档位一致";
      } else if (validated.status === "partial") {
        validationEl.hidden = false;
        validationEl.className = "cross-validation-badge partial";
        validationEl.textContent = "一项与进球档位一致";
      } else {
        validationEl.hidden = true;
      }
    }
  }

  let verdictSpf = "未开售";
  if (spf && spf.available !== false && spf.predicted) {
    const spfName = outcomeFullName(spf.predicted, false);
    const oddVal = outcomeOdds(match.had, spf.predicted);
    const initOddVal = outcomeOdds(match.had?.history?.initial, spf.predicted);
    const oddFmt = formatOddsWithMovement(oddVal, initOddVal);
    const arrow = oddFmt.badgeText ? ` ${oddFmt.badgeText}` : "";
    const probVal = spf.final ? pct(Math.max(...spf.final)) : "";
    const rec = spf.reliability?.level === "recommended" ? "历史稳定 · " : "";
    verdictSpf = oddVal
      ? `${rec}${spfName} @${oddVal.toFixed(2)}${arrow}${probVal ? ` (${probVal})` : ""}`
      : `${rec}${spfName}`;
  } else if (!match.had && hhad && hhad.available !== false) {
    verdictSpf = "转看让球";
  }

  let verdictHhad = "未开售";
  if (hhad && hhad.available !== false && hhad.predicted) {
    const hhadName = outcomeFullName(hhad.predicted, true);
    const lineStr = `${hhad.handicap > 0 ? "+" : ""}${hhad.handicap}`;
    const oddVal = outcomeOdds(match.hhad, hhad.predicted);
    const initOddVal = outcomeOdds(match.hhad?.history?.initial, hhad.predicted);
    const oddFmt = formatOddsWithMovement(oddVal, initOddVal);
    const arrow = oddFmt.badgeText ? ` ${oddFmt.badgeText}` : "";
    const rec = hhad.reliability?.level === "recommended" ? "历史稳定 · " : "";
    verdictHhad = oddVal
      ? `${rec}${hhadName}(${lineStr}) @${oddVal.toFixed(2)}${arrow}`
      : `${rec}${hhadName}(${lineStr})`;
  }

  let verdictGoals = "暂无";
  if (goals && goals.available !== false && goalPair?.available) {
    verdictGoals = `${goalPair.labels.join("/")}球 (${pct(goalPair.probability)})`;
  } else if (goals && goals.predicted) {
    verdictGoals = `历史最高 ${goals.predicted}球`;
  }

  let verdictScore = "暂无数据";
  if (topScores.length) {
    verdictScore = topScores.slice(0, 2).map((s) => s.score).join(" / ");
  }

  if ($("#verdict-spf")) $("#verdict-spf").textContent = verdictSpf;
  if ($("#verdict-hhad")) $("#verdict-hhad").textContent = verdictHhad;
  if ($("#verdict-goals")) $("#verdict-goals").textContent = verdictGoals;
  if ($("#verdict-score")) $("#verdict-score").textContent = verdictScore;

  const goalMultipleAvailable = Boolean(goalMultiple?.available);
  $("#goal-multiple-strip").hidden = !goalMultipleAvailable;
  if (goalMultipleAvailable) {
    const goalKeys = ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7plus"];
    const relationText = goalMultiple.relations
      .map((relation) => {
        const relatedOdds = Number(match.goals?.[goalKeys[relation.index]]);
        return `0球 ${Number(goalMultiple.zeroOdds).toFixed(2)} = ${relation.label}球 ${relatedOdds.toFixed(2)} ×${relation.multiple}`;
      })
      .join("；");
    const rankText = goalMultiple.labels
      .map(
        (label, index) =>
          `${label}球 ${Number(goalMultiple.counts[index] || 0).toLocaleString()}场（${pct(goalMultiple.probabilities[index] || 0)}）`,
      )
      .join(" · ");
    $("#goal-multiple-label").textContent =
      `${goalMultiple.labels.join(" / ")}球`;
    $("#goal-multiple-detail").textContent = `${relationText}；${rankText}`;
    $("#goal-multiple-coverage").textContent = pct(
      goalMultiple.coverageProbability,
    );
    $("#goal-multiple-meta").textContent =
      `0球终赔精确档共 ${Number(goalMultiple.samples || 0).toLocaleString()} 场 · 已自动进入独立待结算`;
  }
  const goalEqualityAvailable = Boolean(goalEquality?.available);
  $("#goal-equality-strip").hidden = !goalEqualityAvailable;
  if (goalEqualityAvailable) {
    $("#goal-equality-count").textContent =
      `${goalEquality.predictions.length}组`;
    $("#goal-equality-results").innerHTML = goalEquality.predictions
      .map((prediction) => {
        const rankText = prediction.labels
          .map(
            (label, index) =>
              `${label}球 ${Number(prediction.counts[index] || 0).toLocaleString()}场（${pct(prediction.probabilities[index] || 0)}）`,
          )
          .join(" · ");
        return `
          <article class="goal-equality-result">
            <div class="goal-equality-pair">
              <span>${escapeHtml(prediction.label)} · 同赔 ${Number(prediction.equalOdds).toFixed(2)}</span>
              <strong>${escapeHtml(prediction.labels.join(" / "))}球</strong>
            </div>
            <p class="goal-equality-distribution">${rankText} · 前两位覆盖 ${pct(prediction.coverageProbability)}</p>
            <p class="goal-equality-sample">
              <span>历史精确档</span>
              <strong>${Number(prediction.samples || 0).toLocaleString()} 场</strong>
            </p>
          </article>`;
      })
      .join("");
  }
  $("#spf-sample-chip").textContent = sampleText(primary);
  $("#goal-sample-chip").textContent = sampleText(goals);
  const deepResearchBadge = $("#deep-research-badge");
  if (deepResearchBadge) {
    const primarySamples = primary?.stats?.total || 0;
    deepResearchBadge.textContent = primarySamples > 0
      ? `查看历史明细 (${primarySamples.toLocaleString()} 场) ▾`
      : "点击展开图表与明细 ▾";
  }
  $("#control-spf-samples").textContent = ledgerSampleText(spf);
  $("#control-hhad-samples").textContent = hhad
    ? ledgerSampleText(hhad)
    : "未开售";
  $("#control-goal-samples").textContent = ledgerSampleText(goals);
  $("#method-note").textContent = [method.spf, method.hhad, method.goals]
    .filter(Boolean)
    .join("；");
  const chartMarket = spf ? "spf" : hhad ? "hhad" : null;
  const chartPrediction = spf || hhad;
  $("#prediction-method-legend").textContent = smoothingLabel(chartPrediction);
  $("#probability-panel-title").textContent =
    chartMarket === "hhad"
      ? "让球胜平负：市场基准与相似历史差值"
      : "胜平负：市场基准与相似历史差值";
  $("#history-stats").textContent =
    `统一已校验 ${dataStats.verifiedHistory.toLocaleString()} / 全部统一比赛 ${dataStats.unifiedHistory.toLocaleString()}`;
  $("#spf-tolerance").disabled = !spf;
  syncHistoryTabs({ spf: Boolean(spf), hhad: Boolean(hhad), goals: Boolean(goals) });

  renderHhad(hhad, match.hhad);
  renderMarketComparisons(spf, hhad, goals);
  renderDecisionReliability(spf, hhad, goals);
  renderReliability(spf, hhad, goals);
  renderStability(stability);
  renderProbabilityBars(chartPrediction, chartMarket);
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
  if (primaryAvailable && Array.isArray(spf?.final)) {
    state.previousSpfMatch = {
      matchId: match.id,
      home: match.home,
      away: match.away,
      final: [...spf.final],
    };
  }
}

function renderDecisionReliability(primary, hhad, goals) {
  [
    ["spf", primary],
    ["hhad", hhad],
    ["goal", goals],
  ].forEach(([key, prediction]) => {
    const display = reliabilityDisplay(prediction);
    const badge = $(`#${key}-decision-reliability`);
    const reason = $(`#${key}-decision-reason`);
    badge.textContent = display.label;
    badge.className = `decision-reliability-badge ${display.level}`;
    badge.setAttribute("aria-label", `可靠性：${display.label}`);
    reason.textContent = display.reason;
    reason.title = display.reason;
  });
}

function reliabilityCard(title, prediction, { suppressStaleReason = false } = {}) {
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
    state.challengerConfig?.selection?.data?.verifiedMatches ||
      state.challengerConfig?.data?.verifiedMatches ||
      0,
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
  const statusText = reliabilityDisplay(prediction).label;
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
      ${suppressStaleReason && stale ? "" : `<p class="reliability-plain-reason">${escapeHtml(plainReason)}</p>`}
      <details class="reliability-details">
        <summary>查看验证详情</summary>
        <p>以下是筛选规则的历史验证，不是本场比赛的预测概率。</p>
        <div class="reliability-detail-grid">
          ${oldMetrics}
          <div><span>赔率隐含领先</span><strong>${pct(observed.marketMargin || 0, 1)}</strong></div>
          <div><span>当前范围历史占比</span><strong>${pct(observed.historicalSupportProbability || 0, 1)}</strong></div>
          <div><span>四档历史支持</span><strong>${Number(observed.historicalSupportCount || 0)}/${Number(observed.historicalSupportTotal || 0)} 档</strong></div>
        </div>
      </details>
    </article>`;
}

function renderReliability(spf, hhad, goals) {
  const predictions = [spf, hhad, goals];
  const hasStaleReliability = predictions.some((prediction) =>
    String(prediction?.reliability?.reason || "").includes("历史数据已更新"),
  );
  const globalNote = $("#reliability-global-note");
  globalNote.hidden = !hasStaleReliability;
  if (hasStaleReliability) {
    const oldVerified = Number(
      state.challengerConfig?.selection?.data?.verifiedMatches ||
        state.challengerConfig?.data?.verifiedMatches ||
        0,
    );
    const currentVerified = Number(
      state.data?.dataStats?.verifiedHistory || 0,
    );
    const addedMatches = Math.max(0, currentVerified - oldVerified);
    globalNote.textContent = addedMatches
      ? `统一提示：历史库比上次可靠性训练新增了 ${addedMatches} 场比赛；基础相似范围已经重新验证并继续使用，但“重点参考 / 谨慎 / 跳过”的筛选等级尚未重训，因此统一降级。`
      : "统一提示：基础相似范围已经重新验证并继续使用，但“重点参考 / 谨慎 / 跳过”的筛选等级尚未重训，因此统一降级。";
  }
  $("#reliability-cards").innerHTML = [
    reliabilityCard("胜平负", spf, { suppressStaleReason: hasStaleReliability }),
    reliabilityCard("让球胜平负", hhad, { suppressStaleReason: hasStaleReliability }),
    reliabilityCard("总进球", goals, { suppressStaleReason: hasStaleReliability }),
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

function historicalPredictionText(point, market) {
  if (!point.available) return "无样本";
  const labels = point.historicalTopLabels?.length
    ? point.historicalTopLabels
    : [point.historicalPredicted].filter(Boolean);
  if (!labels.length) return "历史方向不明确";
  const formatted = labels.map((label) =>
    market === "hhad"
      ? `让${label}`
      : market === "goals"
        ? `${label}球`
        : label,
  );
  return `历史 ${formatted.join(" / ")}${point.historicalIsTie ? "并列" : ""}`;
}

function stabilityThresholdText(value, market, analysis) {
  if (market === "goals" && analysis?.mode === "composite-distance-pool") {
    return value === 1 ? "全部近邻" : `最近${Math.round(value * 100)}%`;
  }
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
  const currentDirection =
    analysis.direction ||
    analysis.points.find((point) => point.predicted)?.predicted;
  const currentDirectionText = stabilityPredictionText(
    {
      available: Boolean(currentDirection),
      predicted: currentDirection,
      topLabels: [currentDirection].filter(Boolean),
      isTie: false,
    },
    market,
  );
  const statusText =
    analysis.status === "supported"
      ? `历史全部支持 · ${currentDirectionText}`
      : analysis.status === "mixed"
        ? `历史部分支持 · ${analysis.supportCount}/${analysis.totalPoints}`
        : analysis.status === "opposed"
          ? "不同相似范围方向不一致"
          : "样本不足或历史并列";
  const statusClass =
    analysis.status === "supported"
      ? "stable"
      : analysis.status === "insufficient"
        ? "insufficient"
        : "unstable";
  const points = analysis.points
    .map((point) => {
      const selected =
        Math.abs(point.threshold - analysis.selectedThreshold) < 1e-9
          ? "selected"
          : "";
      return `
        <li class="${selected}">
          <span>${stabilityThresholdText(point.threshold, market, analysis)}</span>
          <strong>${escapeHtml(historicalPredictionText(point, market))}</strong>
          <small>${point.samples.toLocaleString()} 场${point.available ? ` · 当前历史方向占比 ${pct(point.supportProbability || 0)}` : ""}</small>
        </li>`;
    })
    .join("");
  return `
    <article class="stability-card ${statusClass}">
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
  $(".hhad-decision-lead").classList.toggle("tie", Boolean(hhad.isTie));
  $("#hhad-confidence-label").textContent = available
    ? `样本置信度：${hhad.confidence}`
    : "无法生成历史预测";
  const hhadLeadingIndex = available && hhad?.final
    ? hhad.final.indexOf(Math.max(...hhad.final))
    : -1;
  ["win", "draw", "loss"].forEach((key, index) => {
    const probVal = available && hhad?.final ? Number(hhad.final[index]) : 0;
    $(`#hhad-prob-${key}`).textContent = available ? pct(probVal) : "—";
    const bar = $(`#hhad-prob-bar-${key}`);
    if (bar) {
      bar.style.width = available ? `${Math.min(100, Math.max(0, probVal * 100))}%` : "0%";
    }
    const cell = $(`#hhad-prob-${key}`)?.closest(".win, .draw, .loss");
    if (cell) {
      const isLead = index === hhadLeadingIndex && available;
      cell.classList.toggle("leading", isLead);
      let crown = cell.querySelector(".leading-crown");
      if (isLead) {
        if (!crown) {
          crown = document.createElement("span");
          crown.className = "leading-crown";
          cell.appendChild(crown);
        }
        crown.textContent =
          hhad?.reliability?.level === "recommended" ? "★ 历史稳定" : "★ 历史最高";
      } else if (crown) {
        crown.remove();
      }
    }
  });

  const hhadDouble = calculateDoubleChance(hhad, market, true);
  const hhadDoubleEl = $("#hhad-double-chance");
  if (hhadDoubleEl) {
    if (
      hhadDouble &&
      available &&
      hhad?.reliability?.level === "recommended"
    ) {
      hhadDoubleEl.hidden = false;
      $("#hhad-double-chance-picks").textContent = hhadDouble.pairLabel;
      $("#hhad-double-chance-cover").textContent = `覆盖率 ${pct(hhadDouble.combinedCover)}`;
      $("#hhad-double-chance-odds").textContent = hhadDouble.combinedOdds
        ? `分配后等效返还 ${hhadDouble.combinedOdds.toFixed(2)} (${hhadDouble.o1.toFixed(2)} / ${hhadDouble.o2.toFixed(2)})`
        : "仅作概率前两项观察";
    } else {
      hhadDoubleEl.hidden = true;
    }
  }

  const initialHhadOdds =
    hhad?.history?.initial ||
    market?.history?.initial ||
    (Array.isArray(hhad?.initialOdds)
      ? { h: hhad.initialOdds[0], d: hhad.initialOdds[1], a: hhad.initialOdds[2] }
      : null);
  const hhadWinFmt = formatOddsWithMovement(market?.h, initialHhadOdds?.h);
  const hhadDrawFmt = formatOddsWithMovement(market?.d, initialHhadOdds?.d);
  const hhadLossFmt = formatOddsWithMovement(market?.a, initialHhadOdds?.a);

  $("#hhad-odds-win").innerHTML = hhadWinFmt.html;
  $("#hhad-odds-draw").innerHTML = hhadDrawFmt.html;
  $("#hhad-odds-loss").innerHTML = hhadLossFmt.html;
  $("#hhad-sample-count").textContent = `${hhad.stats.total.toLocaleString()} 场`;
  const matchingLabel = hhad.matchingLabel || "让球单盘口匹配";
  $("#hhad-weighting-note").textContent =
    hhad.weighting.enabled
      ? `${matchingLabel} · 核心 ${hhad.weighting.coreSamples.toLocaleString()} · 加权等效 ${effectiveSamples(hhad).toFixed(1)}`
      : `${matchingLabel} · 等权统计`;
  $("#hhad-movement-note").textContent = hhad.probabilityModel?.enabled
    ? `已验证融合 · 赔率 ${pct(hhad.probabilityModel.marketWeight)} / 历史 ${pct(hhad.probabilityModel.historyWeight)}`
    : hhad.movement?.referenceOnly
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
  const final = finalProbabilities(prediction);
  const prefix = market === "hhad" ? "让" : "";
  const comparisonByLabel = new Map(
    (prediction.marketComparison?.outcomes || []).map((outcome) => [
      String(outcome.label),
      outcome,
    ]),
  );
  const rows = prediction.labels
    .map(
      (label, index) => {
        const comparison = comparisonByLabel.get(String(label));
        return `
      <div class="prob-row">
        <strong>${prefix}${label}</strong>
        <div class="bar-stack" aria-label="${prefix}${label}三层概率">
          <div class="bar-track"><div class="bar-fill market" style="width:${prediction.market[index] * 100}%"></div></div>
          <div class="bar-track"><div class="bar-fill history" style="width:${prediction.empirical[index] * 100}%"></div></div>
          <div class="bar-track"><div class="bar-fill model" style="width:${final[index] * 100}%"></div></div>
        </div>
        <span class="prob-row-values">
          <b>${prediction.available === false ? "—" : pct(final[index])}</b>
          <small>${comparison ? signedPp(comparison.probabilityDelta) : "—"}</small>
        </span>
      </div>`;
      },
    )
    .join("");
  $("#probability-bars").innerHTML = `
    <section class="market-comparison-deep ${prediction.marketComparison?.status === "historical-divergence" ? "divergent" : ""}">
      ${marketComparisonMarkup(prediction, market, { detailed: true })}
    </section>
    ${rows}`;
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
        <p>最终概率直接采用当前范围的相似历史赛果占比；该玩法未配置额外平滑。</p>
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
      goals?.labels?.map((label) => `${label}球`) || GOAL_DISPLAY_LABELS,
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
      goals?.labels?.map((label) => `${label}球`) || GOAL_DISPLAY_LABELS,
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
      goals?.labels?.map((label) => `${label}球`) || GOAL_DISPLAY_LABELS,
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
  const final = finalProbabilities(prediction);
  $(legendSelector).innerHTML = config
    .map(
      ([key, label, color], index) => `
      <div class="outcome-item">
        <i style="background:var(${color})"></i>
        <span>${label} · ${stats.counts[key].toLocaleString()} 场 · 原始 ${pct(stats.probabilities[key])}</span>
        <strong>最终 ${pct(final[index])}</strong>
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
  if (!goals) {
    $("#goal-chart").innerHTML =
      '<div class="empty-state">本场未开售总进球赔率</div>';
    return;
  }
  const final = finalProbabilities(goals);
  const max = Math.max(...final, 0.01);
  $("#goal-chart").innerHTML = goals.labels
    .map((label, index) => {
      const value = final[index];
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
  const equalitiesByPoint = points.map((point) =>
    exactGoalOddsEqualities(
      config.keys.map((key) => Number(point[key])),
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
          const equalities = equalitiesByPoint[pointIndex].filter(
            (item) =>
              item.leftIndex === rowIndex || item.rightIndex === rowIndex,
          );
          const equalLabels = equalities.map((item) => {
            const pairedIndex =
              item.leftIndex === rowIndex ? item.rightIndex : item.leftIndex;
            return config.labels[pairedIndex];
          });
          const equalityLabel = equalLabels.length
            ? `<em class="movement-equality-badge">＝${escapeHtml(equalLabels.join(" / "))}</em>`
            : "";
          const titles = [
            ...(isMultiple
              ? relations.map(
                  (item) =>
                    `0球赔率 = ${item.label}赔率 ×${item.multiple}`,
                )
              : []),
            ...equalities.map(
              (item) =>
                `${item.label}赔率相同：${Number(item.equalOdds).toFixed(2)}`,
            ),
          ];
          const relationTitle = titles.length
            ? ` title="${escapeHtml(titles.join("；"))}"`
            : "";
          return `<td class="${direction}${pointIndex === points.length - 1 ? " latest" : ""}${isMultiple ? " multiple" : ""}${equalities.length ? " equal" : ""}"${relationTitle}><strong>${value.toFixed(2)}${multipleLabel}${equalityLabel}</strong><small>${movementText}</small></td>`;
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
    <span><i class="movement-equality-key">＝</i>金色赔率：与同列其他进球档赔率相同</span>
    <span><i class="movement-change-key up">↑</i>红色：赔率上升</span>
    <span><i class="movement-change-key down">↓</i>蓝色：赔率下降</span>
    <span><i class="movement-change-key flat">—</i>灰色：赔率不变</span>
    <span>每格为该时点的竞彩赔率，最右侧为最新</span>`;
}

function calculateNiceTicks(minVal, maxVal, targetTicks = 5) {
  const range = Math.max(0.05, maxVal - minVal);
  const roughStep = range / (targetTicks - 1);
  const stepMagnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalizedStep = roughStep / stepMagnitude;

  let niceNormalizedStep;
  if (normalizedStep <= 1.2) niceNormalizedStep = 1;
  else if (normalizedStep <= 2.5) niceNormalizedStep = 2;
  else if (normalizedStep <= 6) niceNormalizedStep = 5;
  else niceNormalizedStep = 10;

  const niceStep = niceNormalizedStep * stepMagnitude;
  const niceMin = Math.floor(minVal / niceStep) * niceStep;
  const niceMax = Math.ceil(maxVal / niceStep) * niceStep;

  const ticks = [];
  for (let val = niceMin; val <= niceMax + 1e-5; val += niceStep) {
    ticks.push(Number(val.toFixed(4)));
  }
  return {
    min: niceMin,
    max: niceMax,
    ticks,
  };
}

function oddsMovementInsight(label, first, latest) {
  const delta = latest - first;
  if (Math.abs(delta) < 1e-4) {
    return { dir: "flat", deltaText: "0.00", desc: "盘面平稳" };
  }
  if (delta < 0) {
    return {
      dir: "down",
      deltaText: delta.toFixed(2),
      desc: `下调 ${Math.abs(delta).toFixed(2)} · 机构防范${label}`,
    };
  }
  return {
    dir: "up",
    deltaText: `+${delta.toFixed(2)}`,
    desc: `上调 ${delta.toFixed(2)} · 信心减弱`,
  };
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

  const colors = { h: "var(--win)", d: "var(--draw)", a: "var(--loss)" };

  // 1. Direct comparison cards
  const insights = config.keys.map((key, i) => {
    const first = Number(points[0][key]);
    const latest = Number(points.at(-1)[key]);
    const label = config.labels[i];
    const insight = oddsMovementInsight(label, first, latest);
    return { key, label, first, latest, ...insight };
  });

  const comparisonCards = `
    <div class="movement-compare-board">
      ${insights
        .map(
          (item) => `
        <div class="movement-compare-row ${item.dir}">
          <span class="compare-label" style="color:${colors[item.key]}">${escapeHtml(item.label)}</span>
          <div class="compare-val first">
            <small>初赔</small>
            <strong>${item.first.toFixed(2)}</strong>
          </div>
          <div class="compare-flow">
            <span class="compare-badge ${item.dir}">${item.dir === "down" ? "↓" : item.dir === "up" ? "↑" : "—"} ${item.deltaText}</span>
            <div class="flow-line"><i class="flow-arrow"></i></div>
          </div>
          <div class="compare-val latest">
            <small>终赔</small>
            <strong style="color:${colors[item.key]}">${item.latest.toFixed(2)}</strong>
          </div>
          <span class="compare-desc">${escapeHtml(item.desc)}</span>
        </div>`,
        )
        .join("")}
    </div>
  `;

  // 2. SVG Chart with Nice Ticks & no overlap
  const width = 760;
  const height = 210;
  const plot = { left: 72, right: 64, top: 32, bottom: 36 };

  const values = points
    .flatMap((point) => config.keys.map((key) => Number(point[key])))
    .filter(Number.isFinite);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);

  const { min, max, ticks } = calculateNiceTicks(
    Math.max(1, rawMin - 0.12),
    rawMax + 0.12,
    5,
  );
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

  const lines = config.keys
    .map(
      (key) => {
        const first = Number(points[0][key]);
        const latest = Number(points.at(-1)[key]);
        const delta = latest - first;
        const deltaArrow = delta < -1e-4 ? "↓" : delta > 1e-4 ? "↑" : "";

        return `
        <path d="${pathFor(key)}" fill="none" stroke="${colors[key]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        ${points
          .map(
            (point, index) => {
              const isLast = index === points.length - 1;
              const val = Number(point[key]).toFixed(2);
              const textAnchor = index === 0 ? "start" : isLast ? "end" : "middle";
              const tag = isLast && points.length > 1 ? ` ${deltaArrow}` : "";
              const textX = index === 0 ? x(index) : isLast ? x(index) : x(index);
              return `
              <circle class="movement-circle-pt-${index}" cx="${x(index)}" cy="${y(point[key])}" r="4.5" fill="${colors[key]}" stroke="var(--paper-bright)" stroke-width="2"/>
              <text class="movement-point-value" x="${textX}" y="${y(point[key]) - 9}" text-anchor="${textAnchor}" fill="${colors[key]}" font-weight="700">${val}${tag}</text>`;
            },
          )
          .join("")}`;
      },
    )
    .join("");

  const grid = ticks
    .map((tickVal) => {
      const yy = y(tickVal);
      if (yy < plot.top - 6 || yy > height - plot.bottom + 6) return "";
      return `<line x1="${plot.left}" x2="${width - plot.right}" y1="${yy}" y2="${yy}" stroke="rgba(16,33,38,.08)" stroke-dasharray="3 4"/><text class="movement-axis-value" x="${plot.left - 10}" y="${yy + 4}" text-anchor="end">${tickVal.toFixed(2)}</text>`;
    })
    .join("");

  const timeLabels = points
    .map(
      (point, index) => {
        const isFirst = index === 0;
        const isLast = index === points.length - 1;
        const anchor = isFirst ? "start" : isLast ? "end" : "middle";
        return `<text class="movement-axis-time" x="${x(index)}" y="${height - 10}" text-anchor="${anchor}">${escapeHtml(movementTimeLabel(point.time, index))}</text>`;
      },
    )
    .join("");

  const colWidth = points.length > 1
    ? (width - plot.left - plot.right) / (points.length - 1)
    : width - plot.left - plot.right;

  const hoverColumns = points
    .map((point, index) => {
      const pointLabel = `${movementTimeLabel(point.time, index)}，${config.keys
        .map(
          (key, keyIndex) =>
            `${config.labels[keyIndex]} ${Number(point[key]).toFixed(2)}`,
        )
        .join("，")}`;
      return `<rect class="movement-svg-column" data-point-index="${index}" tabindex="0" role="img" aria-label="${escapeHtml(pointLabel)}" x="${Math.max(0, x(index) - colWidth / 2)}" y="0" width="${colWidth}" height="${height}" fill="transparent" pointer-events="all"/>`;
    })
    .join("");

  $("#movement-chart").innerHTML = `
    ${comparisonCards}
    <div class="movement-svg-wrap">
      <svg viewBox="0 0 ${width} ${height}" role="group" aria-label="${escapeHtml(config.title)}，每个时点均可用键盘聚焦查看赔率">${grid}${lines}${timeLabels}${hoverColumns}</svg>
    </div>
  `;

  $("#movement-legend").innerHTML = `
    <span><i class="movement-change-key down">↓</i>红色/向下：赔率较前次下调</span>
    <span><i class="movement-change-key up">↑</i>蓝色/向上：赔率较前次上调</span>
    <span><i class="movement-change-key flat">—</i>灰色：赔率未变</span>
    <span>鼠标悬停、轻触或键盘聚焦各时点可查阅详情</span>
  `;

  const tooltip = $("#chart-tooltip");
  $$(".movement-svg-column").forEach((col) => {
    const showPoint = () => {
      const idx = Number(col.dataset.pointIndex);
      const point = points[idx];
      if (!point || !tooltip) return;
      const prev = idx > 0 ? points[idx - 1] : null;
      const timeDetail = point.time || `第 ${idx + 1} 次记录`;
      const colsHtml = config.keys
        .map((key, kIdx) => {
          const val = Number(point[key]);
          const prevVal = prev ? Number(prev[key]) : val;
          const delta = idx > 0 ? val - prevVal : 0;
          const deltaDir = delta > 1e-9 ? "up" : delta < -1e-9 ? "down" : "flat";
          const deltaStr = idx > 0
            ? `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`
            : "初始";
          return `
            <div class="chart-tooltip-col">
              <b>${escapeHtml(config.labels[kIdx])}</b>
              <strong style="color:${colors[key]}">${val.toFixed(2)}</strong>
              <span class="chart-tooltip-delta ${deltaDir}">${deltaDir === "up" ? "↑" : deltaDir === "down" ? "↓" : "—"} ${deltaStr}</span>
            </div>`;
        })
        .join("");
      tooltip.innerHTML = `
        <div class="chart-tooltip-time">
          <span>${escapeHtml(timeDetail)}</span>
          <small>第 ${idx + 1}/${points.length} 次</small>
        </div>
        <div class="chart-tooltip-grid">${colsHtml}</div>`;
      tooltip.hidden = false;
      const ptX = x(idx);
      const svg = col.ownerSVGElement;
      if (svg) {
        const svgRect = svg.getBoundingClientRect();
        const pageX = svgRect.left + (ptX / width) * svgRect.width;
        const pageY = svgRect.top + (plot.top / height) * svgRect.height;
        tooltip.style.left = `${pageX}px`;
        tooltip.style.top = `${pageY}px`;
      }
      $$(`.movement-circle-pt-${idx}`).forEach((c) =>
        c.classList.add("movement-point-active"),
      );
    };
    const hidePoint = () => {
      if (tooltip) tooltip.hidden = true;
      $$(".movement-point-active").forEach((c) =>
        c.classList.remove("movement-point-active"),
      );
    };
    col.addEventListener("mouseenter", showPoint);
    col.addEventListener("focus", showPoint);
    col.addEventListener("click", showPoint);
    col.addEventListener("mouseleave", hidePoint);
    col.addEventListener("blur", hidePoint);
    col.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hidePoint();
        col.blur();
      }
    });
  });
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
    ? `<tr><th>联赛</th><th>历史比赛</th><th>比分</th><th>赛果</th><th>胜 / 平 / 负赔率</th><th>相似度</th><th>样本权重</th><th>历史池占比</th></tr>`
    : isHhad
      ? `<tr><th>联赛</th><th>历史比赛</th><th>让球</th><th>比分</th><th>让球赛果</th><th>让胜 / 让平 / 让负赔率</th><th>相似度</th><th>样本权重</th><th>历史池占比</th></tr>`
    : `<tr><th>联赛</th><th>历史比赛</th><th>总进球</th><th>0–7+ 赔率</th><th>相似度</th><th>样本权重</th><th>历史池占比</th></tr>`;
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

// 信心等级 → CSS 类名。等级由「有多少关通过各自玩法的已验证规则」决定。
function confidenceClass(level) {
  if (level === "高") return "high";
  if (level === "中高") return "mid-high";
  if (level === "中") return "mid";
  return "low";
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
    legs: Number($('input[name="parlay-legs"]:checked').value),
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
  const topbarBadge = $("#topbar-parlay-badge");
  const topbarTag = $("#topbar-parlay-tag");
  if (topbarBadge) {
    if (count > 0) {
      topbarBadge.hidden = false;
      topbarBadge.textContent = count;
      if (topbarTag) topbarTag.hidden = true;
    } else {
      topbarBadge.hidden = true;
      if (topbarTag) topbarTag.hidden = false;
    }
  }
}

function defaultParlaySelection(
  candidates,
  mode = state.parlayMode,
  legs = parlaySettings().legs,
) {
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
      .slice(0, legs)
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
      const rawMovement = goalPairMode
        ? pick?.eligibilityReason || "缺少进球双选预测"
        : pick?.movement?.applied
          ? `走势 ${pick.movement.sampleSize.toLocaleString()} 场 · 权重 ${pct(pick.movement.weight)}`
          : "走势回退基础模型";
      const movementText = String(rawMovement).replace(/\n+/g, "；");
      const sampleStats = `${pick.sampleScope || "全部联赛"}相似 ${pick.samples.toLocaleString()} 场 · 置信度 ${escapeHtml(pick.confidence)}`;
      const sampleDetail = !goalPairMode && !selectable
        ? `所有可用玩法赔率均低于 ${minLegOdds.toFixed(2)}，不参与串关`
        : `${sampleStats} · ${escapeHtml(movementText)}`;
      const reliability = pick?.reliability || {
        level: "cautious",
        label: "谨慎参考",
      };
      const reliabilityLabel = reliability.level === "recommended"
        ? "历史稳定"
        : reliability.level === "skip"
          ? "样本不足"
          : "历史观察";
      const marketComparison = pick?.marketComparison;
      const marketSignalClass = marketComparison?.status === "historical-divergence"
        ? "divergent"
        : "aligned";
      const marketSignal = marketComparison?.available
        ? `<b class="candidate-market-signal ${marketSignalClass}" title="${escapeHtml(marketComparison.reason)}">${escapeHtml(marketComparison.label)} · ${signedPp(pick.probabilityDelta)}</b>`
        : '<b class="candidate-market-signal unknown">未完成市场比较</b>';
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
            <small><b class="candidate-reliability ${escapeHtml(reliability.level)}">${escapeHtml(reliabilityLabel)}</b>${marketSignal}<span>${sampleDetail}</span></small>
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
  if (
    goalPairMode &&
    ["stability", "target"].includes($("#parlay-sort").value)
  ) {
    // 进球双选的非 value 排序本质上都是覆盖率优先，统一为正式默认值，
    // 避免自动生成的第一组被误记为用户自选。
    $("#parlay-sort").value = "probability";
  }
  const legInputs = $$('input[name="parlay-legs"]');
  $("#parlay-target-field").hidden = goalPairMode;
  $("#parlay-min-leg-field").hidden = goalPairMode;
  $("#parlay-target-sort-option").disabled = goalPairMode;
  legInputs.forEach((input) => {
    input.disabled = false;
  });
  const legCount = parlaySettings().legs;
  const goalPairStake = 2 ** legCount;
  $("#parlay-value-formula").textContent = goalPairMode
    ? `${goalPairStake}注预期返还 ÷ ${goalPairStake}`
    : "赔率 × 命中率";
  // 措辞刻意避开「期望净正」这类结论：回报指数只是概率与赔率的乘积，
  // 离线回测显示它越高实际回报越差，不能当作盈利信号。
  $("#parlay-value-note").textContent = goalPairMode
    ? `${goalPairStake}注拆分平均回报指数：仅为模型概率与赔率的乘积，用于横向排序；离线回测显示该指数越高实际回报反而越差，高于 1.00 不代表值得投注。`
    : "仅为模型概率与赔率的乘积，用于横向排序。离线回测显示该指数越高实际回报反而越差，高于 1.00 不代表值得投注。";
  $("#parlay-method-chip").textContent = goalPairMode
    ? state.parlayMethod?.tolerance || "0球近邻 / 综合距离概率前两名"
    : state.parlayMethod?.tolerance || "胜平负 / 让球";
  const scope = state.parlayMethod?.scope ||
    ($("#parlay-scope").value === "same" ? "只看同联赛" : "全部联赛");
  // 市场基准只描述无优势假设下的水钱复合，不是模型收益上限。
  const baselineRtp = (
    MARKET_BASELINE_SINGLE_LEG_RTP ** legCount *
    100
  ).toFixed(1);
  const sortNote =
    parlaySettings().sort === "stability"
      ? "当前按最弱一环排序（研究观察，未经串关时间验证）"
      : "默认按历史联合概率排序（仅为测算顺序）";
  $("#parlay-rule-note").textContent = goalPairMode
    ? `${scope}；每场取两个高概率进球档位（共${goalPairStake}注），不设最低组合赔率。按市场平均返还率估算，${legCount} 关无优势基准约 ${baselineRtp}%，不是收益上限。`
    : `${scope}；每关赔率不低于 ${parlaySettings().minLegOdds.toFixed(2)}；${sortNote}。按市场平均返还率估算，${legCount} 关无优势基准约 ${baselineRtp}%，不是收益上限。`;
  const defaults = defaultParlaySelection(
    state.parlayCandidates,
    state.parlayMode,
  );
  state.parlaySelected = defaults.selected;
  state.parlayMarkets = defaults.markets;
  renderCandidates();
  $("#combination-summary").textContent = goalPairMode
    ? `为便于测算，先选中历史双选覆盖率最高的${legCount}场；可随时改选，不构成推荐。`
    : "设置规则后测算串关组合；结果不代表已验证优势。";
  showParlayEmpty(
    "组合结果会出现在这里",
    goalPairMode
      ? `已为测算选中单场覆盖率最高的${legCount}场，可改选后再生成。`
      : "先选择至少两场比赛，再点击“生成组合”。",
  );
}

async function loadParlayCandidates() {
  $("#candidate-loading").hidden = false;
  $("#parlay-error").hidden = true;
  try {
    const params = new URLSearchParams({
      mode: state.parlayMode,
      legs: parlaySettings().legs,
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
      `${payload.method.scope}；${payload.method.probability}；市场一致不表示优势，历史偏离也只作待验证观察。`;
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
    ? settings.sort === "probability"
    : settings.legs === 2 &&
        settings.sort === "probability" &&
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
    showToast(
      payload.duplicate
        ? "该组合此前已在实战账本中留档"
        : "串关组合已成功存入实战账本（待结算）",
      {
        type: "success",
        actionText: "查看账本 ↗",
        onAction: () => {
          setView("ledger");
          setLedgerTab("parlay");
        },
      },
    );
  } catch (error) {
    button.disabled = false;
    button.classList.remove("busy");
    button.textContent = "记录失败，重试";
    button.title = error.message;
    showToast(`记录失败：${error.message}`, { type: "error" });
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
    `仅作组合测算：每关赔率 ≥ ${settings.minLegOdds.toFixed(2)}；共计算 ${total.toLocaleString()} 种，${eligible.toLocaleString()} 种达到组合赔率 ${settings.targetOdds.toFixed(2)}，展示前 ${rows.length} 种。`;

  if (!rows.length) {
    showParlayEmpty(
      "没有达到当前规则的组合",
      "可降低最低组合赔率、减少串关数，或多选择几场比赛。",
    );
    return;
  }

  $("#combination-list").innerHTML = rows
    .map((combination, index) => {
      // 回报指数（模型概率 × 赔率）不再作为推荐信号高亮：
      // 离线实测显示该指数越高实际 ROI 越差（见 scripts/report_value_bands.mjs），
      // 高亮会把一个已被数据反驳的信号包装成推荐。
      const payout = (combination.combinedOdds * 2).toFixed(2);
      const netProfit = (combination.combinedOdds * 2 - 2).toFixed(2);
      const ratio = Number(combination.combinedOdds).toFixed(2);
      const assessment = combination.marketAssessment || {};
      const divergentLegs = Number(assessment.historicalDivergenceLegs || 0);
      const alignedLegs = Number(assessment.marketAlignedLegs || 0);
      return `
        <article class="combination-card" style="--order:${index}">
          <header>
            <span class="combination-rank">组合 ${String(index + 1).padStart(2, "0")}</span>
            <span class="combination-type">${settings.legs} 串 1</span>
            <span class="combination-confidence level-${confidenceClass(combination.confidenceLevel)}"
                  title="按各关是否通过所属玩法的已验证筛选规则统计；含建议跳过关时只显示低信心">
              历史稳定 ${escapeHtml(combination.confidenceLevel || "—")} · 规则通过 ${Number(combination.recommendedLegs || 0)}/${Number(combination.totalLegs || settings.legs)}
            </span>
          </header>
          <div class="combination-market-note ${divergentLegs ? "divergent" : "aligned"}">
            <strong>市场一致 ${alignedLegs} 关 · 历史偏离 ${divergentLegs} 关</strong>
            <span>没有已验证优势，仅作组合测算</span>
          </div>
          <div class="combination-legs">
            ${combination.legs
              .map(
                (leg, legIndex) => `
                <div class="combination-leg">
                  <span class="leg-number">${legIndex + 1}</span>
                  <span class="leg-match">
                    <small>${escapeHtml(leg.league)}</small>
                    <strong>${escapeHtml(leg.home)} <em>vs</em> ${escapeHtml(leg.away)}</strong>
                    <span class="leg-market">${escapeHtml(leg.marketLabel)} · ${escapeHtml(leg.marketComparison?.label || "未比较")}</span>
                  </span>
                  <span class="leg-result ${resultClass(leg.predicted)}">${escapeHtml(leg.predicted)}</span>
                  <span class="leg-stat"><small>概率</small>${pct(leg.probability)}</span>
                  <span class="leg-stat"><small>赔率</small>${Number(leg.odds).toFixed(2)}</span>
                  ${
                    leg.id === combination.weakestLegId
                      ? `<span class="leg-weakest" title="这一关的历史占比最低，是整个组合的短板">短板</span>`
                      : ""
                  }
                </div>`,
              )
              .join("")}
          </div>

          <div class="combination-payout-banner">
            <span>投 2元 (1注)</span>
            <strong>命中时返还 ${payout} 元 <small>(票面差额 +${netProfit}元 · ${ratio}倍；未计概率误差)</small></strong>
            <span class="payout-expected-tag">票面测算</span>
          </div>

          <footer>
            <div>
              <small>组合赔率</small>
              <strong>${Number(combination.combinedOdds).toFixed(2)}</strong>
            </div>
            <div>
              <small>最弱一环<span class="hint-mark" title="组合里历史占比最低的那一关；这是未经串关时间验证的研究指标，从大量候选中择优仍可能产生选择偏差">*</span></small>
              <strong>${pct(combination.weakestTopProbability, 1)}</strong>
              <span>领先 ${pct(combination.weakestMargin, 1)}</span>
            </div>
            <div>
              <small>估算命中率<span class="hint-mark" title="各关概率相乘，假设互相独立；单场概率误差在乘法下会放大">*</span></small>
              <strong>${pct(combination.hitProbability, 1)}</strong>
            </div>
            <div class="combination-save-cell">
              <button
                class="combination-save-button"
                type="button"
                data-combination-id="${escapeHtml(combination.id)}"
                data-selection-source="${isDefaultParlayCombination(index) ? "system_default" : "user_saved"}"
              >记录此组合</button>
              <small>${isDefaultParlayCombination(index) ? "测算默认" : "自选规则"}</small>
            </div>
          </footer>
        </article>`;
    })
    .join("");
  bindCombinationSaveButtons(saveQuery);
}

function renderGoalPairCombinations(payload) {
  const { rows, total, settings } = payload.combinations;
  const sortLabel = settings?.sort === "value" ? "回报指数排序" : "历史联合概率排序";
  const legCount = Number(settings?.legs || 2);
  const stakeUnits = Number(settings?.stakePerCombination || 2 ** legCount);
  const stakeYuan = stakeUnits * 2;
  $("#combination-summary").textContent =
    `仅作组合测算：共计算 ${total.toLocaleString()} 组双选${legCount}串1 · ${sortLabel}；每组投入${stakeUnits}注（${stakeYuan}元），展示前 ${rows.length} 种。`;
  if (!rows.length) {
    showParlayEmpty(
      "暂时无法生成总进球双选组合",
      `至少选择${legCount}场具有两个有效进球数选项的比赛。`,
    );
    return;
  }
  $("#combination-list").innerHTML = rows
    .map((combination, index) => {
      // 同上：回报指数不作为推荐信号高亮。
      const minPayout = (combination.minimumTicketOdds * 2).toFixed(2);
      const maxPayout = (combination.maximumTicketOdds * 2).toFixed(2);
      const minRatio = ((combination.minimumTicketOdds * 2) / stakeYuan).toFixed(1);
      const maxRatio = ((combination.maximumTicketOdds * 2) / stakeYuan).toFixed(1);
      const assessment = combination.marketAssessment || {};
      const divergentLegs = Number(assessment.historicalDivergenceLegs || 0);
      const alignedLegs = Number(assessment.marketAlignedLegs || 0);

      const ticketsList = (combination.tickets || []).map((t, tIdx) => {
        const payout = (t.combinedOdds * 2).toFixed(2);
        const ratio = ((t.combinedOdds * 2) / stakeYuan).toFixed(1);
        const selectionsText = t.selections
          .map(
            (selection) =>
              `<b>${escapeHtml(selection.label)}球</b>`,
          )
          .join(" × ");
        return `
          <div class="goal-pair-ticket-item">
            <span>注${tIdx + 1}: ${selectionsText} (${t.combinedOdds.toFixed(2)}倍)</span>
            <strong>命中返 ${payout}元 <small>(${ratio}倍)</small></strong>
          </div>`;
      }).join("");

      return `
        <article class="combination-card goal-pair-combination" style="--order:${index}">
          <header>
            <span class="combination-rank">双选组合 ${String(index + 1).padStart(2, "0")}</span>
            <span class="combination-type">${legCount} 串 1 · 双选${stakeUnits}注</span>
          </header>
          <div class="combination-market-note ${divergentLegs ? "divergent" : "aligned"}">
            <strong>市场前两项一致 ${alignedLegs} 关 · 历史偏离 ${divergentLegs} 关</strong>
            <span>没有已验证优势，仅作组合测算</span>
          </div>
          <div class="combination-legs">
            ${combination.legs
              .map(
                (leg, legIndex) => `
                <div class="combination-leg goal-pair-leg">
                  <span class="leg-number">${legIndex + 1}</span>
                  <span class="leg-match">
                    <small>${escapeHtml(leg.league)}</small>
                    <strong>${escapeHtml(leg.home)} <em>vs</em> ${escapeHtml(leg.away)}</strong>
                    <span class="leg-market">总进球双选 · ${escapeHtml(leg.marketComparison?.label || "未比较")} · ${Number(leg.samples).toLocaleString()}场相似</span>
                  </span>
                  <span class="leg-result goal-pair-result">${escapeHtml(leg.predicted)}</span>
                  <span class="leg-stat"><small>覆盖率</small>${pct(leg.probability)}</span>
                  <span class="leg-stat"><small>两档赔率</small>${leg.odds.map((odd) => Number(odd).toFixed(2)).join(" / ")}</span>
                </div>`,
              )
              .join("")}
          </div>

          <div class="goal-pair-payout-banner">
            <span>投 ${stakeYuan}元 (${stakeUnits}注)</span>
            <strong>命中时返还 ${minPayout} ~ ${maxPayout} 元 <small>(${minRatio} ~ ${maxRatio}倍；未计概率误差)</small></strong>
            <span class="payout-expected-tag">区间测算</span>
          </div>

          <details class="goal-pair-breakdown-details">
            <summary>展开查看 ${stakeUnits} 注拆分赔率与返还明细</summary>
            <div class="goal-pair-tickets-grid">
              ${ticketsList}
            </div>
          </details>

          <footer>
            <div>
              <small>总成本 (${stakeUnits}注)</small>
              <strong>${stakeYuan} 元</strong>
            </div>
            <div>
              <small>估算${legCount}场均覆盖</small>
              <strong>${pct(combination.hitProbability, 1)}</strong>
            </div>
            <div class="return-index">
              <small>${stakeUnits}注回报指数</small>
              <strong>${Number(combination.valueIndex).toFixed(3)}</strong>
              <span>仅供排序</span>
            </div>
            <div class="combination-save-cell">
              <button
                class="combination-save-button"
                type="button"
                data-combination-id="${escapeHtml(combination.id)}"
                data-selection-source="${isDefaultParlayCombination(index) ? "system_default" : "user_saved"}"
              >记录此组合</button>
              <small>${isDefaultParlayCombination(index) ? "测算默认" : "自选规则"}</small>
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
        ? `至少需要${settings.legs}场进球双选候选`
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
    const comboSection = $(".combination-section");
    if (comboSection) {
      comboSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
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
  // 正式默认仍使用组合命中率；最弱一环保留为未经时间验证的研究排序。
  $("#parlay-sort").value = "probability";
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
    loadPrediction({ quiet: true }).then(() => loadMatchReliability());
    if (state.activeView === "parlay") loadParlayCandidates();
  }, 180);
}

$("#match-search").addEventListener("input", (event) => renderMatchList(event.target.value));
$$('[data-match-filter]').forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    state.matchReliabilityFilter = button.dataset.matchFilter;
    renderMatchList();
  });
});
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
$("#ledger-overview-policy").addEventListener("change", () =>
  loadLedger({ settle: false }),
);
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
  "#ledger-single-policy",
  "#ledger-single-status",
  "#ledger-single-market",
  "#ledger-single-scope",
  "#ledger-single-league",
  "#ledger-single-from",
  "#ledger-single-to",
].forEach((selector) => {
  $(selector).addEventListener("change", () => {
    state.ledgerDrilldown = null;
    reloadLedgerSection("single");
  });
});
[
  "#ledger-parlay-policy",
  "#ledger-parlay-status",
  "#ledger-parlay-mode",
  "#ledger-parlay-source",
  "#ledger-parlay-from",
  "#ledger-parlay-to",
].forEach((selector) => {
  $(selector).addEventListener("change", () => reloadLedgerSection("parlay"));
});
$("#ledger-single-query").addEventListener("input", () =>
  {
    state.ledgerDrilldown = null;
    reloadLedgerSection("single", { delayed: true });
  },
);
$("#ledger-parlay-query").addEventListener("input", () =>
  reloadLedgerSection("parlay", { delayed: true }),
);
$("#ledger-single-reset").addEventListener("click", () => {
  state.ledgerDrilldown = null;
  $("#ledger-single-policy").value = "current";
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
  $("#ledger-parlay-policy").value = "current";
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

$$('input[name="parlay-legs"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked && state.parlayMode === "goalsPair") {
      applyParlayMode("goalsPair");
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

$("#theme-toggle-btn")?.addEventListener("click", toggleTheme);
initTheme();

document.addEventListener("click", (event) => {
  const tip = event.target.closest(".term-tip");
  if (tip) {
    const active = !tip.classList.contains("active");
    $$(".term-tip.active").forEach((el) => {
      el.classList.remove("active");
      el.setAttribute("aria-expanded", "false");
    });
    tip.classList.toggle("active", active);
    tip.setAttribute("aria-expanded", String(active));
  } else {
    $$(".term-tip.active").forEach((el) => {
      el.classList.remove("active");
      el.setAttribute("aria-expanded", "false");
    });
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  $$(".term-tip.active").forEach((el) => {
    el.classList.remove("active");
    el.setAttribute("aria-expanded", "false");
  });
});

loadMatches();
