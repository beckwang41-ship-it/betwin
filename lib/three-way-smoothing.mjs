import { spfDistance } from "./predictor.mjs";
import { selectHistoricalPrior } from "./smoothing.mjs";
import { selectThreeWaySimilarity } from "./three-way-matching.mjs";
import { buildThreeWayEvents } from "./three-way-backtest.mjs";

// 正式预测和回测共用先验入口；history 必须包括该玩法未配对的历史记录。
export function selectThreeWayHistoricalPrior(history, target, market, {
  threshold = 0.07, relaxedMultiplier = 2, minLocalizedSamples = 30,
} = {}) {
  return selectHistoricalPrior(history, target, {
    labels: ["胜", "平", "负"], outcomeField: "result",
    distance: (left, right) => spfDistance(left.odds, right.odds),
    compatible: market === "hhad"
      ? (left, right) => Number(left.handicap) === Number(right.handicap)
      : () => true,
    relaxedTolerance: threshold * relaxedMultiplier, minLocalizedSamples,
  });
}

function marketHistoryRow(row, market) {
  const value = row[market];
  return {
    sourceFile:
      market === "spf" ? row.spfSourceFile : row.hhadSourceFile,
    sourceRow:
      market === "spf" ? row.spfSourceRow : row.hhadSourceRow,
    league: row.league,
    score: row.score,
    result: value.result,
    handicap: value.handicap,
    odds: value.odds.map(Number),
  };
}

export function buildThreeWaySmoothingRows(history, market) {
  if (!['spf', 'hhad'].includes(market)) {
    throw new Error(`不支持的三项盘玩法：${market}`);
  }
  if (!Array.isArray(history)) {
    return buildThreeWayEvents(history).map(event => ({
      ...event, result: event[market]?.result ?? null,
    }));
  }
  // 兼容旧研究调用；生产调参必须传入三个完整数据库样本池。
  return history
    .filter(
      (row) =>
        row?.spf?.odds?.length === 3 &&
        row?.hhad?.odds?.length === 3 &&
        ["胜", "平", "负"].includes(String(row[market]?.result)),
    )
    .map((row) => ({
      sourceFile: row.spfSourceFile,
      sourceRow: Number(row.spfSourceRow),
      league: row.league,
      score: row.score,
      result: row[market].result,
      spf: marketHistoryRow(row, "spf"),
      hhad: marketHistoryRow(row, "hhad"),
      pair: { ...row, spf: marketHistoryRow(row, "spf"), hhad: marketHistoryRow(row, "hhad") },
    }));
}

function targetMatch(target) {
  return {
    league: target.league,
    had: target.spf ? {
      h: Number(target.spf.odds[0]),
      d: Number(target.spf.odds[1]),
      a: Number(target.spf.odds[2]),
    } : null,
    hhad: target.hhad ? {
      h: Number(target.hhad.odds[0]),
      d: Number(target.hhad.odds[1]),
      a: Number(target.hhad.odds[2]),
      goalLine: Number(target.hhad.handicap),
    } : null,
  };
}

export function createThreeWaySmoothingResolvers(
  market,
  { spfTolerance = 0.07, hhadTolerance = 0.07 } = {},
) {
  if (!["spf", "hhad"].includes(market)) {
    throw new Error(`不支持的三项盘玩法：${market}`);
  }
  const cache = new WeakMap();
  const poolsFor = rows => {
    let cached = cache.get(rows);
    if (!cached) {
      cached = { added: 0, spfHistory: [], hhadHistory: [], pairedHistory: [] };
      cache.set(rows, cached);
    }
    while (cached.added < rows.length) {
      const row = rows[cached.added++];
      if (row.spf) cached.spfHistory.push(row.spf);
      if (row.hhad) cached.hhadHistory.push(row.hhad);
      if (row.pair) cached.pairedHistory.push(row.pair);
    }
    return cached;
  };
  return {
    sampleResolver(target, priorRows) {
      const selection = selectThreeWaySimilarity(
        targetMatch(target),
        poolsFor(priorRows),
        { spfTolerance, hhadTolerance, sameLeague: false },
      );
      return selection[market]?.similar || [];
    },
    priorResolver(priorRows, target, options) {
      const marketRows = poolsFor(priorRows)[`${market}History`];
      const marketTarget = target[market];
      return selectThreeWayHistoricalPrior(marketRows, marketTarget, market, options);
    },
  };
}
