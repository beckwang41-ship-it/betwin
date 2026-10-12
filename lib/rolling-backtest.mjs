import { selectTopGoalPair } from "./predictor.mjs";
import { strategyOutcome } from "./strategy-evaluation.mjs";
import { historyTimelines } from "./history-timeline.mjs";

export function walkForward(rows, { warmup = 500, predict }) {
  const safeWarmup = Math.max(1, Math.trunc(Number(warmup) || 1));
  const cases = [];
  const sources = [];

  for (const { sourceFile, seed, batches } of historyTimelines(rows)) {
    const history = [...seed];
    const group = batches.flat();
    let evaluated = 0;
    for (const batch of batches) {
      for (const row of batch) {
        if (history.length >= safeWarmup) {
          cases.push({
            sourceFile: row.sourceFile,
            sourceRow: row.sourceRow,
            historyBatchId: row.historyBatchId || 0,
            ...predict(row, history),
          });
          evaluated += 1;
        }
      }
      history.push(...batch);
    }
    sources.push({
      sourceFile,
      rows: group.length,
      evaluated,
      skippedAsWarmup: group.length - evaluated,
    });
  }

  return { cases, sources, warmup: safeWarmup };
}

export function summarizeCases(cases, probabilityField, predictionField) {
  if (!cases.length) {
    return {
      evaluated: 0,
      accuracy: 0,
      logLoss: 0,
      brier: 0,
      flatBetRoi: 0,
    };
  }

  let correct = 0;
  let logLoss = 0;
  let brier = 0;
  let netReturn = 0;
  let stakeUnits = 0;
  let strictSingles = 0;
  let multiSelections = 0;
  let covered = 0;

  for (const item of cases) {
    const probabilities = item[probabilityField];
    const outcome = strategyOutcome(probabilities, item.odds, item.actualIndex);
    stakeUnits += outcome.stakeUnits;
    netReturn += outcome.profitUnits;
    if (outcome.stakeUnits === 1) {
      strictSingles++;
      correct += Number(outcome.won);
    } else if (outcome.stakeUnits > 1) {
      multiSelections++;
      covered += Number(outcome.won);
    }
    logLoss -= Math.log(Math.max(1e-12, probabilities[item.actualIndex]));
    brier += probabilities.reduce((sum, probability, index) => {
      const actual = index === item.actualIndex ? 1 : 0;
      return sum + (probability - actual) ** 2;
    }, 0);
  }

  return {
    evaluated: cases.length,
    accuracy: strictSingles ? correct / strictSingles : null,
    strictSingles,
    multiSelections,
    multiSelectionCoverage: multiSelections ? covered / multiSelections : null,
    noPrediction: cases.length - strictSingles - multiSelections,
    stakeUnits,
    flatBetProfit: netReturn,
    logLoss: logLoss / cases.length,
    brier: brier / cases.length,
    flatBetRoi: stakeUnits ? netReturn / stakeUnits : null,
  };
}

export function summarizeGoalPairs(
  cases,
  probabilityField = "modelProbabilities",
) {
  if (!cases.length) {
    return {
      evaluated: 0,
      correct: 0,
      accuracy: 0,
      averageProbability: 0,
      flatBetProfit: 0,
      flatBetRoi: 0,
      stakePerMatch: 2,
    };
  }
  let correct = 0;
  let probabilityTotal = 0;
  let netReturn = 0;
  for (const item of cases) {
    const pair = selectTopGoalPair(
      item[probabilityField],
      item.odds,
    );
    if (!pair.available) continue;
    probabilityTotal += pair.probability;
    if (pair.indices.includes(item.actualIndex)) {
      correct += 1;
      netReturn += Number(item.odds[item.actualIndex]) - pair.stakeUnits;
    } else {
      netReturn -= pair.stakeUnits;
    }
  }
  const totalStake = cases.length * 2;
  return {
    evaluated: cases.length,
    correct,
    accuracy: correct / cases.length,
    averageProbability: probabilityTotal / cases.length,
    flatBetProfit: netReturn,
    flatBetRoi: totalStake ? netReturn / totalStake : 0,
    stakePerMatch: 2,
  };
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
