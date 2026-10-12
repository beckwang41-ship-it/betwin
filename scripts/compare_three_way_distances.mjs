import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { buildThreeWayEvents } from "../lib/three-way-backtest.mjs";
import {
  THREE_WAY_DISTANCE_METHODS,
  threeWayOddsDistance,
} from "../lib/three-way-distance.mjs";
import { THREE_WAY_MATCHING_VERSION } from "../lib/three-way-matching.mjs";
import { applyZeroCellFloor } from "../lib/smoothing.mjs";
import {
  blockBootstrapComparison,
  classificationDelta,
} from "../lib/significance.mjs";
import {
  blockBootstrapStrategyComparison,
  pairedStrategyCase,
} from "../lib/strategy-evaluation.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const OUTPUT_PATH =
  process.env.BETWIN_THREE_WAY_DISTANCE_REPORT_PATH ||
  path.join(ROOT, "data", "three-way-distance-comparison.json");
const LABELS = ["胜", "平", "负"];
const SCOPES = ["all", "sameLeague"];
const MARKETS = ["spf", "hhad"];
const WARMUP = 500;
const SPLITS = { tuningEnd: 0.6, validationEnd: 0.8 };
const COVERAGE_BAND = 0.03;
const BASELINE = {
  id: "relative-max@0.07",
  method: "relative-max",
  threshold: 0.07,
  baseline: true,
};
const THRESHOLD_GRIDS = {
  "log-max": [0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1],
  hellinger: [0.005, 0.0075, 0.01, 0.0125, 0.015, 0.02, 0.025, 0.03, 0.04],
  "jensen-shannon": [
    0.005,
    0.0075,
    0.01,
    0.0125,
    0.015,
    0.02,
    0.025,
    0.03,
    0.04,
  ],
};

function definition(method, threshold) {
  return {
    id: `${method}@${threshold}`,
    method,
    threshold,
    baseline: false,
  };
}

const CANDIDATES = Object.entries(THRESHOLD_GRIDS).flatMap(
  ([method, thresholds]) => thresholds.map((threshold) => definition(method, threshold)),
);
const DEFINITIONS = [BASELINE, ...CANDIDATES];

function groupBySource(events) {
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.sourceFile)) groups.set(event.sourceFile, []);
    groups.get(event.sourceFile).push(event);
  }
  for (const rows of groups.values()) {
    rows.sort((left, right) => left.sourceRow - right.sourceRow);
  }
  return groups;
}

function periodFor(index, length) {
  if (index < WARMUP) return "warmup";
  if (index < Math.floor(length * SPLITS.tuningEnd)) return "tuning";
  if (index < Math.floor(length * SPLITS.validationEnd)) return "validation";
  return "test";
}

function emptyMetrics() {
  return {
    targets: 0,
    evaluated: 0,
    correct: 0,
    logLoss: 0,
    brier: 0,
    sampleTotal: 0,
    calibration: Array.from({ length: 10 }, () => ({
      count: 0,
      confidence: 0,
      correct: 0,
    })),
  };
}

function emptyEvaluation(definitions, withCases = false) {
  return Object.fromEntries(
    SCOPES.map((scope) => [
      scope,
      Object.fromEntries(
        MARKETS.map((market) => [
          market,
          {
            metrics: Object.fromEntries(
              definitions.map((item) => [item.id, emptyMetrics()]),
            ),
            cases: withCases
              ? Object.fromEntries(
                  definitions
                    .filter((item) => !item.baseline)
                    .map((item) => [item.id, []]),
                )
              : null,
            strategyCases: withCases
              ? Object.fromEntries(
                  definitions
                    .filter((item) => !item.baseline)
                    .map((item) => [item.id, []]),
                )
              : null,
          },
        ]),
      ),
    ]),
  );
}

function probabilitiesFromCounts(counts) {
  const total = counts.reduce((sum, value) => sum + value, 0);
  return total ? applyZeroCellFloor(counts).probabilities : null;
}

function addMetrics(metrics, prediction, actualIndex, sampleSize) {
  metrics.targets += 1;
  if (!prediction) return;
  metrics.evaluated += 1;
  metrics.sampleTotal += sampleSize;
  const confidence = Math.max(...prediction);
  const top = prediction
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => Math.abs(value - confidence) <= 1e-12);
  const correct = top.some(({ index }) => index === actualIndex)
    ? 1 / top.length
    : 0;
  metrics.correct += correct;
  metrics.logLoss -= Math.log(Math.max(1e-12, prediction[actualIndex]));
  metrics.brier += prediction.reduce((sum, probability, index) => {
    const actual = index === actualIndex ? 1 : 0;
    return sum + (probability - actual) ** 2;
  }, 0);
  const bin = Math.min(9, Math.floor(confidence * 10));
  metrics.calibration[bin].count += 1;
  metrics.calibration[bin].confidence += confidence;
  metrics.calibration[bin].correct += correct;
}

