import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findSimilarSpfMovements,
  findSimilarSpf,
  predictSpfWithMovement,
} from "../lib/predictor.mjs";
import {
  predictProductionGoals,
  selectProductionGoalSimilarity,
} from "../lib/goal-production.mjs";
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
      SELECT source_file, source_row, league, actual_goals,
             initial_g0, initial_g1, initial_g2, initial_g3,
             initial_g4, initial_g5, initial_g6, initial_g7plus,
             final_g0, final_g1, final_g2, final_g3,
             final_g4, final_g5, final_g6, final_g7plus
      FROM historical_goals
      ORDER BY source_file, source_row
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

export function runGoals(rows, warmup, similarityOptions = {}) {
  return walkForward(rows, {
    warmup,
    predict(target, history) {
      const resolved = selectProductionGoalSimilarity(
        history,
        target,
        similarityOptions,
      );
      const model = predictProductionGoals(target.odds, resolved, {
        blendOptions: { empiricalOnly: true, requireSamples: true },
      });
      const actualIndex = model.labels.indexOf(target.goals);
      return {
        actualIndex,
        odds: target.odds,
        marketProbabilities: model.market,
        marketPredictionIndex: topIndex(model.market),
        baseModelProbabilities: model.final,
        baseModelPredictionIndex: topIndex(model.final),
        modelProbabilities: model.final,
        modelPredictionIndex: topIndex(model.final),
        sampleSize: resolved.similar.length,
        effectiveSampleSize: model.weighting.effectiveSamples,
        movementSampleSize: 0,
        movementApplied: false,
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
  const modeledCases = run.cases.filter((item) => item.sampleSize > 0);
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
      modeledCases,
      "baseModelProbabilities",
      "baseModelPredictionIndex",
    ),
    model: summarizeCases(
      modeledCases,
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
      modeledCases,
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
    const goalRun = runGoals(loadGoalRows(db), warmup);
    const result = {
      settings: {
        warmup,
        spfTolerance,
        goalMatching: "0球赔率±2.00＋综合距离指数加权",
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
        `参数：预热 ${warmup} 场 / 胜平负 ±${(spfTolerance * 100).toFixed(0)}% / 总进球0球赔率±2.00并按综合距离指数加权 / 三项盘边缘保底权重 ${formatPercent(weightFloor)} / 衰减幂次 ${weightPower}`,
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
