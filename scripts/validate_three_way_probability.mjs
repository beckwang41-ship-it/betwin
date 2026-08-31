import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { buildThreeWayEvents } from "../lib/three-way-backtest.mjs";
import { selectThreeWaySimilarity } from "../lib/three-way-matching.mjs";
import {
  blendThreeWayProbabilities,
  impliedThreeWayProbabilities,
  uniformThreeWayProbabilities,
  weightedThreeWayProbabilities,
} from "../lib/three-way-probability.mjs";
import {
  blockBootstrapComparison,
  classificationDelta,
} from "../lib/significance.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const OUTPUT_PATH =
  process.env.BETWIN_THREE_WAY_PROBABILITY_REPORT_PATH ||
  path.join(ROOT, "data", "three-way-probability-validation.json");
const CONFIG_OUTPUT_PATH =
  process.env.BETWIN_THREE_WAY_PROBABILITY_CONFIG_PATH ||
  path.join(ROOT, "data", "three-way-probability-config.json");
const LABELS = ["胜", "平", "负"];
const WARMUP = 500;
const VALIDATION_FRACTION = 0.2;
const THRESHOLDS = { spf: 0.1, hhad: 0.1 };
const FEATURE_PROFILES = [
  { id: "final", finalWeight: 1, initialWeight: 0, movementWeight: 0 },
  {
    id: "final70-initial15-movement15",
    finalWeight: 0.7,
    initialWeight: 0.15,
    movementWeight: 0.15,
  },
  {
    id: "final60-initial20-movement20",
    finalWeight: 0.6,
    initialWeight: 0.2,
    movementWeight: 0.2,
  },
];
const DECAYS = [0.5, 1, 2, 3];
// “同联赛”是用户明确选择的预测范围，市场概率不能完全覆盖该范围内
// 的历史分布；至少保留 25% 的范围敏感历史信号。
const MARKET_WEIGHTS = [0, 0.1, 0.2, 0.3, 0.5, 0.75];

function candidateDefinitions() {
  const candidates = [{ id: "uniform", baseline: true }];
  for (const profile of FEATURE_PROFILES) {
    for (const decay of DECAYS) {
      for (const marketWeight of MARKET_WEIGHTS) {
        candidates.push({
          id: `${profile.id}-decay${decay}-market${marketWeight}`,
          profile,
          decay,
          marketWeight,
        });
      }
    }
  }
  return candidates;
}

const CANDIDATES = candidateDefinitions();

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
    league: event.league,
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

function emptyMetrics() {
  return { targets: 0, evaluated: 0, correct: 0, logLoss: 0, brier: 0 };
}

function addMetrics(metrics, probabilities, actualIndex) {
  if (!probabilities) return;
  metrics.evaluated += 1;
  const highest = Math.max(...probabilities);
  const top = probabilities
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => Math.abs(value - highest) < 1e-12);
  metrics.correct += top.some(({ index }) => index === actualIndex)
    ? 1 / top.length
    : 0;
  metrics.logLoss -= Math.log(Math.max(1e-12, probabilities[actualIndex]));
  metrics.brier += probabilities.reduce((sum, probability, index) => {
    const actual = index === actualIndex ? 1 : 0;
    return sum + (probability - actual) ** 2;
  }, 0);
}

function summarize(metrics) {
  return {
    targets: metrics.targets,
    evaluated: metrics.evaluated,
    coverage: metrics.targets ? metrics.evaluated / metrics.targets : 0,
    accuracy: metrics.evaluated ? metrics.correct / metrics.evaluated : 0,
    logLoss: metrics.evaluated ? metrics.logLoss / metrics.evaluated : 0,
    brier: metrics.evaluated ? metrics.brier / metrics.evaluated : 0,
  };
}

function emptyPeriod() {
  return Object.fromEntries(
    ["all", "sameLeague"].map((scope) => [
      scope,
      Object.fromEntries(
        ["spf", "hhad"].map((market) => [
          market,
          {
            metrics: Object.fromEntries(
              CANDIDATES.map((candidate) => [candidate.id, emptyMetrics()]),
            ),
            cases: Object.fromEntries(
              CANDIDATES.map((candidate) => [candidate.id, []]),
            ),
          },
        ]),
      ),
    ]),
  );
}

function predictionsFor(samples, target) {
  const uniform = uniformThreeWayProbabilities(samples);
  if (!uniform) return new Map();
  const market = impliedThreeWayProbabilities(target.odds);
  const result = new Map([["uniform", uniform]]);
  for (const profile of FEATURE_PROFILES) {
    for (const decay of DECAYS) {
      const weighted = weightedThreeWayProbabilities(samples, target, {
        ...profile,
        decay,
        finalScale: THRESHOLDS.spf,
        initialScale: THRESHOLDS.spf * 1.5,
        movementScale: Math.max(0.006, THRESHOLDS.spf * 0.15),
      });
      if (!weighted) continue;
      for (const marketWeight of MARKET_WEIGHTS) {
        const id = `${profile.id}-decay${decay}-market${marketWeight}`;
        result.set(
          id,
          blendThreeWayProbabilities(
            weighted.probabilities,
            market,
            marketWeight,
          ),
        );
      }
    }
  }
  return result;
}

