import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findSimilarGoalMovements,
  findSimilarSpfMovements,
  findSimilarSpf,
  normalizeOdds,
  predictGoalsWithMovement,
  predictSpfWithMovement,
} from "../lib/predictor.mjs";
import {
  median,
  summarizeCases,
  summarizeGoalPairs,
  walkForward,
} from "../lib/rolling-backtest.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((value) => value.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : fallback;
}

function topIndex(probabilities) {
  return probabilities.indexOf(Math.max(...probabilities));
}

function goalDistanceFromProbabilities(left, right) {
  return Math.max(
    ...left.map((probability, index) =>
      Math.abs(probability - right[index]),
    ),
  );
}

function findPriorSimilarGoals(history, targetMarket, tolerance) {
  return history
    .map((row) => ({
      ...row,
      distance: goalDistanceFromProbabilities(row.market, targetMarket),
    }))
    .filter((row) => row.distance <= tolerance)
    .sort((left, right) => left.distance - right.distance);
}

function loadSpfRows(db) {
  return db
    .prepare(`
      SELECT m.spf_source_file AS source_file,
             m.spf_source_row AS source_row,
             s.league, s.result,
             s.initial_home_odds, s.initial_draw_odds, s.initial_away_odds,
             s.final_home_odds, s.final_draw_odds, s.final_away_odds
      FROM historical_matches m
      JOIN historical_spf s ON s.id = m.spf_id
      JOIN historical_hhad h ON h.id = m.hhad_id
      JOIN historical_goals g ON g.id = m.goals_id
      WHERE m.match_status = 'matched' AND m.goal_consistent = 1
      ORDER BY m.spf_source_file, m.spf_source_row
    `)
    .all()
    .map((row) => ({
      sourceFile: row.source_file,
      sourceRow: row.source_row,
      league: row.league,
      result: row.result,
      initialOdds:
        row.initial_home_odds &&
        row.initial_draw_odds &&
        row.initial_away_odds
          ? [
              row.initial_home_odds,
              row.initial_draw_odds,
              row.initial_away_odds,
            ]
          : null,
      odds: [
        row.final_home_odds,
        row.final_draw_odds,
        row.final_away_odds,
      ],
    }));
}

export function loadGoalRows(db) {
  return db
    .prepare(`
      SELECT m.goals_source_file AS source_file,
             m.goals_source_row AS source_row,
             g.league, g.actual_goals,
             g.initial_g0, g.initial_g1, g.initial_g2, g.initial_g3,
             g.initial_g4, g.initial_g5, g.initial_g6, g.initial_g7plus,
             g.final_g0, g.final_g1, g.final_g2, g.final_g3,
             g.final_g4, g.final_g5, g.final_g6, g.final_g7plus
      FROM historical_matches m
      JOIN historical_spf s ON s.id = m.spf_id
      JOIN historical_hhad h ON h.id = m.hhad_id
      JOIN historical_goals g ON g.id = m.goals_id
      WHERE m.match_status = 'matched' AND m.goal_consistent = 1
      ORDER BY m.goals_source_file, m.goals_source_row
    `)
    .all()
    .map((row) => {
      const odds = [
        row.final_g0,
        row.final_g1,
        row.final_g2,
        row.final_g3,
        row.final_g4,
        row.final_g5,
        row.final_g6,
        row.final_g7plus,
      ];
      return {
        sourceFile: row.source_file,
        sourceRow: row.source_row,
        league: row.league,
        goals: row.actual_goals,
        initialOdds:
          row.initial_g0 &&
          row.initial_g1 &&
          row.initial_g2 &&
          row.initial_g3 &&
          row.initial_g4 &&
          row.initial_g5 &&
          row.initial_g6 &&
          row.initial_g7plus
            ? [
                row.initial_g0,
                row.initial_g1,
                row.initial_g2,
                row.initial_g3,
                row.initial_g4,
                row.initial_g5,
                row.initial_g6,
                row.initial_g7plus,
              ]
            : null,
        odds,
        market: normalizeOdds(odds),
      };
    });
}

function loadHhadRows(db) {
  return db
    .prepare(`
      SELECT m.hhad_source_file AS source_file,
             m.hhad_source_row AS source_row,
             h.league, h.handicap, h.result,
             h.initial_home_odds, h.initial_draw_odds, h.initial_away_odds,
             h.final_home_odds, h.final_draw_odds, h.final_away_odds
      FROM historical_matches m
      JOIN historical_spf s ON s.id = m.spf_id
      JOIN historical_hhad h ON h.id = m.hhad_id
      JOIN historical_goals g ON g.id = m.goals_id
      WHERE m.match_status = 'matched' AND m.goal_consistent = 1
      ORDER BY m.hhad_source_file, m.hhad_source_row
    `)
    .all()
    .map((row) => ({
      sourceFile: row.source_file,
      sourceRow: row.source_row,
      league: row.league,
      handicap: row.handicap,
      result: row.result,
      initialOdds:
        row.initial_home_odds &&
        row.initial_draw_odds &&
        row.initial_away_odds
          ? [
              row.initial_home_odds,
              row.initial_draw_odds,
              row.initial_away_odds,
            ]
          : null,
      odds: [
        row.final_home_odds,
        row.final_draw_odds,
        row.final_away_odds,
      ],
    }));
}

