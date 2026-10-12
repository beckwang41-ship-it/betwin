import { ledgerCalendarDate } from "./ledger-date.js";

export function settledLedgerCounts(totals = {}, coreByScope = {}) {
  return {
    fixtures: Math.max(
      0,
      Number(totals.coreSettledFixtures ?? totals.settledFixtures) || 0,
    ),
    allPredictions: Math.max(0, Number(coreByScope.all?.settled) || 0),
    sameLeaguePredictions: Math.max(
      0,
      Number(coreByScope.sameLeague?.settled) || 0,
    ),
  };
}

const finiteMetric = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const countMetric = (value) => Math.max(0, finiteMetric(value));

export const STAKE_UNIT_YUAN = 2;

export function formatStakeProfit(units, unitYuan = STAKE_UNIT_YUAN) {
  const amount = finiteMetric(units);
  const yuanPerUnit = Math.max(0, finiteMetric(unitYuan));
  const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
  const absoluteUnits = Math.abs(amount);
  const yuan = absoluteUnits * yuanPerUnit;
  return `${sign}${yuan.toFixed(2)} 元 (${sign}${absoluteUnits.toFixed(2)} 注)`;
}

export function capitalLedgerMetrics(single = {}, parlays = {}) {
  const total = countMetric(single.total) + countMetric(parlays.total);
  const settled = countMetric(single.settled) + countMetric(parlays.settled);
  const correct = countMetric(single.correct) + countMetric(parlays.correct);
  const stakeUnits = countMetric(single.stakeUnits) + countMetric(parlays.stakeUnits);
  const simulatedProfit =
    finiteMetric(single.simulatedProfit) + finiteMetric(parlays.simulatedProfit);

  return {
    total,
    settled,
    correct,
    accuracy: settled ? correct / settled : null,
    stakeUnits,
    simulatedProfit,
    simulatedReturn: stakeUnits ? stakeUnits + simulatedProfit : 0,
    roi: stakeUnits ? simulatedProfit / stakeUnits : null,
  };
}

export function ledgerPerformanceMetrics(events = [], rollingWindow = 30) {
  const windowSize = Math.max(1, Math.trunc(Number(rollingWindow) || 30));
  const ordered = (Array.isArray(events) ? events : [])
    .map((event, index) => ({
      id: String(event?.id ?? index),
      type: String(event?.type || "single"),
      market: String(event?.market || ""),
      capturedAt: String(event?.capturedAt || ""),
      settledAt: String(event?.settledAt || ""),
      correct: Boolean(event?.correct),
      stakeUnits: finiteMetric(event?.stakeUnits),
      simulatedProfit: finiteMetric(event?.simulatedProfit),
    }))
    .filter(
      (event) =>
        event.stakeUnits > 0 &&
        /^\d{4}-\d{2}-\d{2}/.test(event.capturedAt),
    )
    .sort((left, right) =>
      left.capturedAt.localeCompare(right.capturedAt) ||
      left.type.localeCompare(right.type) ||
      left.id.localeCompare(right.id),
    );

  let cumulativeProfit = 0;
  let peakProfit = 0;
  let maximumDrawdown = 0;
  let currentMissStreak = 0;
  let longestMissStreak = 0;
  const points = ordered.map((event, index) => {
    cumulativeProfit += event.simulatedProfit;
    peakProfit = Math.max(peakProfit, cumulativeProfit);
    maximumDrawdown = Math.max(maximumDrawdown, peakProfit - cumulativeProfit);
    currentMissStreak = event.correct ? 0 : currentMissStreak + 1;
    longestMissStreak = Math.max(longestMissStreak, currentMissStreak);

    const windowStart = Math.max(0, index - windowSize + 1);
    const window = ordered.slice(windowStart, index + 1);
    const windowStake = window.reduce(
      (sum, row) => sum + row.stakeUnits,
      0,
    );
    const windowProfit = window.reduce(
      (sum, row) => sum + row.simulatedProfit,
      0,
    );
    return {
      ...event,
      index: index + 1,
      cumulativeProfit: Number(cumulativeProfit.toFixed(4)),
      drawdown: Number((peakProfit - cumulativeProfit).toFixed(4)),
      rollingRoi:
        window.length === windowSize && windowStake > 0
          ? Number((windowProfit / windowStake).toFixed(6))
          : null,
    };
  });

  const dailyMap = new Map();
  for (const point of points) {
    const date = ledgerCalendarDate(point.capturedAt);
    const current = dailyMap.get(date) || {
      date,
      entries: 0,
      correct: 0,
      stakeUnits: 0,
      dailyProfit: 0,
      cumulativeProfit: 0,
      rollingRoi: null,
    };
    current.entries += 1;
    current.correct += point.correct ? 1 : 0;
    current.stakeUnits += point.stakeUnits;
    current.dailyProfit += point.simulatedProfit;
    current.cumulativeProfit = point.cumulativeProfit;
    current.rollingRoi = point.rollingRoi;
    dailyMap.set(date, current);
  }
  const daily = [...dailyMap.values()].map((row) => ({
    ...row,
    stakeUnits: Number(row.stakeUnits.toFixed(4)),
    dailyProfit: Number(row.dailyProfit.toFixed(4)),
  }));
  const last = points.at(-1) || null;

  return {
    entries: ordered.length,
    rollingWindow: windowSize,
    rollingReady: ordered.length >= windowSize,
    rollingRoi: last?.rollingRoi ?? null,
    cumulativeProfit: last?.cumulativeProfit ?? 0,
    maximumDrawdown: Number(maximumDrawdown.toFixed(4)),
    currentDrawdown: Number((last?.drawdown || 0).toFixed(4)),
    longestMissStreak,
    currentMissStreak,
    firstCapturedAt: ordered[0]?.capturedAt || null,
    lastCapturedAt: last?.capturedAt || null,
    points,
    daily,
  };
}

