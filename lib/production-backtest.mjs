import { selectThreeWaySimilarity } from "./three-way-matching.mjs";
import { predictSpf } from "./predictor.mjs";
import { FORMAL_PRODUCTION_THRESHOLDS } from "./reliability-validation.mjs";
import { historyTimelines } from "./history-timeline.mjs";

// 每日增量按数据库批次评估；旧累加文件保留各自的顺序。
export function runProductionThreeWay(events, {
  warmup = 500,
  spfTolerance = FORMAL_PRODUCTION_THRESHOLDS.spf,
  hhadTolerance = FORMAL_PRODUCTION_THRESHOLDS.hhad,
  includeSameLeague = false,
} = {}) {
  const cases = [], sources = [];
  for (const { sourceFile, seed, batches } of historyTimelines(events)) {
    const group = batches.flat();
    const pools = { spfHistory: [], hhadHistory: [], pairedHistory: [] };
    const append = (target) => {
      if (target.spf) pools.spfHistory.push(target.spf);
      if (target.hhad) pools.hhadHistory.push(target.hhad);
      if (target.pair) pools.pairedHistory.push(target.pair);
    };
    seed.forEach(append);
    let seen = seed.length, i = 0, evaluated = 0;
    for (const batch of batches) {
      for (const target of batch) {
        if (seen >= warmup) {
          evaluated++;
          const match = { league: target.league,
            had: target.spf ? { h: target.spf.odds[0], d: target.spf.odds[1], a: target.spf.odds[2] } : null,
            hhad: target.hhad ? { h: target.hhad.odds[0], d: target.hhad.odds[1], a: target.hhad.odds[2], goalLine: target.hhad.handicap } : null };
          const selection = selectThreeWaySimilarity(match, pools, { spfTolerance, hhadTolerance });
          // Scope changes only the weights/pool, not which target is evaluated.
          const local = includeSameLeague
            ? selectThreeWaySimilarity(match, pools, { spfTolerance, hhadTolerance, sameLeague: true }) : null;
          for (const market of ["spf", "hhad"]) {
            if (!target[market]) continue;
            const model = predictSpf(target[market].odds, selection[market]?.similar || [], { empiricalOnly: true, requireSamples: true });
            const localModel = local ? predictSpf(target[market].odds, local[market]?.similar || [], { empiricalOnly: true, requireSamples: true }) : null;
            const actualIndex = model.labels.indexOf(String(target[market].result));
            if (actualIndex < 0) continue;
            cases.push({ sourceFile: target.sourceFile, sourceRow: target.sourceRow, index: i, sourceLength: group.length,
              historyBatchId: target.historyBatchId || 0,
              fixtureId: target.fixtureId || `${sourceFile}:${target.sourceRow}`, league: target.league, market,
              actualIndex, odds: target[market].odds,
              marketProbabilities: model.market, marketPredictionIndex: model.market.indexOf(Math.max(...model.market)),
              baseModelProbabilities: model.final, baseModelPredictionIndex: model.labels.indexOf(model.predicted),
              modelProbabilities: model.final, modelPredictionIndex: model.labels.indexOf(model.predicted),
              sampleSize: model.stats.total, effectiveSampleSize: model.weighting.effectiveSamples,
              localProbabilities: localModel?.available ? localModel.final : null,
              localCounts: localModel ? model.labels.map(label => localModel.stats.counts[label]) : null,
              localSamples: localModel?.stats.total || 0, movementApplied: false, movementSampleSize: 0 });
          }
        }
        i++;
      }
      batch.forEach(append);
      seen += batch.length;
    }
    sources.push({ sourceFile, rows: group.length, skippedAsWarmup: group.length - evaluated, evaluated });
  }
  return { cases, sources, warmup };
}
