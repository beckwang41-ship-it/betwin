import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { buildThreeWayEvents } from "../lib/three-way-backtest.mjs";
import {
  THREE_WAY_MATCHING_VERSION,
  selectThreeWaySimilarity,
} from "../lib/three-way-matching.mjs";
import {
  V35_COMPARISON_PARAMETERS,
  v35Prediction,
  v35SmoothedSamples,
} from "../lib/v35-comparison.mjs";
import {
  blockBootstrapComparison,
  classificationDelta,
} from "../lib/significance.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const OUTPUT_PATH =
  process.env.BETWIN_METHOD_COMPARISON_PATH ||
  path.join(ROOT, "data", "three-way-method-comparison.json");
const SMOOTHING_OUTPUT_PATH =
  process.env.BETWIN_SMOOTHING_CONFIG_PATH ||
  path.join(ROOT, "data", "smoothing-config.json");
const MODEL_CONFIG_PATH = path.join(ROOT, "data", "model-config.json");
const LABELS = ["胜", "平", "负"];
const WARMUP = 500;
const VALIDATION_FRACTION = 0.2;
const DEFAULT_THRESHOLDS = { spf: 0.07, hhad: 0.07 };
let thresholds = { ...DEFAULT_THRESHOLDS };
const METHODS = [
  "current",
  "currentSmoothed",
  "v35Original",
  "v35Symmetric",
];
const COMPARISONS = {
  currentSmoothedVsCurrent: ["currentSmoothed", "current"],
  v35OriginalVsCurrent: ["v35Original", "current"],
  v35SymmetricVsCurrent: ["v35Symmetric", "current"],
  v35OriginalVsCurrentSmoothed: ["v35Original", "currentSmoothed"],
  v35SymmetricVsCurrentSmoothed: ["v35Symmetric", "currentSmoothed"],
};

function loadProductionThresholds(verifiedMatches, sourceUpdatedAt) {
  try {
    const config = JSON.parse(readFileSync(MODEL_CONFIG_PATH, "utf8"));
    const current =
      config.data?.verifiedMatches === verifiedMatches &&
      config.data?.sourceUpdatedAt === sourceUpdatedAt &&
      config.methodology?.matchingVersion === THREE_WAY_MATCHING_VERSION;
    if (!current) return { ...DEFAULT_THRESHOLDS };
    return Object.fromEntries(
      Object.entries(DEFAULT_THRESHOLDS).map(([market, fallback]) => {
        const value = Number(config.markets?.[market]?.threshold);
        return [market, Number.isFinite(value) && value > 0 ? value : fallback];
      }),
    );
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

function groupBySource(events) {
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.sourceFile)) groups.set(event.sourceFile, []);
    groups.get(event.sourceFile).push(event);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.sourceRow - right.sourceRow);
  }
  return groups;
}

function matchFromEvent(event) {
  return {
    had: event.spf
      ? { h: event.spf.odds[0], d: event.spf.odds[1], a: event.spf.odds[2] }
      : null,
    hhad: event.hhad
      ? {
          h: event.hhad.odds[0],
          d: event.hhad.odds[1],
          a: event.hhad.odds[2],
          goalLine: event.hhad.handicap,
        }
      : null,
  };
}

function uniformPrediction(samples) {
  if (!samples?.length) return null;
  const counts = [0, 0, 0];
  for (const sample of samples) {
    const index = LABELS.indexOf(String(sample.result));
    if (index >= 0) counts[index] += 1;
  }
  const total = counts.reduce((sum, value) => sum + value, 0);
  return total ? counts.map((value) => value / total) : null;
}

function emptyAccumulator() {
  return {
    targets: 0,
    evaluated: 0,
    correct: 0,
    logLoss: 0,
    brier: 0,
    sampleSizes: [],
    effectiveSamples: [],
    calibration: Array.from({ length: 10 }, () => ({
      count: 0,
      confidence: 0,
      correct: 0,
    })),
  };
}

