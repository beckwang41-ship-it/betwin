import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { buildThreeWayEvents } from "../lib/three-way-backtest.mjs";
import { runProductionThreeWay } from "../lib/production-backtest.mjs";
import { HISTORY_TIMELINE_VERSION } from "../lib/history-timeline.mjs";
import { FORMAL_PRODUCTION_THRESHOLDS } from "../lib/reliability-validation.mjs";
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

export function loadGoalRows(db) {
  return db
    .prepare(`
      SELECT id, history_batch_id, source_file, source_row, league, actual_goals,
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
        historyId: row.id,
        historyBatchId: row.history_batch_id,
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

export function summarize(run, { includeGoalPair = false } = {}) {
  const modeledCases = run.cases.filter((item) => item.sampleSize > 0);
  const result = {
    sources: run.sources,
    targets: run.cases.length,
    coverage: run.cases.length ? modeledCases.length / run.cases.length : 0,
    samples: {
      median: median(run.cases.map((item) => item.sampleSize)),
      medianEffective: median(
        run.cases.map((item) => item.effectiveSampleSize),
      ),
      zero: run.cases.filter((item) => item.sampleSize === 0).length,
    },
    market: summarizeCases(
      modeledCases,
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
  const spfTolerance = Number(argument("spf-tolerance", FORMAL_PRODUCTION_THRESHOLDS.spf));
  const weightFloor = Number(argument("weight-floor", 1));
  const weightPower = Number(argument("weight-power", 1));
  const json = process.argv.includes("--json");

  const db = new DatabaseSync(DATABASE_PATH, { readOnly: true });
  try {
    if (weightFloor !== 1 || weightPower !== 1) throw new Error("正式回测使用生产等权口径；加权候选请使用研究入口");
    const store = createDataStore(DATABASE_PATH);
    let threeWay;
    try {
      threeWay = runProductionThreeWay(buildThreeWayEvents({
        spfHistory: store.getSpfHistory(), hhadHistory: store.getHhadHistory(),
        pairedHistory: store.getPairedSpfHhadHistory(),
      }), { warmup, spfTolerance, hhadTolerance: spfTolerance });
    } finally { store.close(); }
    const spfRun = { ...threeWay, cases: threeWay.cases.filter(row => row.market === "spf") };
    const hhadRun = { ...threeWay, cases: threeWay.cases.filter(row => row.market === "hhad") };
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
        `${HISTORY_TIMELINE_VERSION}：每日增量按数据库入库批次；整批预测后才加入训练；旧累加文件各自按原有顺序回测`,
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