function weightingOptions(tolerance, floor, power) {
  return {
    enabled: Number(floor) < 1,
    tolerance,
    floor,
    power,
    coreRatio: 0.5,
  };
}

function runSpf(rows, warmup, tolerance, weightFloor, weightPower) {
  return walkForward(rows, {
    warmup,
    predict(target, history) {
      const similar = findSimilarSpf(history, target.odds, { tolerance });
      const movementSimilar = findSimilarSpfMovements(
        similar,
        target.initialOdds,
        target.odds,
        { finalTolerance: tolerance },
      );
      const model = predictSpfWithMovement(
        target.odds,
        similar,
        movementSimilar,
        target.initialOdds,
        {
          maxWeight: 0.05,
          applyCorrection: false,
          blendOptions: {
            empiricalOnly: true,
            weighting: weightingOptions(
              tolerance,
              weightFloor,
              weightPower,
            ),
          },
        },
      );
      const actualIndex = model.labels.indexOf(target.result);
      return {
        actualIndex,
        odds: target.odds,
        marketProbabilities: model.market,
        marketPredictionIndex: topIndex(model.market),
        baseModelProbabilities: model.baseline,
        baseModelPredictionIndex: topIndex(model.baseline),
        modelProbabilities: model.final,
        modelPredictionIndex: topIndex(model.final),
        sampleSize: similar.length,
        effectiveSampleSize: model.weighting.effectiveSamples,
        movementSampleSize: movementSimilar.length,
        movementApplied: model.movement.applied,
      };
    },
  });
}

export function runGoals(rows, warmup, tolerance, weightFloor, weightPower) {
  return walkForward(rows, {
    warmup,
    predict(target, history) {
      const similar = findPriorSimilarGoals(history, target.market, tolerance);
      const movementSimilar = findSimilarGoalMovements(
        similar,
        target.initialOdds,
        target.odds,
        { finalTolerance: tolerance },
      );
      const model = predictGoalsWithMovement(
        target.odds,
        similar,
        movementSimilar,
        target.initialOdds,
        {
          maxWeight: 0.03,
          applyCorrection: false,
          blendOptions: {
            empiricalOnly: true,
            weighting: weightingOptions(
              tolerance,
              weightFloor,
              weightPower,
            ),
          },
        },
      );
      const actualIndex = model.labels.indexOf(target.goals);
      return {
        actualIndex,
        odds: target.odds,
        marketProbabilities: model.market,
        marketPredictionIndex: topIndex(model.market),
        baseModelProbabilities: model.baseline,
        baseModelPredictionIndex: topIndex(model.baseline),
        modelProbabilities: model.final,
        modelPredictionIndex: topIndex(model.final),
        sampleSize: similar.length,
        effectiveSampleSize: model.weighting.effectiveSamples,
        movementSampleSize: movementSimilar.length,
        movementApplied: model.movement.applied,
      };
    },
  });
}

function runHhad(rows, warmup, tolerance, weightFloor, weightPower) {
  return walkForward(rows, {
    warmup,
    predict(target, history) {
      const sameHandicapHistory = history.filter(
        (row) => row.handicap === target.handicap,
      );
      const similar = findSimilarSpf(sameHandicapHistory, target.odds, {
        tolerance,
      });
      const movementSimilar = findSimilarSpfMovements(
        similar,
        target.initialOdds,
        target.odds,
        { finalTolerance: tolerance },
      );
      const model = predictSpfWithMovement(
        target.odds,
        similar,
        movementSimilar,
        target.initialOdds,
        {
          applyCorrection: false,
          blendOptions: {
            empiricalOnly: true,
            weighting: weightingOptions(
              tolerance,
              weightFloor,
              weightPower,
            ),
          },
        },
      );
      const actualIndex = model.labels.indexOf(target.result);
      return {
        actualIndex,
        odds: target.odds,
        marketProbabilities: model.market,
        marketPredictionIndex: topIndex(model.market),
        baseModelProbabilities: model.baseline,
        baseModelPredictionIndex: topIndex(model.baseline),
        modelProbabilities: model.final,
        modelPredictionIndex: topIndex(model.final),
        sampleSize: similar.length,
        effectiveSampleSize: model.weighting.effectiveSamples,
        movementSampleSize: movementSimilar.length,
        movementApplied: model.movement.applied,
      };
    },
  });
}