function addCase(accumulator, prediction, actualIndex) {
  accumulator.evaluated += 1;
  accumulator.sampleSizes.push(prediction.sampleSize);
  accumulator.effectiveSamples.push(prediction.effectiveSamples);
  const probabilities = prediction.probabilities;
  const confidence = Math.max(...probabilities);
  const top = probabilities
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => Math.abs(value - confidence) < 1e-12);
  const topCorrect = top.some(({ index }) => index === actualIndex)
    ? 1 / top.length
    : 0;
  accumulator.correct += topCorrect;
  accumulator.logLoss -= Math.log(Math.max(1e-12, probabilities[actualIndex]));
  accumulator.brier += probabilities.reduce((sum, probability, index) => {
    const actual = index === actualIndex ? 1 : 0;
    return sum + (probability - actual) ** 2;
  }, 0);
  const bin = Math.min(9, Math.floor(confidence * 10));
  accumulator.calibration[bin].count += 1;
  accumulator.calibration[bin].confidence += confidence;
  accumulator.calibration[bin].correct += topCorrect;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function summarize(accumulator) {
  const evaluated = accumulator.evaluated;
  let calibrationError = 0;
  for (const bin of accumulator.calibration) {
    if (!bin.count || !evaluated) continue;
    calibrationError +=
      (bin.count / evaluated) *
      Math.abs(bin.correct / bin.count - bin.confidence / bin.count);
  }
  return {
    targets: accumulator.targets,
    evaluated,
    coverage: accumulator.targets ? evaluated / accumulator.targets : 0,
    accuracy: evaluated ? accumulator.correct / evaluated : 0,
    logLoss: evaluated ? accumulator.logLoss / evaluated : 0,
    brier: evaluated ? accumulator.brier / evaluated : 0,
    calibrationError,
    medianSamples: median(accumulator.sampleSizes),
    medianEffectiveSamples: median(accumulator.effectiveSamples),
  };
}

function emptyPeriod() {
  return Object.fromEntries(
    ["spf", "hhad"].map((market) => [
      market,
      {
        methods: Object.fromEntries(
          METHODS.map((method) => [method, emptyAccumulator()]),
        ),
        comparisons: Object.fromEntries(
          Object.keys(COMPARISONS).map((name) => [name, []]),
        ),
        currentModes: {},
      },
    ]),
  );
}

function predictionView(probabilities, sampleSize, effectiveSamples = sampleSize) {
  return probabilities
    ? { probabilities, sampleSize, effectiveSamples }
    : null;
}

function addMarketTarget(
  target,
  market,
  bucket,
  predictions,
  currentMode,
) {
  const actual = target[market]?.result;
  const actualIndex = LABELS.indexOf(String(actual));
  if (actualIndex < 0) return;
  const marketBucket = bucket[market];
  for (const method of METHODS) {
    const accumulator = marketBucket.methods[method];
    accumulator.targets += 1;
    if (predictions[method]) addCase(accumulator, predictions[method], actualIndex);
  }
  if (predictions.current && currentMode) {
    marketBucket.currentModes[currentMode] =
      (marketBucket.currentModes[currentMode] || 0) + 1;
  }
  for (const [name, [candidate, baseline]] of Object.entries(COMPARISONS)) {
    if (!predictions[candidate] || !predictions[baseline]) continue;
    marketBucket.comparisons[name].push(
      classificationDelta(
        predictions[candidate].probabilities,
        predictions[baseline].probabilities,
        actualIndex,
        { sourceFile: target.sourceFile, order: target.sourceRow },
      ),
    );
  }
}

function summarizeComparison(cases, bootstrap = false) {
  if (!cases.length) return null;
  const mean = (field) =>
    cases.reduce((sum, item) => sum + item[field], 0) / cases.length;
  return {
    evaluated: cases.length,
    delta: {
      accuracy: mean("accuracy"),
      logLoss: mean("logLoss"),
      brier: mean("brier"),
    },
    significance: bootstrap ? blockBootstrapComparison(cases) : null,
  };
}

function summarizePeriod(period, bootstrap = false) {
  return Object.fromEntries(
    Object.entries(period).map(([market, value]) => [
      market,
      {
        methods: Object.fromEntries(
          Object.entries(value.methods).map(([method, accumulator]) => [
            method,
            summarize(accumulator),
          ]),
        ),
        comparisons: Object.fromEntries(
          Object.entries(value.comparisons).map(([method, cases]) => [
            method,
            summarizeComparison(cases, bootstrap),
          ]),
        ),
        currentModes: value.currentModes,
      },
    ]),
  );
}

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function printPeriod(label, period) {
  console.log(`\n${label}`);
  for (const market of ["spf", "hhad"]) {
    console.log(market === "spf" ? "胜平负" : "让球胜平负");
    for (const method of METHODS) {
      const value = period[market].methods[method];
      console.log(
        `  ${method.padEnd(12)} 覆盖 ${formatPercent(value.coverage)} / ` +
          `命中 ${formatPercent(value.accuracy)} / LogLoss ${value.logLoss.toFixed(4)} / ` +
          `Brier ${value.brier.toFixed(4)} / ECE ${formatPercent(value.calibrationError)} / ` +
          `中位样本 ${value.medianSamples}`,
      );
    }
    for (const [name, comparison] of Object.entries(
      period[market].comparisons,
    )) {
      if (!comparison) continue;
      console.log(
        `  ${name}（共同 ${comparison.evaluated} 场）：` +
          `命中 ${comparison.delta.accuracy >= 0 ? "+" : ""}${formatPercent(comparison.delta.accuracy)} / ` +
          `LogLoss ${comparison.delta.logLoss >= 0 ? "+" : ""}${comparison.delta.logLoss.toFixed(4)} / ` +
          `Brier ${comparison.delta.brier >= 0 ? "+" : ""}${comparison.delta.brier.toFixed(4)}`,
      );
    }
  }
}

