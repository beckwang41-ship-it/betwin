import { spfDistance } from "./predictor.mjs";
import { selectHistoricalPrior } from "./smoothing.mjs";
import { selectThreeWaySimilarity } from "./three-way-matching.mjs";

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
    }));
}

function targetMatch(target) {
  return {
    league: target.league,
    had: {
      h: Number(target.spf.odds[0]),
      d: Number(target.spf.odds[1]),
      a: Number(target.spf.odds[2]),
    },
    hhad: {
      h: Number(target.hhad.odds[0]),
      d: Number(target.hhad.odds[1]),
      a: Number(target.hhad.odds[2]),
      goalLine: Number(target.hhad.handicap),
    },
  };
}

export function createThreeWaySmoothingResolvers(
  market,
  { spfTolerance = 0.07, hhadTolerance = 0.07 } = {},
) {
  if (!["spf", "hhad"].includes(market)) {
    throw new Error(`不支持的三项盘玩法：${market}`);
  }
  return {
    sampleResolver(target, priorRows) {
      const selection = selectThreeWaySimilarity(
        targetMatch(target),
        {
          spfHistory: priorRows.map((row) => row.spf),
          hhadHistory: priorRows.map((row) => row.hhad),
          pairedHistory: priorRows,
        },
        { spfTolerance, hhadTolerance, sameLeague: false },
      );
      return selection[market]?.similar || [];
    },
    priorResolver(priorRows, target, options) {
      const marketRows = priorRows.map((row) => row[market]);
      const marketTarget = target[market];
      return selectHistoricalPrior(marketRows, marketTarget, {
        labels: options.labels,
        outcomeField: "result",
        distance: (left, right) => spfDistance(left.odds, right.odds),
        compatible:
          market === "hhad"
            ? (left, right) => left.handicap === right.handicap
            : () => true,
        relaxedTolerance:
          Number(options.threshold) * Number(options.relaxedMultiplier),
        minLocalizedSamples: options.minLocalizedSamples,
      });
    },
  };
}