export function calculateDoubleChance(prediction, marketOdds, isHhad = false) {
  if (!prediction || prediction.available === false || !Array.isArray(prediction.final)) {
    return null;
  }
  const labels = isHhad ? ["让胜", "让平", "让负"] : ["主胜", "平局", "客胜"];
  const oddsKeys = ["h", "d", "a"];
  const probs = prediction.final.map(Number);
  if (probs.length !== 3 || probs.some((v) => !Number.isFinite(v))) {
    return null;
  }

  const indexed = probs
    .map((p, i) => ({ index: i, prob: p, label: labels[i], oddsKey: oddsKeys[i] }))
    .sort((a, b) => b.prob - a.prob);

  const top1 = indexed[0];
  const top2 = indexed[1];
  const combinedCover = top1.prob + top2.prob;
  const o1 = marketOdds ? Number(marketOdds[top1.oddsKey] || 0) : 0;
  const o2 = marketOdds ? Number(marketOdds[top2.oddsKey] || 0) : 0;
  const combinedOdds = o1 > 0 && o2 > 0 ? (o1 * o2) / (o1 + o2) : 0;

  const pairLabel = `${top1.label} / ${top2.label}`;

  return {
    top1,
    top2,
    pairLabel,
    combinedCover,
    combinedOdds,
    o1,
    o2,
  };
}

export function crossValidateScoreAndGoals(topScores = [], targetGoalLabels = []) {
  if (
    !Array.isArray(topScores) ||
    !topScores.length ||
    !Array.isArray(targetGoalLabels) ||
    !targetGoalLabels.length
  ) {
    return { status: "none", matchedCount: 0, chips: [] };
  }
  const normalizedTargets = targetGoalLabels.map(String);
  let matchedCount = 0;
  const chips = topScores.map((item) => {
    const parts = String(item.score || "").split("-").map(Number);
    const sumGoals = parts[0] + parts[1];
    const goalLabel = Number.isFinite(sumGoals)
      ? sumGoals >= 7
        ? "7+"
        : String(sumGoals)
      : null;
    const isGoalMatch = Boolean(
      goalLabel &&
        (normalizedTargets.includes(goalLabel) ||
          (sumGoals >= 7 && normalizedTargets.includes("7")) ||
          normalizedTargets.includes(`${goalLabel}球`)),
    );
    if (isGoalMatch) matchedCount++;
    return {
      ...item,
      sumGoals,
      isGoalMatch,
    };
  });

  let status = "none";
  if (topScores.length >= 2 && matchedCount >= 2) {
    status = "verified";
  } else if (matchedCount >= 1) {
    status = "partial";
  }

  return {
    status,
    matchedCount,
    chips,
  };
}