function smoothingMarketPolicy(report, market) {
  const tuningComparison =
    report.periods.tuning[market]?.comparisons.currentSmoothedVsCurrent;
  const comparison =
    report.periods.validation[market]?.comparisons.currentSmoothedVsCurrent;
  const significance = comparison?.significance || null;
  const improves = (value) =>
    Boolean(
      value?.evaluated > 0 &&
        value.delta.accuracy >= 0 &&
        value.delta.logLoss < 0 &&
        value.delta.brier < 0,
    );
  const tuningPassed = improves(tuningComparison);
  const validationPassed = improves(comparison);
  const enabled = Boolean(
    market === "hhad" &&
      tuningPassed &&
      validationPassed &&
      significance?.passed,
  );
  const reason = enabled
    ? "当前联合匹配池的动态贝叶斯平滑通过较早段、最新20%及95%连续区块Bootstrap门禁"
    : market === "spf"
      ? "SPF 平滑虽改善 Log Loss 和 Brier，但命中率95%区间仍包含下降，生产保持原始历史占比"
      : market === "hhad"
        ? "HHAD 平滑虽改善平均命中率、Log Loss 和 Brier，但命中率95%区间仍包含下降，生产保持原始历史占比"
        : "本轮未评估该市场的动态贝叶斯平滑，生产保持原始历史占比";
  return {
    strength: enabled ? "dynamic" : 0,
    candidateStrength: "clamp(20 / N, 1, 20)",
    gate: {
      passed: enabled,
      tuningPassed,
      validationPassed,
      significancePassed: Boolean(significance?.passed),
      reason,
    },
    production: {
      enabled,
      strength: 0,
      referenceStrength: 0,
      strengthMode: enabled ? "inverse-samples" : "fixed",
      dynamicNumerator: 20,
      minStrength: 1,
      maxStrength: 20,
      priorMode: market === "hhad" ? "adjusted-market" : "historical",
      relaxedMultiplier: 2,
      minLocalizedSamples: 30,
    },
    selected: {
      comparison: "currentSmoothedVsCurrent",
      validationComparison: comparison,
      significance,
    },
  };
}