function summarizeMetrics(metrics) {
  const evaluated = metrics.evaluated;
  let calibrationError = 0;
  for (const bin of metrics.calibration) {
    if (!bin.count || !evaluated) continue;
    calibrationError +=
      (bin.count / evaluated) *
      Math.abs(bin.correct / bin.count - bin.confidence / bin.count);
  }
  return {
    targets: metrics.targets,
    evaluated,
    coverage: metrics.targets ? evaluated / metrics.targets : 0,
    accuracy: evaluated ? metrics.correct / evaluated : 0,
    logLoss: evaluated ? metrics.logLoss / evaluated : 0,
    brier: evaluated ? metrics.brier / evaluated : 0,
    calibrationError,
    meanSamples: evaluated ? metrics.sampleTotal / evaluated : 0,
  };
}

function emptyCounts(definitions) {
  return Object.fromEntries(
    definitions.map((item) => [
      item.id,
      Object.fromEntries(
        SCOPES.map((scope) => [
          scope,
          { spf: [0, 0, 0], hhad: [0, 0, 0] },
        ]),
      ),
    ]),
  );
}

function increment(counts, definitionId, scope, market, result) {
  const index = LABELS.indexOf(String(result));
  if (index >= 0) counts[definitionId][scope][market][index] += 1;
}

function matchingCounts(target, prior, definitions) {
  const counts = emptyCounts(definitions);
  if (target.spf && target.hhad) {
    for (const row of prior.pairedHistory) {
      if (Number(row.hhad.handicap) !== Number(target.hhad.handicap)) continue;
      const sameLeague = row.spf.league === target.league;
      for (const item of definitions) {
        const spfDistance = threeWayOddsDistance(
          row.spf.odds,
          target.spf.odds,
          item.method,
        );
        if (spfDistance > item.threshold) continue;
        const hhadDistance = threeWayOddsDistance(
          row.hhad.odds,
          target.hhad.odds,
          item.method,
        );
        if (hhadDistance > item.threshold) continue;
        increment(counts, item.id, "all", "spf", row.spf.result);
        increment(counts, item.id, "all", "hhad", row.hhad.result);
        if (sameLeague) {
          increment(counts, item.id, "sameLeague", "spf", row.spf.result);
          increment(counts, item.id, "sameLeague", "hhad", row.hhad.result);
        }
      }
    }
    return counts;
  }

  if (target.spf) {
    for (const row of prior.spfHistory) {
      const sameLeague = row.league === target.league;
      for (const item of definitions) {
        const distance = threeWayOddsDistance(
          row.odds,
          target.spf.odds,
          item.method,
        );
        if (distance > item.threshold) continue;
        increment(counts, item.id, "all", "spf", row.result);
        if (sameLeague) {
          increment(counts, item.id, "sameLeague", "spf", row.result);
        }
      }
    }
  }
  if (target.hhad) {
    for (const row of prior.hhadHistory) {
      if (Number(row.handicap) !== Number(target.hhad.handicap)) continue;
      const sameLeague = row.league === target.league;
      for (const item of definitions) {
        const distance = threeWayOddsDistance(
          row.odds,
          target.hhad.odds,
          item.method,
        );
        if (distance > item.threshold) continue;
        increment(counts, item.id, "all", "hhad", row.result);
        if (sameLeague) {
          increment(counts, item.id, "sameLeague", "hhad", row.result);
        }
      }
    }
  }
  return counts;
}

function updatePrior(prior, target) {
  if (target.spf) prior.spfHistory.push(target.spf);
  if (target.hhad) prior.hhadHistory.push(target.hhad);
  if (target.pair) prior.pairedHistory.push(target.pair);
}