function evaluateTarget(target, market, samples, bucket) {
  const actualIndex = LABELS.indexOf(String(target[market]?.result));
  if (actualIndex < 0) return;
  const predictions = predictionsFor(samples, target[market]);
  const baseline = predictions.get("uniform") || null;
  for (const candidate of CANDIDATES) {
    const metrics = bucket.metrics[candidate.id];
    metrics.targets += 1;
    const probabilities = predictions.get(candidate.id) || null;
    addMetrics(metrics, probabilities, actualIndex);
    if (!baseline || !probabilities || candidate.baseline) continue;
    bucket.cases[candidate.id].push(
      classificationDelta(probabilities, baseline, actualIndex, {
        sourceFile: target.sourceFile,
        order: target.sourceRow,
      }),
    );
  }
}

function scoreCandidate(summary, baseline) {
  const accuracyGain = summary.accuracy - baseline.accuracy;
  const logLossPenalty = Math.max(0, summary.logLoss - baseline.logLoss - 0.005);
  const brierPenalty = Math.max(0, summary.brier - baseline.brier - 0.003);
  return accuracyGain - logLossPenalty - brierPenalty;
}

function selectCandidate(tuning) {
  const baseline = tuning.uniform;
  return CANDIDATES.filter((candidate) => !candidate.baseline)
    .map((candidate) => ({
      ...candidate,
      metrics: tuning[candidate.id],
      score: scoreCandidate(tuning[candidate.id], baseline),
    }))
    .filter(
      (candidate) =>
        candidate.metrics.evaluated === baseline.evaluated &&
        candidate.metrics.accuracy >= baseline.accuracy &&
        candidate.metrics.logLoss <= baseline.logLoss + 0.005 &&
        candidate.metrics.brier <= baseline.brier + 0.003,
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.metrics.accuracy - left.metrics.accuracy ||
        left.metrics.logLoss - right.metrics.logLoss,
    )[0] || null;
}

function gateSelection(selected, tuning, validation, validationCases) {
  if (!selected) {
    return { passed: false, reason: "调参段没有候选同时满足命中率与概率质量门槛" };
  }
  const tuningBaseline = tuning.uniform;
  const validationBaseline = validation.uniform;
  const test = validation[selected.id];
  const delta = {
    tuningAccuracy: selected.metrics.accuracy - tuningBaseline.accuracy,
    validationAccuracy: test.accuracy - validationBaseline.accuracy,
    validationLogLoss: test.logLoss - validationBaseline.logLoss,
    validationBrier: test.brier - validationBaseline.brier,
  };
  const significance = blockBootstrapComparison(
    validationCases[selected.id] || [],
  );
  const passed =
    delta.tuningAccuracy > 0 &&
    delta.validationAccuracy > 0 &&
    delta.validationLogLoss <= 0.005 &&
    delta.validationBrier <= 0.003 &&
    Number(significance?.metrics?.accuracy?.improvementProbability || 0) >= 0.75;
  return {
    passed,
    reason: passed
      ? "较早段与最新20%命中率均提高，概率质量未明显下降，且区块Bootstrap命中改善概率不低于75%"
      : "候选未同时通过较早段、最新20%、概率质量和Bootstrap稳定性门槛",
    delta,
    significance,
  };
}