const store = createDataStore(DATABASE_PATH);
try {
  const counts = store.getCounts();
  const sourceUpdatedAt = store.getHistoricalSourceUpdatedAt();
  thresholds = loadProductionThresholds(
    counts.verifiedHistory,
    sourceUpdatedAt,
  );
  const spfHistory = store.getSpfHistory();
  const hhadHistory = store.getHhadHistory();
  const pairedHistory = store.getPairedSpfHhadHistory();
  const events = buildThreeWayEvents({ spfHistory, hhadHistory, pairedHistory });
  const periods = { tuning: emptyPeriod(), validation: emptyPeriod() };
  const sources = [];

  for (const [sourceFile, group] of groupBySource(events)) {
    const validationStart = Math.max(
      WARMUP + 1,
      Math.floor(group.length * (1 - VALIDATION_FRACTION)),
    );
    const prior = { spfHistory: [], hhadHistory: [], pairedHistory: [] };
    for (let index = 0; index < group.length; index += 1) {
      const target = group[index];
      if (index >= WARMUP) {
        const period = index >= validationStart ? "validation" : "tuning";
        const current = selectThreeWaySimilarity(
          matchFromEvent(target),
          prior,
          {
            spfTolerance: thresholds.spf,
            hhadTolerance: thresholds.hhad,
          },
        );
        for (const market of ["spf", "hhad"]) {
          if (!target[market]) continue;
          const currentSamples = current[market]?.similar || [];
          const currentProbabilities = uniformPrediction(currentSamples);
          const currentSmoothed = v35SmoothedSamples(
            currentSamples,
            target[market],
            market,
            { weighted: false },
          );
          const original = v35Prediction(
            prior[`${market}History`],
            target[market],
            market,
            { historyProbabilityMode: "original" },
          );
          const symmetric = v35Prediction(
            prior[`${market}History`],
            target[market],
            market,
            { historyProbabilityMode: "symmetric" },
          );
          addMarketTarget(target, market, periods[period], {
            current: predictionView(
              currentProbabilities,
              currentSamples.length,
            ),
            currentSmoothed: currentSmoothed
              ? predictionView(
                  currentSmoothed.probabilities,
                  currentSamples.length,
                  currentSmoothed.effectiveSamples,
                )
              : null,
            v35Original: original
              ? predictionView(
                  original.probabilities,
                  original.sampleSize,
                  original.effectiveSamples,
                )
              : null,
            v35Symmetric: symmetric
              ? predictionView(
                  symmetric.probabilities,
                  symmetric.sampleSize,
                  symmetric.effectiveSamples,
                )
              : null,
          }, current[market]?.mode || null);
        }
      }
      if (target.spf) prior.spfHistory.push(target.spf);
      if (target.hhad) prior.hhadHistory.push(target.hhad);
      if (target.pair) prior.pairedHistory.push(target.pair);
    }
    sources.push({
      sourceFile,
      rows: group.length,
      warmup: Math.min(group.length, WARMUP),
      validationStart,
    });
  }

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    data: {
      database: path.basename(DATABASE_PATH),
      sourceUpdatedAt,
      spfHistory: spfHistory.length,
      hhadHistory: hhadHistory.length,
      pairedHistory: pairedHistory.length,
      events: events.length,
    },
    methodology: {
      matchingVersion: THREE_WAY_MATCHING_VERSION,
      ordering: "按 source_file 分组、source_row 递增；每个目标只读取更早行",
      warmup: WARMUP,
      validationFraction: VALIDATION_FRACTION,
      current:
        `生产匹配器：SPF ${Math.round(thresholds.spf * 100)}% / HHAD ${Math.round(thresholds.hhad * 100)}% 联合优先，联合零样本时独立回退，样本等权`,
      currentSmoothed:
        "生产匹配池保持不变，套用与V35相同的动态贝叶斯平滑；用于剥离V35优势中仅由平滑产生的部分",
      v35Original:
        "V35 独立市场、同盘口、联赛/联赛档、胜负赔15%预筛、概率结构+胜负走势距离、Top20、时间衰减、动态贝叶斯平滑；保留原代码目标RTP修正/历史普通去水的不对称口径",
      v35Symmetric:
        "与 V35 原版相同，但当前和历史赔率统一使用对应市场的RTP修正，用于诊断转换不对称的影响",
      comparison:
        "覆盖率按各自全部目标计算；差值仅在双方均有预测的共同样本上计算；最新20%另做连续20场区块Bootstrap",
      calibration: "10档最高预测概率 ECE",
    },
    thresholds,
    v35Parameters: V35_COMPARISON_PARAMETERS,
    sources,
    periods: {
      tuning: summarizePeriod(periods.tuning),
      validation: summarizePeriod(periods.validation, true),
    },
  };

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const smoothingConfig = {
    version: 2,
    generatedAt: report.generatedAt,
    data: {
      database: path.basename(DATABASE_PATH),
      verifiedMatches: counts.verifiedHistory,
      sourceUpdatedAt: report.data.sourceUpdatedAt,
    },
    methodology: {
      matchingVersion: THREE_WAY_MATCHING_VERSION,
      ordering: report.methodology.ordering,
      warmup: WARMUP,
      validationFraction: VALIDATION_FRACTION,
      selection:
        "较早段和最新20%均对比当前联合匹配裸占比；只有最新段95%连续区块Bootstrap通过才启用",
      formula:
        "(N × 原始历史概率 + C × 先验概率) / (N + C)，C = clamp(20 / N, 1, 20)",
      prior:
        "HHAD使用当前让球赔率的RTP修正去水概率；SPF本轮未通过严格门禁，不应用平滑",
      fallback: "相似样本为0时仍不预测，平滑不作为零样本兜底",
    },
    searchSpace: {
      thresholds,
      strengthMode: "inverse-samples",
      dynamicNumerator: 20,
      minStrength: 1,
      maxStrength: 20,
    },
    markets: {
      spf: smoothingMarketPolicy(report, "spf"),
      hhad: smoothingMarketPolicy(report, "hhad"),
      goals: smoothingMarketPolicy(report, "goals"),
    },
  };
  mkdirSync(path.dirname(SMOOTHING_OUTPUT_PATH), { recursive: true });
  writeFileSync(
    SMOOTHING_OUTPUT_PATH,
    `${JSON.stringify(smoothingConfig, null, 2)}\n`,
    "utf8",
  );
  printPeriod("较早80%评估段", report.periods.tuning);
  printPeriod("最新20%验证段", report.periods.validation);
  console.log(`\n报告已写入 ${OUTPUT_PATH}`);
  console.log(`平滑配置已写入 ${SMOOTHING_OUTPUT_PATH}`);
} finally {
  store.close();
}