const comparableTimelineValue = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : String(value ?? "");
};

export function timelineHasOddsMovement(points = [], keys = []) {
  if (!Array.isArray(points) || points.length < 2 || !Array.isArray(keys)) {
    return false;
  }
  const first = points[0] || {};
  return points.slice(1).some((point = {}) =>
    keys.some((key) => {
      const initial = comparableTimelineValue(first[key]);
      const current = comparableTimelineValue(point[key]);
      if (typeof initial === "number" && typeof current === "number") {
        return Math.abs(current - initial) >= 0.005;
      }
      return current !== initial;
    }),
  );
}

export function matchHasOddsMovement(match) {
  if (!match) return false;
  if (
    timelineHasOddsMovement(match?.hadTimeline, ["h", "d", "a"]) ||
    timelineHasOddsMovement(match?.hhadTimeline, ["goalLine", "h", "d", "a"]) ||
    timelineHasOddsMovement(match?.goalTimeline, [
      "g0",
      "g1",
      "g2",
      "g3",
      "g4",
      "g5",
      "g6",
      "g7plus",
    ])
  ) {
    return true;
  }
  if (match.had?.history?.initial && match.had) {
    const init = match.had.history.initial;
    if (
      ["h", "d", "a"].some(
        (k) =>
          Math.abs(Number(match.had[k] || 0) - Number(init[k] || 0)) >= 0.005,
      )
    ) {
      return true;
    }
  }
  if (match.hhad?.history?.initial && match.hhad) {
    const init = match.hhad.history.initial;
    if (
      ["h", "d", "a"].some(
        (k) =>
          Math.abs(Number(match.hhad[k] || 0) - Number(init[k] || 0)) >= 0.005,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function formatOddsWithMovement(current, initial) {
  const c = Number(current);
  if (!Number.isFinite(c) || c <= 0) {
    return {
      text: "赔率 —",
      html: "赔率 —",
      badgeText: "",
      trend: "none",
      diff: 0,
      current: null,
      initial: null,
    };
  }
  const init = Number(initial);
  const hasInitial = Number.isFinite(init) && init > 0;
  if (!hasInitial || Math.abs(c - init) < 0.005) {
    return {
      text: `赔率 ${c.toFixed(2)}`,
      html: `赔率 ${c.toFixed(2)}`,
      badgeText: "",
      trend: "flat",
      diff: 0,
      current: c,
      initial: hasInitial ? init : null,
    };
  }
  const diff = c - init;
  if (diff < 0) {
    return {
      text: `赔率 ${c.toFixed(2)} ↓ (初 ${init.toFixed(2)})`,
      html: `赔率 ${c.toFixed(2)} <span class="odds-trend down" title="初盘 ${init.toFixed(2)} · 降水 ${Math.abs(diff).toFixed(2)}">↓ (初 ${init.toFixed(2)})</span>`,
      badgeText: `↓ (初 ${init.toFixed(2)})`,
      trend: "down",
      diff,
      current: c,
      initial: init,
    };
  }
  return {
    text: `赔率 ${c.toFixed(2)} ↑ (初 ${init.toFixed(2)})`,
    html: `赔率 ${c.toFixed(2)} <span class="odds-trend up" title="初盘 ${init.toFixed(2)} · 升水 ${Math.abs(diff).toFixed(2)}">↑ (初 ${init.toFixed(2)})</span>`,
    badgeText: `↑ (初 ${init.toFixed(2)})`,
    trend: "up",
    diff,
    current: c,
    initial: init,
  };
}