function summarize(run, { includeGoalPair = false } = {}) {
  const result = {
    sources: run.sources,
    samples: {
      median: median(run.cases.map((item) => item.sampleSize)),
      medianEffective: median(
        run.cases.map((item) => item.effectiveSampleSize),
      ),
      zero: run.cases.filter((item) => item.sampleSize === 0).length,
    },
    market: summarizeCases(
      run.cases,
      "marketProbabilities",
      "marketPredictionIndex",
    ),
    baseModel: summarizeCases(
      run.cases,
      "baseModelProbabilities",
      "baseModelPredictionIndex",
    ),
    model: summarizeCases(
      run.cases,
      "modelProbabilities",
      "modelPredictionIndex",
    ),
    movement: {
      applied: run.cases.filter((item) => item.movementApplied).length,
      medianSamples: median(
        run.cases
          .filter((item) => item.movementApplied)
          .map((item) => item.movementSampleSize),
      ),
    },
  };
  if (includeGoalPair) {
    result.topPair = summarizeGoalPairs(
      run.cases,
      "modelProbabilities",
    );
  }
  return result;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function printSection(title, result) {
  console.log(`\n${title}`);
  console.log(
    `有效回测 ${result.model.evaluated.toLocaleString()} 场；相似样本中位数 ${result.samples.median.toLocaleString()}；零样本 ${result.samples.zero.toLocaleString()} 场`,
  );
  console.log(
    `赔率基线  命中率 ${formatPercent(result.market.accuracy)}  LogLoss ${result.market.logLoss.toFixed(4)}  Brier ${result.market.brier.toFixed(4)}  单场平投ROI ${formatPercent(result.market.flatBetRoi)}`,
  );
  console.log(
    `基础融合  命中率 ${formatPercent(result.baseModel.accuracy)}  LogLoss ${result.baseModel.logLoss.toFixed(4)}  Brier ${result.baseModel.brier.toFixed(4)}  单场平投ROI ${formatPercent(result.baseModel.flatBetRoi)}`,
  );
  console.log(
    `最终模型  命中率 ${formatPercent(result.model.accuracy)}  LogLoss ${result.model.logLoss.toFixed(4)}  Brier ${result.model.brier.toFixed(4)}  单场平投ROI ${formatPercent(result.model.flatBetRoi)}；走势不参与概率`,
  );
  if (result.topPair) {
    console.log(
      `历史前两名双选  命中率 ${formatPercent(result.topPair.accuracy)}  平均覆盖概率 ${formatPercent(result.topPair.averageProbability)}  每场2注ROI ${formatPercent(result.topPair.flatBetRoi)}`,
    );
  }
}

function main() {
  const warmup = Number(argument("warmup", 500));
  const spfTolerance = Number(argument("spf-tolerance", 0.05));
  const goalTolerance = Number(argument("goal-tolerance", 0.01));
  const weightFloor = Number(argument("weight-floor", 1));
  const weightPower = Number(argument("weight-power", 1));
  const json = process.argv.includes("--json");

  const db = new DatabaseSync(DATABASE_PATH, { readOnly: true });
  try {
    const spfRun = runSpf(
      loadSpfRows(db),
      warmup,
      spfTolerance,
      weightFloor,
      weightPower,
    );
    const hhadRun = runHhad(
      loadHhadRows(db),
      warmup,
      spfTolerance,
      weightFloor,
      weightPower,
    );
    const goalRun = runGoals(
      loadGoalRows(db),
      warmup,
      goalTolerance,
      weightFloor,
      weightPower,
    );
    const result = {
      settings: {
        warmup,
        spfTolerance,
        goalTolerance,
        weightFloor,
        weightPower,
      },
      discipline:
        "每一场只使用同一来源文件中 source_row 更小的记录；不使用当前行或后续行",
      spf: summarize(spfRun),
      hhad: summarize(hhadRun),
      goals: summarize(goalRun, { includeGoalPair: true }),
    };

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("严格滚动回测");
      console.log(result.discipline);
      console.log(
        `参数：预热 ${warmup} 场 / 胜平负 ±${(spfTolerance * 100).toFixed(0)}% / 进球距离 ${(goalTolerance * 100).toFixed(1)}pp / 边缘保底权重 ${formatPercent(weightFloor)} / 衰减幂次 ${weightPower}`,
      );
      printSection("胜平负", result.spf);
      printSection("让球胜平负", result.hhad);
      printSection("总进球", result.goals);
    }
  } finally {
    db.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