function summarizePeriod(period) {
  return Object.fromEntries(
    Object.entries(period).map(([scope, markets]) => [
      scope,
      Object.fromEntries(
        Object.entries(markets).map(([market, bucket]) => [
          market,
          Object.fromEntries(
            Object.entries(bucket.metrics).map(([id, metrics]) => [
              id,
              summarize(metrics),
            ]),
          ),
        ]),
      ),
    ]),
  );
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
        for (const [scope, sameLeague] of [
          ["all", false],
          ["sameLeague", true],
        ]) {
          const selection = selectThreeWaySimilarity(
            matchFromEvent(target),
            prior,
            {
              spfTolerance: THRESHOLDS.spf,
              hhadTolerance: THRESHOLDS.hhad,
              sameLeague,
            },
          );
          for (const market of ["spf", "hhad"]) {
            if (!target[market]) continue;
            evaluateTarget(
              target,
              market,
              selection[market]?.similar || [],
              periods[period][scope][market],
            );
          }
        }
      }
      if (target.spf) prior.spfHistory.push(target.spf);
      if (target.hhad) prior.hhadHistory.push(target.hhad);
      if (target.pair) prior.pairedHistory.push(target.pair);
    }
    sources.push({ sourceFile, rows: group.length, validationStart });
  }
  const tuning = summarizePeriod(periods.tuning);
  const validation = summarizePeriod(periods.validation);
  const selections = {};
  for (const scope of ["all", "sameLeague"]) {
    selections[scope] = {};
    for (const market of ["spf", "hhad"]) {
      const selected = selectCandidate(tuning[scope][market]);
      const gate = gateSelection(
        selected,
        tuning[scope][market],
        validation[scope][market],
        periods.validation[scope][market].cases,
      );
      selections[scope][market] = {
        selected: selected
          ? {
              id: selected.id,
              profile: selected.profile,
              decay: selected.decay,
              marketWeight: selected.marketWeight,
            }
          : null,
        gate,
        baseline: {
          tuning: tuning[scope][market].uniform,
          validation: validation[scope][market].uniform,
        },
        candidate: selected
          ? {
              tuning: tuning[scope][market][selected.id],
              validation: validation[scope][market][selected.id],
            }
          : null,
      };
    }
  }
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    data: {
      database: path.basename(DATABASE_PATH),
      verifiedMatches: counts.verifiedHistory,
      sourceUpdatedAt,
      events: events.length,
    },
    methodology: {
      ordering: "按来源文件和source_row递增，每场只读取此前记录",
      warmup: WARMUP,
      validationFraction: VALIDATION_FRACTION,
      matching: "沿用生产的胜平负＋让球联合优先、单市场回退和10%终赔入池规则",
      scopes: "全部联赛与严格同联赛分别调参、分别验证，不跨范围回退",
      candidates:
        "相似样本等权基线；终赔距离；终赔＋初赔＋走势综合距离；再与当前终赔去水概率按0%～75%混合，至少保留25%的所选联赛范围历史信号",
      selection:
        "仅较早段选择候选；最新20%要求命中率提高，LogLoss最多恶化0.005、Brier最多恶化0.003，区块Bootstrap命中改善概率≥75%",
    },
    thresholds: THRESHOLDS,
    searchSpace: {
      featureProfiles: FEATURE_PROFILES,
      decays: DECAYS,
      marketWeights: MARKET_WEIGHTS,
    },
    sources,
    selections,
    periods: { tuning, validation },
  };
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const productionConfig = {
    version: 1,
    generatedAt: report.generatedAt,
    data: {
      database: report.data.database,
      verifiedMatches: report.data.verifiedMatches,
      sourceUpdatedAt: report.data.sourceUpdatedAt,
      matchingVersion: "spf-hhad-joint-v1",
    },
    thresholds: THRESHOLDS,
    constraints: {
      maximumMarketWeight: Math.max(...MARKET_WEIGHTS),
      minimumScopedHistoryWeight: 1 - Math.max(...MARKET_WEIGHTS),
      reason: "保留全部/同联赛范围选择对最终概率的实际影响",
    },
    scopes: Object.fromEntries(
      ["all", "sameLeague"].map((scope) => [
        scope,
        Object.fromEntries(
          ["spf", "hhad"].map((market) => {
            const value = selections[scope][market];
            return [
              market,
              {
                enabled: Boolean(value.gate.passed),
                selected: value.gate.passed ? value.selected : null,
                gate: value.gate,
                validation: {
                  baseline: value.baseline.validation,
                  candidate: value.candidate?.validation || null,
                },
              },
            ];
          }),
        ),
      ]),
    ),
  };
  mkdirSync(path.dirname(CONFIG_OUTPUT_PATH), { recursive: true });
  writeFileSync(
    CONFIG_OUTPUT_PATH,
    `${JSON.stringify(productionConfig, null, 2)}\n`,
    "utf8",
  );
  for (const scope of ["all", "sameLeague"]) {
    console.log(scope === "all" ? "\n全部联赛" : "\n同联赛");
    for (const market of ["spf", "hhad"]) {
      const value = selections[scope][market];
      const name = market === "spf" ? "胜平负" : "让球胜平负";
      const base = value.baseline.validation;
      const candidate = value.candidate?.validation;
      console.log(
        `${name}: ${value.gate.passed ? "通过" : "不通过"} | ` +
          `基线 ${(base.accuracy * 100).toFixed(2)}%` +
          (candidate
            ? ` → 候选 ${(candidate.accuracy * 100).toFixed(2)}% (${value.selected.id})`
            : " | 无合格候选"),
      );
    }
  }
  console.log(`\n报告已写入 ${OUTPUT_PATH}`);
  console.log(`生产配置已写入 ${CONFIG_OUTPUT_PATH}`);
} finally {
  store.close();
}