function evaluate(
  groups,
  definitions,
  periods,
  { withCases = false } = {},
) {
  const output = Object.fromEntries(
    periods.map((period) => [period, emptyEvaluation(definitions, withCases)]),
  );
  for (const rows of groups.values()) {
    const prior = { spfHistory: [], hhadHistory: [], pairedHistory: [] };
    for (let index = 0; index < rows.length; index += 1) {
      const target = rows[index];
      const period = periodFor(index, rows.length);
      if (periods.includes(period)) {
        const counts = matchingCounts(target, prior, definitions);
        for (const scope of SCOPES) {
          for (const market of MARKETS) {
            const actualIndex = LABELS.indexOf(String(target[market]?.result));
            if (actualIndex < 0) continue;
            const predictions = new Map();
            for (const item of definitions) {
              const values = counts[item.id][scope][market];
              const sampleSize = values.reduce((sum, value) => sum + value, 0);
              const prediction = probabilitiesFromCounts(values);
              predictions.set(item.id, prediction);
              addMetrics(
                output[period][scope][market].metrics[item.id],
                prediction,
                actualIndex,
                sampleSize,
              );
            }
            if (!withCases) continue;
            const baseline = predictions.get(BASELINE.id);
            if (!baseline) continue;
            for (const item of definitions) {
              if (item.baseline) continue;
              const candidate = predictions.get(item.id);
              if (!candidate) continue;
              output[period][scope][market].cases[item.id].push(
                classificationDelta(candidate, baseline, actualIndex, {
                  sourceFile: target.sourceFile,
                  order: target.sourceRow,
                }),
              );
              output[period][scope][market].strategyCases[item.id].push(
                pairedStrategyCase(
                  candidate,
                  baseline,
                  target[market].odds,
                  actualIndex,
                  { sourceFile: target.sourceFile, order: target.sourceRow },
                ),
              );
            }
          }
        }
      }
      updatePrior(prior, target);
    }
  }
  return output;
}

function summarizeEvaluation(evaluation) {
  return Object.fromEntries(
    SCOPES.map((scope) => [
      scope,
      Object.fromEntries(
        MARKETS.map((market) => [
          market,
          Object.fromEntries(
            Object.entries(evaluation[scope][market].metrics).map(
              ([id, metrics]) => [id, summarizeMetrics(metrics)],
            ),
          ),
        ]),
      ),
    ]),
  );
}

function candidateScore(candidate, baseline) {
  return (
    candidate.accuracy - baseline.accuracy -
    Math.max(0, candidate.logLoss - baseline.logLoss) -
    Math.max(0, candidate.brier - baseline.brier) / 2 -
    Math.abs(candidate.coverage - baseline.coverage) / 4
  );
}

function selectThresholds(tuning) {
  const selected = {};
  for (const scope of SCOPES) {
    selected[scope] = {};
    for (const market of MARKETS) {
      selected[scope][market] = {};
      const metrics = tuning[scope][market];
      const baseline = metrics[BASELINE.id];
      for (const method of THREE_WAY_DISTANCE_METHODS.filter(
        (value) => value !== BASELINE.method,
      )) {
        const choices = CANDIDATES.filter((item) => item.method === method).map(
          (item) => ({
            ...item,
            metrics: metrics[item.id],
            coverageGap: Math.abs(
              metrics[item.id].coverage - baseline.coverage,
            ),
            score: candidateScore(metrics[item.id], baseline),
          }),
        );
        const coverageMatched = choices.filter(
          (item) => item.coverageGap <= COVERAGE_BAND,
        );
        selected[scope][market][method] = (coverageMatched.length
          ? coverageMatched
          : choices
        ).sort(
          (left, right) =>
            right.score - left.score ||
            left.coverageGap - right.coverageGap ||
            left.threshold - right.threshold,
        )[0];
      }
    }
  }
  return selected;
}

function uniqueSelectedDefinitions(selections) {
  const values = new Map([[BASELINE.id, BASELINE]]);
  for (const scopes of Object.values(selections)) {
    for (const markets of Object.values(scopes)) {
      for (const item of Object.values(markets)) values.set(item.id, item);
    }
  }
  return [...values.values()].map(({ metrics, coverageGap, score, ...item }) => item);
}

function gatesFor(selections, evaluations, summaries) {
  const gates = {};
  for (const scope of SCOPES) {
    gates[scope] = {};
    for (const market of MARKETS) {
      gates[scope][market] = {};
      for (const [method, selected] of Object.entries(
        selections[scope][market],
      )) {
        const validationBucket = evaluations.validation[scope][market];
        const testBucket = evaluations.test[scope][market];
        const probabilityGate = blockBootstrapComparison(
          validationBucket.cases[selected.id] || [],
        );
        const roiGate = blockBootstrapStrategyComparison(
          validationBucket.strategyCases[selected.id] || [],
        );
        gates[scope][market][method] = {
          selected: {
            id: selected.id,
            method: selected.method,
            threshold: selected.threshold,
            tuningScore: selected.score,
            tuningCoverageGap: selected.coverageGap,
          },
          validation: {
            baseline: summaries.validation[scope][market][BASELINE.id],
            candidate: summaries.validation[scope][market][selected.id],
            probabilityGate,
            roiGate,
          },
          latest20Diagnostic: {
            baseline: summaries.test[scope][market][BASELINE.id],
            candidate: summaries.test[scope][market][selected.id],
            probabilityComparison: blockBootstrapComparison(
              testBucket.cases[selected.id] || [],
            ),
            roiComparison: blockBootstrapStrategyComparison(
              testBucket.strategyCases[selected.id] || [],
            ),
          },
          eligibleForProduction:
            probabilityGate.passed && roiGate.passed && roiGate.positiveEdge,
          requiresManualApproval: true,
        };
      }
    }
  }
  return gates;
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "—";
}

