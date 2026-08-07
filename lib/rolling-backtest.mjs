import { selectTopGoalPair } from "./predictor.mjs";

function groupBySource(rows) {
  const groups = new Map();
  for (const row of rows) {
    const source = row.sourceFile || "unknown";
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push(row);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.sourceRow - right.sourceRow);
  }
  return groups;
}

export function walkForward(rows, { warmup = 500, predict }) {
  const safeWarmup = Math.max(1, Math.trunc(Number(warmup) || 1));
  const cases = [];
  const sources = [];

  for (const [sourceFile, group] of groupBySource(rows)) {
    const history = [];
    let evaluated = 0;
    for (const row of group) {
      if (history.length >= safeWarmup) {
        cases.push({
          sourceFile,
          sourceRow: row.sourceRow,
          ...predict(row, history),
        });
        evaluated += 1;
      }
      history.push(row);
    }
    sources.push({
      sourceFile,
      rows: group.length,
      evaluated,
      skippedAsWarmup: Math.min(group.length, safeWarmup),
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

  for (const item of cases) {
    const probabilities = item[probabilityField];
    const predictionIndex = item[predictionField];
    if (predictionIndex === item.actualIndex) {
      correct += 1;
      netReturn += item.odds[predictionIndex] - 1;
    } else {
      netReturn -= 1;
    }
    logLoss -= Math.log(Math.max(1e-12, probabilities[item.actualIndex]));
    brier += probabilities.reduce((sum, probability, index) => {
      const actual = index === item.actualIndex ? 1 : 0;
      return sum + (probability - actual) ** 2;
    }, 0);
  }

  return {
    evaluated: cases.length,
    accuracy: correct / cases.length,
    logLoss: logLoss / cases.length,
    brier: brier / cases.length,
    flatBetRoi: netReturn / cases.length,
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