const store = createDataStore(DATABASE_PATH);
try {
  const counts = store.getCounts();
  const sourceUpdatedAt = store.getHistoricalSourceUpdatedAt();
  const events = buildThreeWayEvents({
    spfHistory: store.getSpfHistory(),
    hhadHistory: store.getHhadHistory(),
    pairedHistory: store.getPairedSpfHhadHistory(),
  });
  const groups = groupBySource(events);
  console.log("第一阶段：使用较早60%按覆盖率与概率质量选择各距离阈值");
  const tuningEvaluation = evaluate(groups, DEFINITIONS, ["tuning"]);
  const tuningSummary = summarizeEvaluation(tuningEvaluation.tuning);
  const selections = selectThresholds(tuningSummary);
  const selectedDefinitions = uniqueSelectedDefinitions(selections);

  console.log("第二阶段：固定阈值，在中间20%验证并报告最新20%诊断");
  const laterEvaluations = evaluate(
    groups,
    selectedDefinitions,
    ["validation", "test"],
    { withCases: true },
  );
  const summaries = {
    tuning: tuningSummary,
    validation: summarizeEvaluation(laterEvaluations.validation),
    test: summarizeEvaluation(laterEvaluations.test),
  };
  const gates = gatesFor(selections, laterEvaluations, summaries);
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    reportOnly: true,
    affectsProduction: false,
    data: {
      database: path.basename(DATABASE_PATH),
      verifiedMatches: counts.verifiedHistory,
      sourceUpdatedAt,
      matchingVersion: THREE_WAY_MATCHING_VERSION,
      events: events.length,
    },
    methodology: {
      ordering:
        "每个来源文件严格按source_row递增；每个目标仅使用同来源中更早的记录",
      timeProxy:
        "历史文件第一行最旧、最后一行最新；本报告只依赖先后顺序，不要求真实日期",
      split:
        "前500场预热；其后较早60%选择阈值，中间20%执行门禁，最新20%仅作已观察诊断",
      matching:
        "与当前生产一致：SPF和HHAD同时存在时只使用让球数一致且两个玩法同时入池的配对样本；联合为零不独立回退",
      probability:
        "候选与基线均直接统计各玩法原始赛果，并应用固定总先验质量1.5的防零层",
      thresholdSelection:
        `每种距离只在较早段选阈值；优先保持与±7%基线覆盖率相差不超过${(
          COVERAGE_BAND * 100
        ).toFixed(0)}个百分点，再比较命中率、Log Loss、Brier和覆盖差`,
      probabilityGate:
        "中间20%共同覆盖比赛使用连续20场区块Bootstrap；Log Loss、Brier显著改善且命中率不下降才通过",
      roiGate:
        "中间20%按实际终赔计算单选/并列多选成本；ROI差值95%区间高于0且候选自身正收益区间下界高于0才具备正收益证据",
      production:
        "本命令只生成研究报告，不修改匹配器、阈值或生产批准；即使门禁通过仍需真正未来样本与人工批准",
    },
    baseline: BASELINE,
    thresholdGrids: THRESHOLD_GRIDS,
    selections,
    gates,
    periods: summaries,
    sources: [...groups.entries()].map(([sourceFile, rows]) => ({
      sourceFile,
      rows: rows.length,
      minimumSourceRow: rows[0]?.sourceRow || null,
      maximumSourceRow: rows.at(-1)?.sourceRow || null,
    })),
  };
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  for (const scope of SCOPES) {
    console.log(scope === "all" ? "\n全部联赛" : "\n同联赛");
    for (const market of MARKETS) {
      console.log(market === "spf" ? "胜平负" : "让球胜平负");
      for (const [method, result] of Object.entries(gates[scope][market])) {
        const base = result.validation.baseline;
        const candidate = result.validation.candidate;
        console.log(
          `  ${method} ${result.selected.threshold}: ` +
            `${formatPercent(base.accuracy)} → ${formatPercent(candidate.accuracy)}, ` +
            `覆盖 ${formatPercent(candidate.coverage)}, ` +
            `${result.eligibleForProduction ? "满足研究门禁" : "未满足研究门禁"}`,
        );
      }
    }
  }
  console.log(`\n研究报告已写入 ${OUTPUT_PATH}`);
  console.log("生产预测未发生变化。");
} finally {
  store.close();
}
