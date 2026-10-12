import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "./lib/database.mjs";
import { createRuntimeConfiguration, runtimeCodeSignature, databaseIdentity } from "./lib/runtime-configuration.mjs";
import { auditPaths, readPredictionAudit } from "./lib/prediction-audit-store.mjs";
import { summarizeSampleOrigins } from "./lib/presentation-data.mjs";
import { selectAdaptiveSimilarity } from "./lib/adaptive-threshold.mjs";
import {
  classifyGoalOdds,
  classifyThreeWayOdds,
} from "./lib/odds-segments.mjs";
import {
  GOAL_ZERO_BANDS,
  GOAL_MATCHING_VERSION,
  GOAL_ZERO_ODDS_TOLERANCE,
  SAME_LEAGUE_GOAL_ZERO_ODDS_TOLERANCE,
  findZeroOddsInterval,
} from "./lib/goal-zero-odds.mjs";
import {
  PRODUCTION_GOAL_POOL_FRACTIONS,
  predictProductionGoals,
  selectProductionGoalSimilarity,
} from "./lib/goal-production.mjs";
import { createChallenger } from "./lib/challenger.mjs";
import {
  normalizeFixtureText,
  normalizeTeamName,
} from "./lib/fixture-name.mjs";
import {
  createParlayLedger,
  parlaySettlementDecision,
} from "./lib/parlay-ledger.mjs";
import { createPredictionLedger } from "./lib/prediction-ledger.mjs";
import { createShadowPredictionLedger } from "./lib/shadow-prediction-ledger.mjs";
import { buildSpfShadowComparison } from "./lib/three-way-shadow.mjs";
import {
  buildGoalEqualityDistribution,
  buildGoalMultipleDistribution,
  GOAL_MULTIPLE_VERSION,
  selectGoalEqualityPrediction,
  selectGoalMultiplePrediction,
} from "./public/goal-multiples.js";
import {
  evaluateReliability,
  goalPairValidation,
  summarizeHistoricalSupport,
} from "./lib/reliability.mjs";
import {
  generateGoalPairParlays,
  generateParlayCombinations,
} from "./lib/parlay.mjs";
import {
  GOAL_LABELS,
  compareHistoricalToMarket,
  confidenceLabel,
  distanceWeight,
  findSimilarGoals,
  findSimilarSpfMovements,
  findSimilarSpf,
  goalDistance,
  normalizeOdds,
  paginate,
  predictSpf,
  predictSpfWithMovement,
  selectTopGoalPair,
  spfDistance,
} from "./lib/predictor.mjs";
import {
  DEFAULT_ZERO_CELL_PRIOR_MASS,
  ZERO_CELL_FLOOR_VERSION,
  adjustedThreeWayMarketPrior,
  selectHistoricalPrior,
} from "./lib/smoothing.mjs";
import { resolveSmoothingProduction, SMOOTHING_VALIDATION_VERSION, smoothingPolicyToken, smoothingValidationSignature } from "./lib/smoothing-production.mjs";
import { HISTORY_TIMELINE_VERSION } from "./lib/history-timeline.mjs";
import { selectThreeWayHistoricalPrior } from "./lib/three-way-smoothing.mjs";
import {
  THREE_WAY_MATCHING_VERSION,
  selectThreeWaySimilarity,
} from "./lib/three-way-matching.mjs";
import { modelConfigIsCurrent } from "./lib/production-thresholds.mjs";
import { resolveProductionApproval } from "./lib/production-approval.mjs";
import {
  FORMAL_PRODUCTION_PROBABILITY_POLICY,
  reliabilityValidationIsCurrent,
} from "./lib/reliability-validation.mjs";
import {
  blendThreeWayProbabilities,
  impliedThreeWayProbabilities,
  weightedThreeWayProbabilities,
} from "./lib/three-way-probability.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 8765);
const DATABASE_PATH = process.env.BETWIN_DATABASE_PATH
  ? path.resolve(process.env.BETWIN_DATABASE_PATH)
  : path.join(ROOT, "betwin.db");
const MODEL_CONFIG_PATH = path.join(ROOT, "data", "model-config.json");
const ADAPTIVE_CONFIG_PATH = path.join(
  ROOT,
  "data",
  "adaptive-config.json",
);
const SEGMENT_CONFIG_PATH = path.join(
  ROOT,
  "data",
  "segment-config.json",
);
const WEIGHTING_CONFIG_PATH = path.join(
  ROOT,
  "data",
  "weighting-config.json",
);
const MOVEMENT_CONFIG_PATH = path.join(
  ROOT,
  "data",
  "movement-config.json",
);
const SMOOTHING_CONFIG_PATH = process.env.BETWIN_SMOOTHING_CONFIG_PATH || path.join(
  ROOT,
  "data",
  "smoothing-config.json",
);
const SMOOTHING_PRODUCTION_PATH =
  process.env.BETWIN_SMOOTHING_PRODUCTION_PATH ||
  path.join(ROOT, "data", "smoothing-production.json");
const ADAPTIVE_PRODUCTION_PATH =
  process.env.BETWIN_ADAPTIVE_PRODUCTION_PATH ||
  path.join(ROOT, "data", "adaptive-production.json");
const WEIGHTING_PRODUCTION_PATH =
  process.env.BETWIN_WEIGHTING_PRODUCTION_PATH ||
  path.join(ROOT, "data", "weighting-production.json");
const MOVEMENT_PRODUCTION_PATH =
  process.env.BETWIN_MOVEMENT_PRODUCTION_PATH ||
  path.join(ROOT, "data", "movement-production.json");
const THREE_WAY_PROBABILITY_CONFIG_PATH = path.join(
  ROOT,
  "data",
  "three-way-probability-config.json",
);
const CHALLENGER_CONFIG_PATH = path.join(
  ROOT,
  "data",
  "challenger-config.json",
);
const RELIABILITY_CONFIG_PATH =
  process.env.BETWIN_RELIABILITY_CONFIG_PATH ||
  path.join(ROOT, "data", "reliability-config.json");
const CHALLENGER_MODEL_PATH = path.join(
  ROOT,
  "data",
  "challenger-model.json",
);
const GOAL_PAIR_SELECTION_PATH = path.join(
  ROOT,
  "data",
  "goal-pair-selection.json",
);
const dataStore = createDataStore(DATABASE_PATH);
const predictionLedger = createPredictionLedger(DATABASE_PATH);
const shadowPredictionLedger = createShadowPredictionLedger(DATABASE_PATH, {
  // 首次启用只冻结水位，不把当时已存在的比赛伪装成真正未来样本。
  initialMatchIds: dataStore.getMatches().map((match) => match.id),
});
const parlayLedger = createParlayLedger(DATABASE_PATH);
const DEFAULT_THRESHOLDS = {
  spf: 0.07,
  hhad: 0.07,
  goals: 0.015,
};
const LOCKED_PRODUCTION_PROBABILITY_POLICY =
  FORMAL_PRODUCTION_PROBABILITY_POLICY;

function loadRuntimeConfiguration() {
  const goalMultipleDistribution = buildGoalMultipleDistribution(
    dataStore.getGoalHistory(),
  );
  const goalEqualityDistribution = buildGoalEqualityDistribution(dataStore.getGoalHistory());
  const productionPolicy = {
    probabilityPolicy: LOCKED_PRODUCTION_PROBABILITY_POLICY,
    empiricalOnly: true,
    zeroCellFloor: {
      enabled: true,
      priorMass: DEFAULT_ZERO_CELL_PRIOR_MASS,
      version: ZERO_CELL_FLOOR_VERSION,
    },
    historicalCalibration: {
      enabled: false,
      maxWeight: 0,
      scale: 800,
      requireSamples: true,
    },
    minimumSamples: 1,
    thresholds: { ...DEFAULT_THRESHOLDS },
    adaptive: {
      spf: { enabled: false, minSamples: null, thresholds: [] },
      hhad: { enabled: false, minSamples: null, thresholds: [] },
      goals: { enabled: false, minSamples: null, thresholds: [] },
    },
    segments: {
      spf: { enabled: false, policies: {} },
      hhad: { enabled: false, policies: {} },
      goals: { enabled: false, policies: {} },
    },
    zeroGoals: {
      enabled: true,
      intervals: GOAL_ZERO_BANDS,
      policies: {},
      reason: "0球赔率近邻与综合距离模型已启用",
    },
    weighting: {
      spf: { enabled: false, floor: 1, power: 1, coreRatio: 0.5 },
      hhad: { enabled: false, floor: 1, power: 1, coreRatio: 0.5 },
      goals: { enabled: false, floor: 1, power: 1, coreRatio: 0.5 },
    },
    movement: {
      spf: { enabled: false, fixedWeight: 0, minSamples: 1 },
      hhad: { enabled: false, fixedWeight: 0, minSamples: 1 },
      goals: { enabled: false, fixedWeight: 0, minSamples: 1 },
    },
    smoothing: {
      spf: {
        enabled: false,
        strength: 0,
        referenceStrength: 0,
        relaxedMultiplier: 2,
        minLocalizedSamples: 30,
      },
      hhad: {
        enabled: false,
        strength: 0,
        referenceStrength: 0,
        relaxedMultiplier: 2,
        minLocalizedSamples: 30,
      },
      goals: {
        enabled: false,
        strength: 0,
        referenceStrength: 0,
        relaxedMultiplier: 2,
        minLocalizedSamples: 30,
      },
    },
    challenger: {
      spf: { enabled: false, policy: "historical-similarity" },
      hhad: { enabled: false, policy: "historical-similarity" },
      goals: { enabled: false, policy: "historical-similarity" },
    },
    threeWayProbability: {
      stale: true,
      scopes: {
        all: { spf: { enabled: false }, hhad: { enabled: false } },
        sameLeague: { spf: { enabled: false }, hhad: { enabled: false } },
      },
    },
  };
  const STABILITY_THRESHOLDS = {
    spf: [0.03, 0.05, 0.07, 0.1],
    hhad: [0.03, 0.05, 0.07, 0.1],
    goals: [0.005, 0.01, 0.015, 0.02],
  };

  function maximumThreeWayTolerance(market, requestedTolerance) {
    const adaptiveThresholds = productionPolicy.adaptive[market]?.thresholds || [];
    const segmentThresholds = Object.values(
      productionPolicy.segments[market]?.policies || {},
    ).map((policy) => policy?.threshold);
    return Math.max(
      Number(requestedTolerance) || 0,
      Number(productionPolicy.thresholds[market]) || 0,
      ...STABILITY_THRESHOLDS[market],
      ...adaptiveThresholds.map(Number),
      ...segmentThresholds.map(Number).filter(Number.isFinite),
    );
  }

  function predictionMarketHistories(
    match,
    { spfTolerance, hhadTolerance, sameLeague = false },
  ) {
    const historyOptions = { league: match.league, sameLeague };
    const hadOdds = match.had
      ? [match.had.h, match.had.d, match.had.a]
      : null;
    const hhadOdds = match.hhad
      ? [match.hhad.h, match.hhad.d, match.hhad.a]
      : null;
    const handicap = match.hhad ? handicapNumber(match.hhad) : null;
    const spfRange = maximumThreeWayTolerance("spf", spfTolerance);
    const hhadRange = maximumThreeWayTolerance("hhad", hhadTolerance);
    const spfNeedsFullHistory = Boolean(productionPolicy.smoothing.spf?.enabled);
    const hhadNeedsFullHistory = Boolean(productionPolicy.smoothing.hhad?.enabled);
    const pairedNeedsFullHistory = spfNeedsFullHistory || hhadNeedsFullHistory;
    const goalZeroTolerance = sameLeague
      ? SAME_LEAGUE_GOAL_ZERO_ODDS_TOLERANCE
      : GOAL_ZERO_ODDS_TOLERANCE;

    return {
      spfHistory: hadOdds
        ? spfNeedsFullHistory
          ? dataStore.getSpfHistory(historyOptions)
          : dataStore.getHistoricalSpf(hadOdds, {
              ...historyOptions,
              tolerance: spfRange,
            })
        : [],
      hhadHistory: hhadOdds && handicap !== null
        ? hhadNeedsFullHistory
          ? dataStore.getHhadHistory(historyOptions)
          : dataStore.getHistoricalHhad(hhadOdds, {
              ...historyOptions,
              tolerance: hhadRange,
              handicap,
            })
        : [],
      pairedHistory: hadOdds && hhadOdds && handicap !== null
        ? pairedNeedsFullHistory
          ? dataStore.getPairedSpfHhadHistory(historyOptions)
          : dataStore.getPairedSpfHhadHistoryNear(hadOdds, hhadOdds, {
              ...historyOptions,
              spfTolerance: spfRange,
              hhadTolerance: hhadRange,
              handicap,
            })
        : [],
      goalHistory: match.goals
        ? dataStore.getGoalHistoryNearZeroOdds(match.goals.g0, {
            ...historyOptions,
            tolerance: goalZeroTolerance,
          })
        : [],
    };
  }

  function loadModelConfig() {
    try {
      const config = JSON.parse(readFileSync(MODEL_CONFIG_PATH, "utf8"));
      const counts = dataStore.getCounts();
      const sourceUpdatedAt = dataStore.getHistoricalSourceUpdatedAt();
      const stale = !modelConfigIsCurrent(config, {
        verifiedMatches: counts.verifiedHistory,
        sourceUpdatedAt,
        matchingVersion: THREE_WAY_MATCHING_VERSION,
      });
      return {
        ...config,
        stale,
        candidateOnly: true,
        runtimeEnabled: false,
        productionLocked: true,
        productionThresholds: { ...DEFAULT_THRESHOLDS },
        markets: Object.fromEntries(
          ["spf", "hhad", "goals"].map((market) => {
            const value = config.markets?.[market] || {};
            return [
              market,
              {
                ...value,
                currentThreshold: DEFAULT_THRESHOLDS[market],
                candidateThreshold: Number(
                  value.candidateThreshold ?? value.threshold ??
                    DEFAULT_THRESHOLDS[market],
                ),
                threshold: DEFAULT_THRESHOLDS[market],
                changed: false,
                candidateGate: value.gate || null,
                gate: {
                  ...(value.gate || {}),
                  passed: false,
                  validationPassed: false,
                  significancePassed: false,
                  reason:
                    stale
                      ? "历史数据已更新，离线候选阈值报告已过期；正式阈值仍按固定规则执行"
                      : "离线候选阈值仅供研究；正式阈值按固定规则执行",
                },
              },
            ];
          }),
        ),
      };
    } catch {
      return {
        version: 0,
        generatedAt: null,
        stale: true,
        candidateOnly: true,
        runtimeEnabled: false,
        productionLocked: true,
        productionThresholds: { ...DEFAULT_THRESHOLDS },
        markets: Object.fromEntries(
          ["spf", "hhad", "goals"].map((market) => [
            market,
            {
              currentThreshold: DEFAULT_THRESHOLDS[market],
              candidateThreshold: DEFAULT_THRESHOLDS[market],
              threshold: DEFAULT_THRESHOLDS[market],
              changed: false,
              gate: {
                passed: false,
                reason: "尚无离线候选阈值报告；正式阈值按固定规则执行",
              },
            },
          ]),
        ),
      };
    }
  }

  const modelConfig = loadModelConfig();

  function loadThreeWayProbabilityConfig() {
    try {
      const config = JSON.parse(
        readFileSync(THREE_WAY_PROBABILITY_CONFIG_PATH, "utf8"),
      );
      const counts = dataStore.getCounts();
      const sourceUpdatedAt = dataStore.getHistoricalSourceUpdatedAt();
      const stale =
        config.data?.verifiedMatches !== counts.verifiedHistory ||
        config.data?.sourceUpdatedAt !== sourceUpdatedAt ||
        config.data?.matchingVersion !== THREE_WAY_MATCHING_VERSION;
      if (!stale) return { ...config, stale: false };
      return {
        ...config,
        stale: true,
        scopes: Object.fromEntries(
          ["all", "sameLeague"].map((scope) => [
            scope,
            Object.fromEntries(
              ["spf", "hhad"].map((market) => [
                market,
                {
                  ...(config.scopes?.[scope]?.[market] || {}),
                  enabled: false,
                  stale: true,
                },
              ]),
            ),
          ]),
        ),
      };
    } catch {
      return {
        version: 0,
        generatedAt: null,
        stale: true,
        scopes: {
          all: { spf: { enabled: false }, hhad: { enabled: false } },
          sameLeague: { spf: { enabled: false }, hhad: { enabled: false } },
        },
      };
    }
  }

  const threeWayProbabilityConfig = loadThreeWayProbabilityConfig();
  productionPolicy.threeWayProbability = {
    ...threeWayProbabilityConfig,
    candidateOnly: true,
    runtimeEnabled: false,
    productionLock: LOCKED_PRODUCTION_PROBABILITY_POLICY,
  };

  function loadAdaptiveConfig() {
    try {
      const config = JSON.parse(readFileSync(ADAPTIVE_CONFIG_PATH, "utf8"));
      const counts = dataStore.getCounts();
      const sourceUpdatedAt = dataStore.getHistoricalSourceUpdatedAt();
      const stale =
        config.data?.verifiedMatches !== counts.verifiedHistory ||
        !config.data?.sourceUpdatedAt ||
        config.data.sourceUpdatedAt !== sourceUpdatedAt ||
        config.methodology?.matchingVersion !== THREE_WAY_MATCHING_VERSION ||
        config.methodology?.goalMatchingVersion !== GOAL_MATCHING_VERSION;
      return { ...config, stale };
    } catch {
      return {
        version: 0,
        generatedAt: null,
        stale: true,
        markets: {},
      };
    }
  }

  function loadApprovalFile(approvalPath) {
    try {
      return JSON.parse(readFileSync(approvalPath, "utf8"));
    } catch {
      return {
        version: 0,
        runtimeEnabled: false,
        approvedAt: null,
        approvedArtifact: null,
        markets: {},
      };
    }
  }

  function adaptiveThresholdList(marketNode) {
    return Array.isArray(marketNode?.thresholds)
      ? marketNode.thresholds.map(Number)
      : [];
  }

  const adaptiveConfig = loadAdaptiveConfig();
  // 候选配置的 runtimeEnabled 一律忽略：即使被手工改成 true，
  // 生产是否启用只由 data/adaptive-production.json 的独立批准决定。
  const adaptiveApproval = resolveProductionApproval(
    adaptiveConfig,
    loadApprovalFile(ADAPTIVE_PRODUCTION_PATH),
    {
      candidateStale: adaptiveConfig.stale,
      moduleLabel: "动态范围",
      paramsOf: (marketNode) => ({
        minSamples: Number(marketNode?.minSamples) || null,
        thresholds: adaptiveThresholdList(marketNode),
      }),
      approvedParamsOf: (marketApproval) => ({
        minSamples: Number(marketApproval?.minSamples) || null,
        thresholds: adaptiveThresholdList(marketApproval),
      }),
    },
  );
  for (const market of ["spf", "hhad", "goals"]) {
    const decision = adaptiveApproval.markets[market];
    if (!decision.enabled) {
      productionPolicy.adaptive[market] = {
        ...(productionPolicy.adaptive[market] || {}),
        enabled: false,
        reason: decision.reason,
      };
      continue;
    }
    const config = adaptiveConfig.markets?.[market];
    productionPolicy.adaptive[market] = {
      enabled: true,
      minSamples: Number(config?.minSamples) || null,
      thresholds: adaptiveThresholdList(config),
      reason: decision.reason,
    };
  }
  productionPolicy.adaptiveApproval = {
    runtimeEnabled: adaptiveApproval.runtimeEnabled,
    status: adaptiveApproval.status,
    reason: adaptiveApproval.reason,
    approvalRequested: adaptiveApproval.approvalRequested,
    approvalCurrent: adaptiveApproval.approvalCurrent,
    approvedAt: adaptiveApproval.approvedAt,
    enabledMarkets: adaptiveApproval.enabledMarkets,
    markets: adaptiveApproval.markets,
  };

  function loadSegmentConfig() {
    try {
      const config = JSON.parse(readFileSync(SEGMENT_CONFIG_PATH, "utf8"));
      const counts = dataStore.getCounts();
      const sourceUpdatedAt = dataStore.getHistoricalSourceUpdatedAt();
      const stale =
        config.data?.verifiedMatches !== counts.verifiedHistory ||
        !config.data?.sourceUpdatedAt ||
        config.data.sourceUpdatedAt !== sourceUpdatedAt ||
        config.methodology?.matchingVersion !== THREE_WAY_MATCHING_VERSION ||
        config.methodology?.goalMatchingVersion !== GOAL_MATCHING_VERSION;
      return { ...config, stale };
    } catch {
      return {
        version: 0,
        generatedAt: null,
        stale: true,
        markets: {},
      };
    }
  }

  const segmentConfig = loadSegmentConfig();
  if (!segmentConfig.stale && segmentConfig.runtimeEnabled === true) {
    for (const market of ["spf", "hhad", "goals"]) {
      const config = segmentConfig.markets?.[market];
      const policies = Object.fromEntries(
        Object.entries(config?.policies || {}).map(([segment, policy]) => [
          segment,
          {
            enabled: Boolean(policy?.enabled),
            threshold: Number(policy?.threshold),
            gate: policy?.gate || null,
          },
        ]),
      );
      productionPolicy.segments[market] = {
        enabled: Object.values(policies).some((policy) => policy?.enabled),
        policies,
      };
    }
  }

  function segmentConfigView() {
    return {
      version: segmentConfig.version,
      generatedAt: segmentConfig.generatedAt,
      stale: segmentConfig.stale,
      markets: Object.fromEntries(
        ["spf", "hhad", "goals"].map((market) => [
          market,
          {
            enabledSegments:
              segmentConfig.markets?.[market]?.enabledSegments || 0,
            policies: productionPolicy.segments[market].policies,
          },
        ]),
      ),
    };
  }

  productionPolicy.zeroGoals = {
    enabled: true,
    intervals: GOAL_ZERO_BANDS,
    policies: {},
    reason: "0球赔率近邻与综合距离模型已启用",
  };

  function goalZeroConfigView() {
    return {
      version: GOAL_MATCHING_VERSION,
      generatedAt: null,
      stale: false,
      enabled: true,
      source: "内置生产规则",
      researchReportOnly: true,
      matching: {
        allLeaguesTolerance: GOAL_ZERO_ODDS_TOLERANCE,
        sameLeagueTolerance: SAME_LEAGUE_GOAL_ZERO_ODDS_TOLERANCE,
        sampleLimit: null,
        usesAllSamples: true,
        distance: "终赔60% + 初赔15% + 走势15% + 隐含进球10%",
        weighting: "按综合距离指数衰减",
      },
      intervals: productionPolicy.zeroGoals.intervals.map((interval) => ({
        id: interval.id,
        lower: interval.lower,
        upper: interval.upper,
        observedMin: interval.observedMin,
        observedMax: interval.observedMax,
        label: interval.label || null,
        distanceEnabled: Boolean(
          productionPolicy.zeroGoals.policies?.[interval.id]?.enabled,
        ),
        threshold:
          productionPolicy.zeroGoals.policies?.[interval.id]?.threshold ?? null,
        samples: interval.samples,
        probabilities: interval.probabilities,
      })),
      reason: productionPolicy.zeroGoals.reason,
    };
  }

  function uniformWeighting(reason) {
    return {
      enabled: false,
      floor: 1,
      power: 1,
      coreRatio: 0.5,
      validated: false,
      reason,
    };
  }

  function loadWeightingConfig() {
    try {
      const config = JSON.parse(
        readFileSync(WEIGHTING_CONFIG_PATH, "utf8"),
      );
      const counts = dataStore.getCounts();
      const sourceUpdatedAt = dataStore.getHistoricalSourceUpdatedAt();
      const configuredThresholds = config.searchSpace?.thresholds || {};
      const thresholdChanged = ["spf", "hhad", "goals"].some(
        (market) =>
          Math.abs(
            Number(configuredThresholds[market]) -
              Number(productionPolicy.thresholds[market]),
          ) > 1e-12,
      );
      const stale =
        config.data?.verifiedMatches !== counts.verifiedHistory ||
        !config.data?.sourceUpdatedAt ||
        config.data.sourceUpdatedAt !== sourceUpdatedAt ||
        thresholdChanged ||
        config.methodology?.matchingVersion !== THREE_WAY_MATCHING_VERSION ||
        config.methodology?.goalMatchingVersion !== GOAL_MATCHING_VERSION;
      if (!stale) return { ...config, stale: false };
      return {
        ...config,
        stale: true,
        markets: Object.fromEntries(
          ["spf", "hhad", "goals"].map((market) => [
            market,
            {
              ...(config.markets?.[market] || {}),
              production: uniformWeighting(
                "历史数据或默认阈值已更新，旧权重验证失效，生产环境使用等权统计",
              ),
              gate: {
                ...(config.markets?.[market]?.gate || {}),
                passed: false,
                reason:
                  "历史数据或默认阈值已更新，旧权重验证失效，生产环境使用等权统计",
              },
            },
          ]),
        ),
      };
    } catch {
      return {
        version: 0,
        generatedAt: null,
        stale: true,
        markets: Object.fromEntries(
          ["spf", "hhad", "goals"].map((market) => [
            market,
            {
              production: uniformWeighting(
                "尚未运行严格权重验证，生产环境使用等权统计",
              ),
              gate: {
                passed: false,
                reason: "尚未运行严格权重验证",
              },
            },
          ]),
        ),
      };
    }
  }

  const weightingConfig = loadWeightingConfig();
  // 距离权重与 adaptive/movement 一样只保存候选；即使调参门禁通过，
  // 也必须由独立批准文件同时确认概率门禁、ROI 门禁和候选参数。
  const weightingApproval = resolveProductionApproval(
    weightingConfig,
    loadApprovalFile(WEIGHTING_PRODUCTION_PATH),
    {
      candidateStale: weightingConfig.stale,
      moduleLabel: "距离权重",
      paramsOf: (marketNode) => ({
        floor: Number(marketNode?.selected?.floor) || 1,
        power: Number(marketNode?.selected?.power) || 1,
        coreRatio: 0.5,
      }),
      approvedParamsOf: (marketApproval) => ({
        floor: Number(marketApproval?.floor) || 1,
        power: Number(marketApproval?.power) || 1,
        coreRatio: Number(marketApproval?.coreRatio) || 0.5,
      }),
    },
  );
  productionPolicy.weighting = Object.fromEntries(
    ["spf", "hhad", "goals"].map((market) => {
      const config = weightingConfig.markets[market];
      const decision = weightingApproval.markets[market];
      const production = decision.enabled
        ? config.production
        : uniformWeighting(decision.reason);
      return [
        market,
        {
          ...production,
          validated: decision.enabled,
          significanceStatus:
            config.selected?.significance?.status || "not-run",
          strategyStatus: decision.strategyStatus,
          reason: decision.reason,
        },
      ];
    }),
  );
  productionPolicy.weightingApproval = {
    runtimeEnabled: weightingApproval.runtimeEnabled,
    status: weightingApproval.status,
    reason: weightingApproval.reason,
    approvalRequested: weightingApproval.approvalRequested,
    approvalCurrent: weightingApproval.approvalCurrent,
    approvedAt: weightingApproval.approvedAt,
    enabledMarkets: weightingApproval.enabledMarkets,
    markets: weightingApproval.markets,
  };

  function referenceMovement(reason) {
    return {
      enabled: false,
      fixedWeight: 0,
      minSamples: 1,
      validated: false,
      reason,
    };
  }

  function loadMovementConfig() {
    try {
      const config = JSON.parse(
        readFileSync(MOVEMENT_CONFIG_PATH, "utf8"),
      );
      const counts = dataStore.getCounts();
      const sourceUpdatedAt = dataStore.getHistoricalSourceUpdatedAt();
      const configuredThresholds = config.searchSpace?.thresholds || {};
      const thresholdChanged = ["spf", "hhad", "goals"].some(
        (market) =>
          Math.abs(
            Number(configuredThresholds[market]) -
              Number(productionPolicy.thresholds[market]),
          ) > 1e-12,
      );
      const stale =
        config.data?.verifiedMatches !== counts.verifiedHistory ||
        !config.data?.sourceUpdatedAt ||
        config.data.sourceUpdatedAt !== sourceUpdatedAt ||
        thresholdChanged ||
        config.methodology?.matchingVersion !== THREE_WAY_MATCHING_VERSION;
      if (!stale) return { ...config, stale: false };
      return {
        ...config,
        stale: true,
        markets: Object.fromEntries(
          ["spf", "hhad", "goals"].map((market) => [
            market,
            {
              ...(config.markets?.[market] || {}),
              production: referenceMovement(
                "历史数据或默认阈值已更新，旧走势验证失效，仅展示走势参考",
              ),
              gate: {
                ...(config.markets?.[market]?.gate || {}),
                passed: false,
                reason:
                  "历史数据或默认阈值已更新，旧走势验证失效，仅展示走势参考",
              },
            },
          ]),
        ),
      };
    } catch {
      return {
        version: 0,
        generatedAt: null,
        stale: true,
        markets: Object.fromEntries(
          ["spf", "hhad", "goals"].map((market) => [
            market,
            {
              production: referenceMovement(
                "尚未运行严格走势验证，仅展示走势参考",
              ),
              gate: {
                passed: false,
                reason: "尚未运行严格走势验证",
              },
            },
          ]),
        ),
      };
    }
  }

  const movementConfig = loadMovementConfig();
  // 同 adaptive：候选文件的 runtimeEnabled 不再参与生产判定。
  const movementApproval = resolveProductionApproval(
    movementConfig,
    loadApprovalFile(MOVEMENT_PRODUCTION_PATH),
    {
      candidateStale: movementConfig.stale,
      moduleLabel: "走势修正",
      paramsOf: (marketNode) => ({
        weight: Number(marketNode?.selected?.weight) || 0,
      }),
      approvedParamsOf: (marketApproval) => ({
        weight: Number(marketApproval?.weight) || 0,
      }),
    },
  );
  productionPolicy.movement = Object.fromEntries(
    ["spf", "hhad", "goals"].map((market) => {
      const config = movementConfig.markets[market];
      const decision = movementApproval.markets[market];
      const production = decision.enabled
        ? config.production
        : referenceMovement(decision.reason);
      return [
        market,
        {
          ...production,
          validated: decision.enabled,
          significanceStatus:
            config.selected?.significance?.status || "not-run",
          strategyStatus: decision.strategyStatus,
          reason: decision.reason,
        },
      ];
    }),
  );
  productionPolicy.movementApproval = {
    runtimeEnabled: movementApproval.runtimeEnabled,
    status: movementApproval.status,
    reason: movementApproval.reason,
    approvalRequested: movementApproval.approvalRequested,
    approvalCurrent: movementApproval.approvalCurrent,
    approvedAt: movementApproval.approvedAt,
    enabledMarkets: movementApproval.enabledMarkets,
    markets: movementApproval.markets,
  };

  function referenceSmoothing(reason, referenceStrength = 0) {
    return {
      enabled: false,
      strength: 0,
      referenceStrength: Math.max(0, Number(referenceStrength) || 0),
      relaxedMultiplier: 2,
      minLocalizedSamples: 30,
      validated: false,
      significanceStatus: "not-run",
      reason,
    };
  }

  function loadSmoothingConfig() {
    try {
      const config = JSON.parse(
        readFileSync(SMOOTHING_CONFIG_PATH, "utf8"),
      );
      const counts = dataStore.getCounts();
      const sourceUpdatedAt = dataStore.getHistoricalSourceUpdatedAt();
      const configuredThresholds = config.searchSpace?.thresholds || {};
      const thresholdChanged = ["spf", "hhad", "goals"].some(
        (market) =>
          Math.abs(
            Number(configuredThresholds[market]) -
              Number(productionPolicy.thresholds[market]),
          ) > 1e-12,
      );
      const stale =
        config.data?.validationVersion !== SMOOTHING_VALIDATION_VERSION ||
        config.data?.timelineVersion !== HISTORY_TIMELINE_VERSION ||
        config.data?.verifiedMatches !== counts.verifiedHistory ||
        !config.data?.sourceUpdatedAt ||
        config.data.sourceUpdatedAt !== sourceUpdatedAt ||
        thresholdChanged ||
        config.methodology?.matchingVersion !== THREE_WAY_MATCHING_VERSION ||
        config.methodology?.goalMatchingVersion !== GOAL_MATCHING_VERSION;
      if (!stale) return { ...config, stale: false };
      return {
        ...config,
        stale: true,
        markets: Object.fromEntries(
          ["spf", "hhad", "goals"].map((market) => {
            const value = config.markets?.[market] || {};
            return [
              market,
              {
                ...value,
                production: referenceSmoothing(
                  "历史数据或默认阈值已更新，旧平滑验证失效，稳定概率仅供参考",
                  value.candidateStrength,
                ),
                gate: {
                  ...(value.gate || {}),
                  passed: false,
                  reason:
                    "历史数据或默认阈值已更新，旧平滑验证失效，稳定概率仅供参考",
                },
              },
            ];
          }),
        ),
      };
    } catch {
      return {
        version: 0,
        generatedAt: null,
        stale: true,
        markets: Object.fromEntries(
          ["spf", "hhad", "goals"].map((market) => [
            market,
            {
              production: referenceSmoothing(
                "尚未运行严格小样本平滑验证，历史平滑仅供参考",
              ),
              gate: {
                passed: false,
                reason: "尚未运行严格小样本平滑验证",
              },
            },
          ]),
        ),
      };
    }
  }

  function loadSmoothingProductionApproval() {
    try {
      return JSON.parse(readFileSync(SMOOTHING_PRODUCTION_PATH, "utf8"));
    } catch {
      return {
        version: 0,
        runtimeEnabled: false,
        approvedAt: null,
        approvedArtifact: null,
        markets: {},
      };
    }
  }

  const smoothingCandidateConfig = loadSmoothingConfig();
  const smoothingProduction = resolveSmoothingProduction(
    smoothingCandidateConfig,
    loadSmoothingProductionApproval(),
    { candidateStale: smoothingCandidateConfig.stale },
  );
  const smoothingConfig = {
    ...smoothingCandidateConfig,
    candidateOnly: true,
    runtimeEnabled: smoothingProduction.runtimeEnabled,
    approval: {
      status: smoothingProduction.status,
      reason: smoothingProduction.reason,
      approvalRequested: smoothingProduction.approvalRequested,
      approvalCurrent: smoothingProduction.approvalCurrent,
      approvedAt: smoothingProduction.approvedAt,
      approvedArtifact: smoothingProduction.approvedArtifact,
      enabledMarkets: smoothingProduction.enabledMarkets,
    },
    markets: Object.fromEntries(
      ["spf", "hhad", "goals"].map((market) => [
        market,
        {
          ...(smoothingCandidateConfig.markets?.[market] || {}),
          productionStrength: Number(
            smoothingProduction.markets[market]?.strength || 0,
          ),
          production: {
            ...smoothingProduction.markets[market],
            significanceStatus:
              smoothingCandidateConfig.markets?.[market]?.selected?.significance
                ?.status || "not-run",
          },
        },
      ]),
    ),
  };
  productionPolicy.smoothing = Object.fromEntries(
    ["spf", "hhad", "goals"].map((market) => [
      market,
      smoothingConfig.markets[market].production,
    ]),
  );

  function unavailableChallenger(reason) {
    return {
      enabled: false,
      policy: "historical-similarity",
      validated: false,
      reason,
    };
  }

  function loadChallengerArtifacts() {
    try {
      const config = JSON.parse(
        readFileSync(CHALLENGER_CONFIG_PATH, "utf8"),
      );
      const model = JSON.parse(
        readFileSync(CHALLENGER_MODEL_PATH, "utf8"),
      );
      const counts = dataStore.getCounts();
      const sourceUpdatedAt = dataStore.getHistoricalSourceUpdatedAt();
      const stale =
        config.data?.verifiedMatches !== counts.verifiedHistory ||
        !config.data?.sourceUpdatedAt ||
        config.data.sourceUpdatedAt !== sourceUpdatedAt ||
        model.generatedAt !== config.generatedAt;
      if (!stale) {
        return {
          config: { ...config, stale: false },
          model,
        };
      }
      return {
        config: {
          ...config,
          stale: true,
          markets: Object.fromEntries(
            ["spf", "hhad", "goals"].map((market) => [
              market,
              {
                ...(config.markets?.[market] || {}),
                gate: {
                  ...(config.markets?.[market]?.gate || {}),
                  passed: false,
                  reason:
                    "历史数据已更新，挑战模型验证失效；重新训练前不生成机器学习概率",
                },
                production: unavailableChallenger(
                  "历史数据已更新，挑战模型验证失效",
                ),
              },
            ]),
          ),
          selection: {
            ...(config.selection || {}),
            markets: Object.fromEntries(
              ["spf", "hhad", "goals"].map((market) => {
                const value = config.selection?.markets?.[market] || {};
                return [
                  market,
                  {
                    ...value,
                    enabled: false,
                    gate: {
                      ...(value.gate || {}),
                      passed: false,
                      reason:
                        "历史数据已更新，选择性预测验证失效；重新训练前只显示谨慎参考",
                    },
                  },
                ];
              }),
            ),
          },
        },
        model: null,
      };
    } catch {
      return {
        config: {
          version: 0,
          generatedAt: null,
          stale: true,
          markets: Object.fromEntries(
            ["spf", "hhad", "goals"].map((market) => [
              market,
              {
                gate: {
                  passed: false,
                  reason: "尚未训练多市场机器学习挑战模型",
                },
                production: unavailableChallenger(
                  "尚未训练多市场机器学习挑战模型",
                ),
              },
            ]),
          ),
        },
        model: null,
      };
    }
  }

  const challengerArtifacts = loadChallengerArtifacts();
  function unavailableReliability(reason) {
    return {
      enabled: false,
      rule: null,
      test: null,
      gate: { passed: false, reason },
    };
  }

  function loadReliabilityConfig() {
    try {
      const config = JSON.parse(
        readFileSync(RELIABILITY_CONFIG_PATH, "utf8"),
      );
      const counts = dataStore.getCounts();
      const sourceUpdatedAt = dataStore.getHistoricalSourceUpdatedAt();
      const stale = !reliabilityValidationIsCurrent(config, {
        smoothingSignature: smoothingValidationSignature(productionPolicy.smoothing),
        verifiedMatches: counts.verifiedHistory,
        sourceUpdatedAt,
        matchingVersion: THREE_WAY_MATCHING_VERSION,
        goalMatchingVersion: GOAL_MATCHING_VERSION,
        probabilityPolicy: productionPolicy.probabilityPolicy,
        thresholds: productionPolicy.thresholds,
      });
      if (!stale) return { ...config, stale: false };
      const reason =
        "历史数据、生产阈值或匹配器已经更新，可靠性等级需要重新验证";
      return {
        ...config,
        stale: true,
        markets: Object.fromEntries(
          ["spf", "hhad", "goals"].map((market) => [
            market,
            {
              ...(config.markets?.[market] || {}),
              ...unavailableReliability(reason),
            },
          ]),
        ),
      };
    } catch {
      const reason = "尚未按当前生产匹配口径训练可靠性等级";
      return {
        version: 0,
        generatedAt: null,
        stale: true,
        data: null,
        markets: Object.fromEntries(
          ["spf", "hhad", "goals"].map((market) => [
            market,
            unavailableReliability(reason),
          ]),
        ),
      };
    }
  }

  const reliabilityConfig = loadReliabilityConfig();
  const challengerConfig = {
    ...challengerArtifacts.config,
    selectionStale: reliabilityConfig.stale,
    selection: reliabilityConfig,
  };
  const challengerEngine = challengerArtifacts.model
    ? createChallenger(challengerArtifacts.model)
    : null;

  function loadGoalPairSelectionConfig() {
    try {
      const config = JSON.parse(
        readFileSync(GOAL_PAIR_SELECTION_PATH, "utf8"),
      );
      const counts = dataStore.getCounts();
      const stale =
        !config.data?.sourceUpdatedAt ||
        config.data.sourceUpdatedAt !== dataStore.getHistoricalSourceUpdatedAt() ||
        Number(config.data?.goalHistory || 0) !== Number(counts.goalHistory) ||
        config.data?.goalMatchingVersion !== GOAL_MATCHING_VERSION;
      const currentStrategy = Number(config.version || 0) >= 2;
      const validated = Boolean(
        currentStrategy && config.gate?.passed && !stale,
      );
      const advisoryReason = !currentStrategy
        ? "最高两项新规则尚未重新滚动验证；验证状态仅作风险提示，不影响候选生成"
        : stale
          ? "历史数据已更新，最高两项规则需要重新滚动验证；不影响候选生成"
          : config.gate?.reason ||
            "最高两项规则尚无滚动验证结论；不影响候选生成";
      return {
        ...config,
        stale,
        enabled: true,
        validated,
        strategy: "top-two-historical-results",
        gate: {
          ...(config.gate || {}),
          passed: validated,
          advisory: true,
          reason: advisoryReason,
        },
      };
    } catch {
      return {
        version: 2,
        generatedAt: null,
        stale: true,
        enabled: true,
        validated: false,
        strategy: "top-two-historical-results",
        selected: null,
        gate: {
          passed: false,
          advisory: true,
          reason:
            "最高两项规则尚未生成滚动验证结果；不影响候选生成",
        },
      };
    }
  }

  const goalPairSelectionConfig = loadGoalPairSelectionConfig();
  productionPolicy.challenger = Object.fromEntries(
    ["spf", "hhad", "goals"].map((market) => {
      const config = challengerConfig.markets[market];
      const production =
        config.production || unavailableChallenger(config.gate?.reason);
      return [
        market,
        {
          ...production,
          enabled: productionPolicy.empiricalOnly
            ? false
            : Boolean(production.enabled),
          validated: Boolean(
            !productionPolicy.empiricalOnly && config.gate?.passed,
          ),
          reason: productionPolicy.empiricalOnly
            ? "当前采用相似历史概率主模型，多市场挑战模型仅保留研究结果"
            : config.gate?.reason,
          selectedCandidate: config.selectedCandidate || null,
        },
      ];
    }),
  );

  return { productionPolicy, STABILITY_THRESHOLDS, predictionMarketHistories,
    modelConfig, adaptiveConfig, segmentConfig, segmentConfigView, goalZeroConfigView,
    weightingConfig, movementConfig, smoothingConfig, reliabilityConfig,
    challengerConfig, challengerEngine, goalPairSelectionConfig,
    goalMultipleDistribution, goalEqualityDistribution };
}

const codeSignature = runtimeCodeSignature(ROOT);
const runtimeConfiguration = createRuntimeConfiguration({
  files: [MODEL_CONFIG_PATH, ADAPTIVE_CONFIG_PATH, SEGMENT_CONFIG_PATH,
    WEIGHTING_CONFIG_PATH, MOVEMENT_CONFIG_PATH, SMOOTHING_CONFIG_PATH,
    SMOOTHING_PRODUCTION_PATH, ADAPTIVE_PRODUCTION_PATH, WEIGHTING_PRODUCTION_PATH,
    MOVEMENT_PRODUCTION_PATH, THREE_WAY_PROBABILITY_CONFIG_PATH,
    CHALLENGER_CONFIG_PATH, CHALLENGER_MODEL_PATH, RELIABILITY_CONFIG_PATH, GOAL_PAIR_SELECTION_PATH],
  sourceVersion: () => dataStore.getHistoricalSourceUpdatedAt(),
  load: loadRuntimeConfiguration,
});
let runtime = runtimeConfiguration.get();
let { productionPolicy, STABILITY_THRESHOLDS, predictionMarketHistories,
  modelConfig, adaptiveConfig, segmentConfig, segmentConfigView, goalZeroConfigView,
  weightingConfig, movementConfig, smoothingConfig, reliabilityConfig,
  challengerConfig, challengerEngine, goalPairSelectionConfig,
  goalMultipleDistribution, goalEqualityDistribution } = runtime.value;

function refreshRuntimeConfiguration() {
  const next = runtimeConfiguration.get();
  if (next === runtime) return;
  ({ productionPolicy, STABILITY_THRESHOLDS, predictionMarketHistories,
    modelConfig, adaptiveConfig, segmentConfig, segmentConfigView, goalZeroConfigView,
    weightingConfig, movementConfig, smoothingConfig, reliabilityConfig,
    challengerConfig, challengerEngine, goalPairSelectionConfig,
    goalMultipleDistribution, goalEqualityDistribution } = next.value);
  runtime = next;
}

function runtimeView() {
  return { revision: runtime.revision, codeSignature, databaseIdentity: databaseIdentity(DATABASE_PATH) };
}

function movementOptions(market, usesRecommendedThreshold = true) {
  const policy = productionPolicy.movement[market];
  const enabled = Boolean(
    !productionPolicy.empiricalOnly &&
      policy.enabled &&
      usesRecommendedThreshold,
  );
  return {
    applyCorrection: enabled,
    fixedWeight: policy.fixedWeight,
    minSamples: policy.minSamples,
    validation: {
      validated: Boolean(enabled && policy.validated),
      enabled,
      significanceStatus: policy.significanceStatus,
      reason: productionPolicy.empiricalOnly && policy.enabled
        ? "当前采用相似历史概率主模型，初终赔走势仅作参考"
        : !usesRecommendedThreshold && policy.enabled
          ? "当前手动阈值未经过走势验证，仅展示走势参考"
          : policy.reason,
    },
  };
}

function smoothingOptions(market, prior, usesRecommendedThreshold = true) {
  const policy = productionPolicy.smoothing[market];
  const enabled = Boolean(policy.enabled && usesRecommendedThreshold);
  const strength = enabled
    ? Number(policy.strength || 0)
    : Number(policy.referenceStrength || policy.strength || 0);
  return {
    enabled,
    validated: Boolean(policy.validated && usesRecommendedThreshold),
    strength,
    strengthMode: enabled ? policy.strengthMode || "fixed" : "fixed",
    dynamicNumerator: Number(policy.dynamicNumerator || 20),
    minStrength: Number(policy.minStrength || 1),
    maxStrength: Number(policy.maxStrength || 20),
    prior,
    reason: !usesRecommendedThreshold && policy.enabled
      ? "当前手动阈值未经过平滑验证，稳定概率仅供参考"
      : policy.reason,
  };
}

function modelDecision(
  market,
  threshold,
  {
    sameLeague = false,
    adaptive = false,
    segmented = false,
    zeroOdds = false,
  } = {},
) {
  const recommendation = modelConfig.markets[market];
  const productionThreshold = productionPolicy.thresholds[market];
  const weighting = productionPolicy.weighting[market];
  const usesRecommendedThreshold =
    adaptive ||
    segmented ||
    zeroOdds ||
    Math.abs(Number(threshold) - Number(productionThreshold)) < 1e-9;
  const weightingEnabled = Boolean(
    !productionPolicy.empiricalOnly &&
      weighting.enabled &&
      usesRecommendedThreshold,
  );
  const calibration = productionPolicy.historicalCalibration;
  return {
    policy: productionPolicy.probabilityPolicy,
    recommendedThreshold: productionThreshold,
    usesRecommendedThreshold,
    gatePassed: Boolean(recommendation.gate.passed),
    thresholdChanged: Boolean(recommendation.changed),
    thresholdValidation: {
      current: Number(recommendation.currentThreshold),
      candidate: Number(recommendation.candidateThreshold),
      production: productionThreshold,
      passed: Boolean(recommendation.gate.passed),
      reason: recommendation.gate.reason,
    },
    userOverride: true,
    enabled: calibration.enabled,
    empiricalOnly: productionPolicy.empiricalOnly,
    fixedWeight: null,
    maxWeight: calibration.maxWeight,
    scale: calibration.scale,
    requireSamples: calibration.requireSamples,
    minSamples: productionPolicy.minimumSamples,
    sameLeague,
    weighting: {
      tolerance: Number(threshold),
      ...weighting,
      enabled: weightingEnabled,
      validated: Boolean(
        weighting.validated && usesRecommendedThreshold,
      ),
    },
    reason:
      "最终预测采用当前所选联赛范围内的相似历史赛果占比；终赔去水概率单独展示，仅作赔率参考",
  };
}

function resolveSimilarity(
  market,
  history,
  targetOdds,
  requestedTolerance,
  finder,
  { sameLeague = false, finderOptions = {} } = {},
) {
  const adaptivePolicy = productionPolicy.adaptive[market];
  const segmentPolicy = productionPolicy.segments[market];
  const usesProductionMaximum =
    Math.abs(
      Number(requestedTolerance) -
        Number(productionPolicy.thresholds[market]),
    ) < 1e-9;
  const segment =
    market === "goals"
      ? classifyGoalOdds(targetOdds)
      : classifyThreeWayOdds(targetOdds);
  const selectedSegment = segmentPolicy?.policies?.[segment];
  if (market === "goals") {
    const zeroOddsTolerance = sameLeague
      ? SAME_LEAGUE_GOAL_ZERO_ODDS_TOLERANCE
      : GOAL_ZERO_ODDS_TOLERANCE;
    const resolved = selectProductionGoalSimilarity(history, {
      odds: targetOdds,
      initialOdds: finderOptions.targetInitialOdds,
      league: finderOptions.league,
    }, {
      intervals: productionPolicy.zeroGoals.intervals,
      policies: productionPolicy.zeroGoals.policies,
      zeroOddsTolerance,
      sameLeague,
    });
    return {
      threshold: requestedTolerance,
      similar: resolved.similar,
      samples: resolved.similar.length,
      minSamples: null,
      reachedMinSamples: null,
      attempts: [],
      adaptive: false,
      segmented: false,
      zeroOdds: true,
      zeroOddsBlocked: false,
      zeroOddsInterval: resolved.interval,
      zeroOddsWindow: resolved.zeroOddsWindow,
      zeroOddsPolicy: resolved.policy,
      goalWeighting: resolved.weighting,
      sameLeague,
      segment,
      reason:
        `${sameLeague ? "同联赛" : "全部联赛"}统一使用0球赔率±${zeroOddsTolerance.toFixed(2)}，` +
        "全部合格样本按终赔、初赔、走势和隐含进球综合距离加权",
    };
  }
  const segmented =
    Boolean(selectedSegment?.enabled) &&
    !segmentConfig.stale &&
    !sameLeague &&
    usesProductionMaximum;
  if (segmented) {
    const threshold = Number(selectedSegment.threshold);
    const similar = finder(history, targetOdds, {
      ...finderOptions,
      tolerance: threshold,
    });
    return {
      threshold,
      similar,
      samples: similar.length,
      minSamples: null,
      reachedMinSamples: null,
      attempts: [{ threshold, samples: similar.length }],
      adaptive: false,
      segmented: true,
      zeroOdds: false,
      segment,
      reason: selectedSegment.gate?.reason || "该赔率类型已通过分组验证",
    };
  }
  const enabled =
    Boolean(adaptivePolicy?.enabled) &&
    !adaptiveConfig.stale &&
    !sameLeague &&
    usesProductionMaximum;
  if (!enabled) {
    const similar = finder(history, targetOdds, {
      ...finderOptions,
      tolerance: requestedTolerance,
    });
    return {
      threshold: requestedTolerance,
      similar,
      samples: similar.length,
      minSamples: null,
      reachedMinSamples: null,
      attempts: [
        { threshold: requestedTolerance, samples: similar.length },
      ],
      adaptive: false,
      segmented: false,
      zeroOdds: false,
      segment,
      reason: sameLeague
        ? "同联赛范围尚未单独验证动态样本规则"
        : !usesProductionMaximum
          ? "当前手动范围不使用动态样本规则"
          : selectedSegment?.gate?.reason ||
            adaptivePolicy?.reason ||
            "该赔率类型继续使用全局范围",
    };
  }
  return {
    ...selectAdaptiveSimilarity(history, targetOdds, {
      thresholds: adaptivePolicy.thresholds,
      minSamples: adaptivePolicy.minSamples,
      finder,
      finderOptions,
    }),
    adaptive: true,
    segmented: false,
    zeroOdds: false,
    segment,
    reason: adaptivePolicy.reason,
  };
}

function adaptiveScopeView(scope) {
  if (!scope) return null;
  return {
    enabled: Boolean(scope.adaptive),
    segmented: Boolean(scope.segmented),
    segment: scope.segment || "unknown",
    threshold: Number(scope.threshold),
    samples: Number(scope.samples),
    minSamples:
      scope.minSamples === null ? null : Number(scope.minSamples),
    reachedMinSamples:
      scope.reachedMinSamples === null
        ? null
        : Boolean(scope.reachedMinSamples),
    attempts: scope.attempts || [],
    reason: scope.reason,
  };
}

function segmentScopeView(scope) {
  if (!scope) return null;
  return {
    enabled: Boolean(scope.segmented),
    segment: scope.segment || "unknown",
    threshold: Number(scope.threshold),
    samples: Number(scope.samples),
    reason: scope.reason,
  };
}

function zeroOddsScopeView(scope) {
  if (!scope) return null;
  const interval = scope.zeroOddsInterval;
  const window = scope.zeroOddsWindow;
  const policy = scope.zeroOddsPolicy;
  return {
    enabled: Boolean(scope.zeroOdds),
    blocked: Boolean(scope.zeroOddsBlocked),
    intervalId: interval?.id || null,
    intervalLabel: window?.label || null,
    target: window?.target ?? null,
    tolerance: window?.tolerance ?? null,
    lower: window?.lower ?? null,
    upper: window?.upper ?? null,
    observedMin: interval?.observedMin ?? null,
    observedMax: interval?.observedMax ?? null,
    distanceEnabled: Boolean(policy?.enabled),
    threshold:
      policy?.threshold === null || policy?.threshold === undefined
        ? null
        : Number(policy.threshold),
    samples: Number(scope.samples || 0),
    sameLeague: Boolean(scope.sameLeague),
    usesAllSamples: Boolean(scope.goalWeighting?.usesAllSamples),
    sampleLimit: scope.goalWeighting?.sampleLimit ?? null,
    distanceMethod: scope.goalWeighting?.method || null,
    bandwidth: scope.goalWeighting?.bandwidth ?? null,
    reason: policy?.gate?.reason || scope.reason,
  };
}

function blendOptions(decision, smoothing = null) {
  // 历史先验平滑有独立批准，不应被历史/市场混合模型的旧开关拦截。
  const effectiveSmoothing = decision.enabled || decision.empiricalOnly
    ? smoothing
    : smoothing
      ? {
          ...smoothing,
          enabled: false,
          reason: productionPolicy.empiricalOnly
            ? "相似历史概率主模型直接使用当前样本的原始赛果占比"
            : "终赔赔率主模型不使用历史平滑改变最终概率",
        }
      : smoothing;
  return {
    enabled: decision.enabled,
    fixedWeight: decision.fixedWeight,
    minSamples: decision.minSamples,
    maxWeight: decision.maxWeight,
    scale: decision.scale,
    empiricalOnly: decision.empiricalOnly,
    requireSamples: decision.requireSamples,
    weighting: decision.weighting,
    smoothing: decision.sameLeague && effectiveSmoothing
      ? { ...effectiveSmoothing, enabled: false, validated: false, reason: "平滑仅验证全部联赛范围，同联赛暂不启用" }
      : effectiveSmoothing,
    zeroCellFloor: productionPolicy.zeroCellFloor.enabled
      ? { priorMass: productionPolicy.zeroCellFloor.priorMass }
      : { priorMass: 0 },
  };
}

function numberParam(searchParams, name, fallback, min, max) {
  const raw = searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function weightDetail(row, prediction) {
  const precomputedWeight = prediction.weighting.weightField
    ? Number(row[prediction.weighting.weightField])
    : Number.NaN;
  const weight = Number.isFinite(precomputedWeight) && precomputedWeight > 0
    ? precomputedWeight
    : distanceWeight(row.distance, prediction.weighting);
  return {
    distance: row.distance,
    weight,
    contribution: prediction.weighting.totalWeight
      ? weight / prediction.weighting.totalWeight
      : 0,
  };
}

function compactSpfRow(row, prediction) {
  return {
    matchKey: row.matchKey,
    league: row.league,
    home: row.home,
    away: row.away,
    score: row.score,
    result: row.result,
    handicap: row.handicap,
    odds: row.odds,
    initialOdds: row.initialOdds,
    zeroOddsDistance: row.zeroOddsDistance,
    distanceComponents: row.distanceComponents,
    totalGoals: row.totalGoals,
    similarity: 1 - row.distance,
    ...weightDetail(row, prediction),
  };
}

function compactGoalRow(row, prediction) {
  return {
    matchKey: row.matchKey,
    league: row.league,
    home: row.home,
    away: row.away,
    goals: row.goals,
    score: row.score,
    result: row.result,
    odds: row.odds,
    initialOdds: row.initialOdds,
    zeroOddsDistance: row.zeroOddsDistance,
    distanceComponents: row.distanceComponents,
    similarity: Number(row.similarityWeight || 0),
    ...weightDetail(row, prediction),
  };
}

function computeScoreDistribution(rows, maxItems = 4) {
  const counts = new Map();
  let totalWeight = 0;
  for (const row of rows) {
    if (!row.score) continue;
    const normalized = String(row.score).replace(":", "-").trim();
    if (!/^\d+-\d+$/.test(normalized)) continue;
    const weight = Number(row.weight ?? 1);
    counts.set(normalized, (counts.get(normalized) || 0) + weight);
    totalWeight += weight;
  }
  if (!totalWeight) return [];
  const list = [];
  for (const [score, weight] of counts.entries()) {
    list.push({
      score,
      count: Math.round(weight),
      probability: weight / totalWeight,
    });
  }
  list.sort((a, b) => b.probability - a.probability);
  return list.slice(0, maxItems);
}

function stabilityPoint(threshold, prediction) {
  const historicalProbabilities = prediction.weightedEmpirical?.length
    ? prediction.weightedEmpirical
    : prediction.empirical || [];
  const historicalTopProbability = prediction.available
    ? Math.max(...historicalProbabilities)
    : null;
  const historicalTopLabels = prediction.available
    ? prediction.labels.filter(
        (_, index) =>
          Math.abs(historicalProbabilities[index] - historicalTopProbability) <
          1e-12,
      )
    : [];
  const historicalIsTie = historicalTopLabels.length > 1;
  const historicalPredicted =
    historicalTopLabels.length === 1 ? historicalTopLabels[0] : null;
  const predictedIndex = prediction.labels.indexOf(prediction.predicted);
  return {
    threshold,
    labels: prediction.labels,
    available: prediction.available,
    predicted: prediction.predicted,
    topLabels: prediction.topLabels,
    isTie: prediction.isTie,
    probabilities: prediction.final,
    topProbability: prediction.available
      ? Math.max(...prediction.final)
      : null,
    historicalProbabilities,
    historicalTopLabels,
    historicalPredicted,
    historicalIsTie,
    historicalTopProbability,
    supportsFinal:
      prediction.available &&
      !historicalIsTie &&
      historicalPredicted === prediction.predicted,
    supportProbability:
      prediction.available && predictedIndex >= 0
        ? historicalProbabilities[predictedIndex]
        : null,
    samples: prediction.stats.total,
    coreSamples: prediction.weighting.coreSamples,
    effectiveSamples: prediction.weighting.effectiveSamples,
  };
}

function historicalMethodText(prediction, weightedDescription) {
  if (!prediction.available) return "没有相似历史比赛，本场不生成预测";
  const historyWeight = Number(prediction.empiricalWeight || 0);
  if (historyWeight >= 1 - 1e-12) {
    const sampleText =
      `最终概率采用当前范围内 ${prediction.stats.total.toLocaleString()} 场相似比赛`;
    return prediction.weighting.enabled
      ? `${sampleText}按综合距离加权的赛果占比（加权等效 ${prediction.weighting.effectiveSamples.toFixed(1)} 场）；终赔去水概率单独展示，仅作赔率参考`
      : `${sampleText}等权赛果占比；终赔去水概率单独展示，仅作赔率参考`;
  }
  if (historyWeight <= 1e-12) {
    return (
      "最终概率100%采用终赔去水概率；" +
      `${prediction.stats.total.toLocaleString()} 场相似历史仅用于样本门槛、可靠性和结果核对`
    );
  }
  const blendText =
    `终赔去水概率占 ${((1 - historyWeight) * 100).toFixed(1)}%，` +
    `${prediction.stats.total.toLocaleString()} 场相似历史校准占 ${(historyWeight * 100).toFixed(1)}%`;
  if (!prediction.weighting.enabled) {
    return `${blendText}；历史样本使用等权统计`;
  }
  return `${blendText}；历史池${weightedDescription}，核心 ${prediction.weighting.coreSamples.toLocaleString()} 场、加权等效 ${prediction.weighting.effectiveSamples.toFixed(1)} 场`;
}

function movementMethodText(prediction) {
  const movement = prediction.movement;
  if (movement?.applied) {
    return `初赔走势验证通过，使用 ${movement.sampleSize.toLocaleString()} 场走势样本按 ${(movement.weight * 100).toFixed(1)}% 修正`;
  }
  if (movement?.referenceOnly) {
    return `初赔走势未通过严格验证，${movement.sampleSize.toLocaleString()} 场走势样本仅供参考`;
  }
  if (movement?.reason === "missing-initial") {
    return "本场缺少完整初赔，不做走势修正";
  }
  if (movement?.reason === "no-change") {
    return "本场初赔与终赔没有有效变化，不做走势修正";
  }
  if (movement?.reason === "included-in-composite-distance") {
    return "初赔及其到终赔的走势已计入综合相似距离，不再重复修正概率";
  }
  return "没有匹配到走势样本，不做走势修正";
}

function smoothingMethodText(prediction) {
  const smoothing = prediction.smoothing;
  if (!prediction.available || !smoothing || !smoothing.strength) {
    return "没有应用小样本平滑";
  }
  const source = smoothing.prior.sourceLabel;
  const detail =
    `${source} ${smoothing.prior.sampleSize.toLocaleString()} 场、先验强度 ${smoothing.strength}`;
  if (
    !smoothing.applied &&
    smoothing.reason === "相似历史概率主模型直接使用当前样本的原始赛果占比"
  ) {
    return "主预测直接使用当前样本的原始赛果占比，不应用历史先验平滑";
  }
  if (
    !smoothing.applied &&
    smoothing.reason === "终赔赔率主模型不使用历史平滑改变最终概率"
  ) {
    return "历史平滑仅保留参考，终赔赔率主模型不使用它改变最终概率";
  }
  return smoothing.applied
    ? `小样本平滑通过严格验证，已使用${detail}`
    : `小样本平滑未通过严格验证，${detail}，仅供参考`;
}

function threeWayMethodText(result, market) {
  if (!result) {
    return market === "spf"
      ? "竞彩未开售普通胜平负，本场不生成该玩法预测"
      : "缺少让球胜平负赔率";
  }
  if (result.matchingMode === "joint-unavailable") {
    return "胜平负与让球必须使用同一批双盘口历史比赛；当前联合样本不足，两套历史概率均不生成";
  }
  const prediction = result.prediction;
  if (result.matchingMode === "joint") {
    return (
      `${result.matchingLabel}；两个盘口同时命中当前相似范围；` +
      `${historicalMethodText(prediction, "使用同一批双盘口样本")}；` +
      "胜平负直接统计普通赛果，让球胜平负直接统计让球赛果，两者不相加也不由比分互相派生；" +
      `${smoothingMethodText(prediction)}；${movementMethodText(prediction)}`
    );
  }
  const handicapText = market === "hhad"
    ? `让球数 ${result.handicap > 0 ? "+" : ""}${result.handicap}，`
    : "";
  return (
    `${result.matchingLabel}；${handicapText}三项赔率相对误差均不超过 ±${(
      result.tolerance * 100
    ).toFixed(0)}%；` +
    `${historicalMethodText(prediction, "按赔率距离加权")}；` +
    `${smoothingMethodText(prediction)}；${movementMethodText(prediction)}`
  );
}

function zeroOddsMethodText(scope, prediction) {
  const window = scope?.zeroOddsWindow;
  if (!scope?.zeroOdds || !window) return "";
  const label = window.label ||
    `${Number(window.lower).toFixed(2)}～${Number(window.upper).toFixed(2)}`;
  return (
    `0球赔率先按与当前值相差不超过 ${Number(window.tolerance).toFixed(2)} 筛选（${label}），` +
    "再比较终赔60%、初赔15%、走势15%和隐含进球10%的综合距离；" +
    `${historicalMethodText(prediction, "全部合格样本按综合距离加权")}`
  );
}

function historicalPriorFor(
  history,
  target,
  market,
  {
    labels,
    outcomeField,
    distance,
    compatible = () => true,
    threshold,
  },
) {
  const policy = productionPolicy.smoothing[market];
  if (policy.priorMode === "adjusted-market") {
    const marketPrior = adjustedThreeWayMarketPrior(target.odds, market);
    if (marketPrior) return marketPrior;
  }
  if (market === "spf" || market === "hhad") {
    return selectThreeWayHistoricalPrior(history, target, market, {
      threshold, relaxedMultiplier: Number(policy.relaxedMultiplier || 2),
      minLocalizedSamples: Number(policy.minLocalizedSamples || 30),
    });
  }
  return selectHistoricalPrior(history, target, {
    labels,
    outcomeField,
    distance,
    compatible,
    relaxedTolerance:
      threshold * Number(policy.relaxedMultiplier || 2),
    minLocalizedSamples: Number(policy.minLocalizedSamples || 30),
  });
}

function buildSpfStability(
  history,
  odds,
  market,
  league,
  similarAtThreshold = null,
  sameLeague = false,
  selectedThreshold = null,
  handicap = null,
) {
  const points = STABILITY_THRESHOLDS[market].map((threshold) => {
    const similar = similarAtThreshold
      ? similarAtThreshold(threshold)
      : findSimilarSpf(history, odds, {
          tolerance: threshold,
          league,
          sameLeague,
        });
    const decision = modelDecision(market, threshold, { sameLeague });
    const prior = historicalPriorFor(
      history,
      { odds, league, handicap },
      market,
      {
        labels: ["胜", "平", "负"],
        outcomeField: "result",
        distance: (left, right) => spfDistance(left.odds, right.odds),
        threshold,
      },
    );
    const prediction = predictSpf(odds, similar, {
      ...blendOptions(
        decision,
        smoothingOptions(market, prior, decision.usesRecommendedThreshold),
      ),
    });
    return stabilityPoint(threshold, prediction);
  });
  return summarizeHistoricalSupport(points, selectedThreshold);
}

function buildThreeWayStability(
  match,
  {
    spfHistory,
    hhadHistory,
    pairedHistory,
    spfResult,
    hhadResult,
    sameLeague = false,
  },
) {
  const hadOdds = match.had
    ? [match.had.h, match.had.d, match.had.a]
    : null;
  const hhadOdds = match.hhad
    ? [match.hhad.h, match.hhad.d, match.hhad.a]
    : null;
  const usesJoint =
    spfResult?.matchingMode === "joint" &&
    hhadResult?.matchingMode === "joint" &&
    hadOdds &&
    hhadOdds;

  if (!usesJoint) {
    return {
      spf: hadOdds
        ? buildSpfStability(
            spfHistory,
            hadOdds,
            "spf",
            match.league,
            null,
            sameLeague,
            spfResult?.tolerance,
          )
        : null,
      hhad: hhadResult
        ? buildSpfStability(
            hhadHistory.filter(
              (row) => row.handicap === hhadResult.handicap,
            ),
            hhadOdds,
            "hhad",
            match.league,
            null,
            sameLeague,
            hhadResult?.tolerance,
            hhadResult.handicap,
          )
        : null,
    };
  }

  const handicap = hhadResult.handicap;
  const jointSimilar = (market, threshold) => {
    const selection = selectThreeWaySimilarity(
      match,
      { spfHistory, hhadHistory, pairedHistory },
      {
        spfTolerance:
          market === "spf" ? threshold : spfResult.tolerance,
        hhadTolerance:
          market === "hhad" ? threshold : hhadResult.tolerance,
        sameLeague,
      },
    );
    return selection[market]?.similar || [];
  };
  return {
    spf: buildSpfStability(
      spfHistory,
      hadOdds,
      "spf",
      match.league,
      (threshold) => jointSimilar("spf", threshold),
      sameLeague,
      spfResult?.tolerance,
    ),
    hhad: buildSpfStability(
      hhadHistory,
      hhadOdds,
      "hhad",
      match.league,
      (threshold) => jointSimilar("hhad", threshold),
      sameLeague,
      hhadResult?.tolerance,
      handicap,
    ),
  };
}

function buildGoalStability(
  history,
  odds,
  initialOdds,
  league,
  sameLeague = false,
) {
  const resolved = selectProductionGoalSimilarity(history, {
    odds,
    initialOdds,
    league,
  }, {
    intervals: productionPolicy.zeroGoals.intervals,
    policies: productionPolicy.zeroGoals.policies,
    sameLeague,
  });
  const decision = modelDecision("goals", productionPolicy.thresholds.goals, {
    sameLeague,
    zeroOdds: true,
  });
  const points = PRODUCTION_GOAL_POOL_FRACTIONS.map((fraction) => {
    const sampleSize = resolved.similar.length
      ? Math.max(1, Math.ceil(resolved.similar.length * fraction))
      : 0;
    const similar = resolved.similar.slice(0, sampleSize);
    const prediction = predictProductionGoals(odds, resolved, {
      samples: similar,
      blendOptions: blendOptions(
        decision,
        smoothingOptions("goals", null, decision.usesRecommendedThreshold),
      ),
    });
    return stabilityPoint(fraction, prediction);
  });
  return {
    ...summarizeHistoricalSupport(points, 1),
    mode: "composite-distance-pool",
  };
}

function buildGoalPairStability(
  history,
  odds,
  initialOdds,
  league,
  sameLeague = false,
) {
  const resolved = selectProductionGoalSimilarity(history, {
    odds,
    initialOdds,
    league,
  }, {
    intervals: productionPolicy.zeroGoals.intervals,
    policies: productionPolicy.zeroGoals.policies,
    sameLeague,
  });
  const decision = modelDecision("goals", productionPolicy.thresholds.goals, {
    sameLeague,
    zeroOdds: true,
  });
  const points = PRODUCTION_GOAL_POOL_FRACTIONS.map((fraction) => {
    const sampleSize = resolved.similar.length
      ? Math.max(1, Math.ceil(resolved.similar.length * fraction))
      : 0;
    const similar = resolved.similar.slice(0, sampleSize);
    const prediction = predictProductionGoals(odds, resolved, {
      samples: similar,
      blendOptions: blendOptions(
        decision,
        smoothingOptions("goals", null, decision.usesRecommendedThreshold),
      ),
    });
    const pair = selectTopGoalPair(prediction.final, odds);
    return {
      threshold: fraction,
      available: pair.available,
      labels: pair.labels,
      probability: pair.probability,
      samples: prediction.stats.total,
    };
  });
  const signatures = points
    .filter((point) => point.available)
    .map((point) => [...point.labels].sort().join("/"));
  return {
    stable:
      signatures.length === points.length &&
      new Set(signatures).size === 1,
    points,
    signature: signatures[0] || null,
  };
}

function verifiedSpfRows(history) {
  return history.map((row) => ({
    matchKey: row.matchKey,
    league: row.league,
    home: row.home,
    away: row.away,
    score: row.score,
    result: row.spf.result,
    handicap: row.spf.handicap,
    totalGoals: row.totalGoals,
    initialOdds: row.spf.initialOdds,
    odds: row.spf.odds,
  }));
}

function verifiedHhadRows(history, handicap) {
  return history
    .filter((row) => row.hhad.handicap === handicap)
    .map((row) => ({
      matchKey: row.matchKey,
      league: row.league,
      home: row.home,
      away: row.away,
      score: row.score,
      result: row.hhad.result,
      handicap: row.hhad.handicap,
      totalGoals: row.totalGoals,
      initialOdds: row.hhad.initialOdds,
      odds: row.hhad.odds,
    }));
}

function verifiedGoalRows(history) {
  return history.map((row) => ({
    matchKey: row.matchKey,
    league: row.league,
    home: row.home,
    away: row.away,
    score: row.score,
    result: row.spf.result,
    goals: row.goals,
    initialOdds: row.goalMarket.initialOdds,
    odds: row.goalMarket.odds,
  }));
}

function threeWayOdds(point, fallback) {
  return point
    ? [point.h, point.d, point.a]
    : [fallback.h, fallback.d, fallback.a];
}

function goalOdds(point, fallback) {
  const source = point || fallback;
  return [
    source.g0,
    source.g1,
    source.g2,
    source.g3,
    source.g4,
    source.g5,
    source.g6,
    source.g7plus,
  ];
}

function handicapNumber(market) {
  const value = Number(market?.goalLine);
  return Number.isFinite(value) ? value : null;
}

function challengerView(market, result) {
  const config = challengerConfig.markets?.[market];
  const policy = productionPolicy.challenger[market];
  if (!result?.probabilities?.length || !config) {
    return {
      available: false,
      enabled: false,
      validated: false,
      probabilities: [],
      predicted: null,
      topLabels: [],
      isTie: false,
      selectedCandidate: policy?.selectedCandidate || null,
      gate: config?.gate || {
        passed: false,
        reason: policy?.reason || "挑战模型不可用",
      },
      test: config?.test || null,
      significance: config?.significance || null,
    };
  }
  const highest = Math.max(...result.probabilities);
  const topLabels = result.labels.filter(
    (_, index) =>
      Math.abs(result.probabilities[index] - highest) < 1e-12,
  );
  return {
    available: true,
    enabled: Boolean(policy.enabled),
    validated: Boolean(policy.validated),
    probabilities: result.probabilities,
    predicted: topLabels[0] || null,
    topLabels,
    isTie: topLabels.length > 1,
    selectedCandidate: result.selectedCandidate,
    gate: config.gate,
    test: config.test,
    significance: config.significance,
  };
}

function attachChallenger(prediction, market, result) {
  const challenger = challengerView(market, result);
  if (!challenger.available || !challenger.enabled) {
    return {
      ...prediction,
      productionModel:
        prediction.productionModel || "historical-similarity",
      challenger,
    };
  }
  const probabilities = challenger.probabilities;
  const common = {
    ...prediction,
    baselineFinal: [...prediction.final],
    final: probabilities,
    predicted: challenger.predicted,
    topLabels: challenger.topLabels,
    isTie: challenger.isTie,
    confidence: confidenceLabel(
      probabilities,
      prediction.weighting.effectiveSamples,
    ),
    productionModel: "multi-market-random-forest",
    challenger,
  };
  if (market !== "goals") return common;
  const ranked = probabilities
    .map((value, index) => ({ value, index }))
    .sort((left, right) => right.value - left.value);
  return {
    ...common,
    topThree: ranked
      .slice(0, 3)
      .map(({ index }) => GOAL_LABELS[index]),
    expected: probabilities.reduce(
      (sum, probability, index) =>
        sum + probability * (index === 7 ? 7.5 : index),
      0,
    ),
    goalPair: selectTopGoalPair(probabilities),
  };
}

function attachMarketComparison(prediction, odds, selectionSize = 1) {
  if (!prediction) return prediction;
  return {
    ...prediction,
    marketComparison: compareHistoricalToMarket(
      prediction.labels,
      odds,
      prediction.final,
      {
        available: prediction.available,
        selectionSize,
      },
    ),
  };
}

function reliabilityView(
  market,
  prediction,
  stability,
  { threshold, sameLeague = false } = {},
) {
  const policy = challengerConfig.selection?.markets?.[market];
  const result = evaluateReliability({
    prediction,
    stability,
    policy,
    threshold,
    sameLeague,
  });
  const status = !reliabilityConfig.generatedAt ? "unvalidated"
    : challengerConfig.selectionStale ? "stale"
      : !prediction?.available || !result.observed.samples ? "insufficient"
        : !policy?.enabled ? "not-passed"
          : sameLeague || Math.abs(Number(threshold) - Number(policy.rule?.threshold)) > 1e-9 ? "unsupported-scope"
            : result.level === "recommended" ? "passed"
              : result.observed.samples < Number(policy.rule?.minSamples) ? "insufficient" : "not-selected";
  return { ...result, validation: { status, kind: "single", generatedAt: reliabilityConfig.generatedAt || null } };
}

function ledgerPolicyVersion({ sameLeague = false } = {}) {
  const validation = challengerConfig.selectionStale ? ":pending-validation" : "";
  const scope = sameLeague ? ":same-league" : ":all-leagues";
  return `${productionPolicy.probabilityPolicy}:selection-v${reliabilityConfig.version || 0}@${reliabilityConfig.generatedAt || "untrained"}${validation}${scope}`;
}

function ledgerPolicyPrefix() {
  return `${productionPolicy.probabilityPolicy}:`;
}

function ledgerCurrentSnapshotPolicyVersions() {
  return [false, true].flatMap(sameLeague =>
    ["standard", "goalsPair"].map(mode => ledgerParlayAlgorithmVersion(mode, { sameLeague })));
}

function ledgerParlayAlgorithmVersion(mode, settings = {}) {
  const scope = settings.sameLeague ? "same-league" : "all-leagues";
  const spf = Number(settings.spfTolerance ?? productionPolicy.thresholds.spf);
  const hhad = Number(settings.hhadTolerance ?? productionPolicy.thresholds.hhad);
  const model = mode === "goalsPair"
    ? `${GOAL_MATCHING_VERSION}:zero-${settings.sameLeague ? SAME_LEAGUE_GOAL_ZERO_ODDS_TOLERANCE : GOAL_ZERO_ODDS_TOLERANCE}:top-two-v1`
    : `${THREE_WAY_MATCHING_VERSION}:spf-${spf}:hhad-${hhad}`;
  const smooth = (mode === "goalsPair" ? ["goals"] : ["spf", "hhad"]).map(market => {
    const token = smoothingPolicyToken(productionPolicy.smoothing[market], {
      sameLeague: Boolean(settings.sameLeague),
      usesRecommendedThreshold: market === "goals" || Math.abs((market === "spf" ? spf : hhad) - productionPolicy.thresholds[market]) < 1e-9,
    });
    return token ? `:${market}${token}` : "";
  }).join("");
  return `${productionPolicy.probabilityPolicy}:parlay:${mode}:${model}:${scope}${smooth}`;
}

function ledgerAlgorithmVersion(market, { sameLeague = false } = {}) {
  const scope = sameLeague ? "same-league" : "all-leagues";
  const smooth = smoothingPolicyToken(productionPolicy.smoothing[market], { sameLeague });
  if (market === "goalMultiple") {
    return `${productionPolicy.probabilityPolicy}:${GOAL_MULTIPLE_VERSION}:${scope}`;
  }
  if (market === "goals") {
    const tolerance = sameLeague
      ? SAME_LEAGUE_GOAL_ZERO_ODDS_TOLERANCE
      : GOAL_ZERO_ODDS_TOLERANCE;
    return `${productionPolicy.probabilityPolicy}:goals:${GOAL_MATCHING_VERSION}:zero-${tolerance.toFixed(2)}:${scope}${smooth}`;
  }
  const threshold = Number(productionPolicy.thresholds[market] || 0);
  return `${productionPolicy.probabilityPolicy}:${market}:${THREE_WAY_MATCHING_VERSION}:tolerance-${(threshold * 100).toFixed(2)}pct:${scope}${smooth}`;
}

function ledgerCurrentAlgorithmSpec() {
  return {
    probabilityPolicy: productionPolicy.probabilityPolicy,
    thresholds: { ...productionPolicy.thresholds },
    goalZeroToleranceAll: GOAL_ZERO_ODDS_TOLERANCE,
    goalZeroToleranceSameLeague: SAME_LEAGUE_GOAL_ZERO_ODDS_TOLERANCE,
    versions: Object.fromEntries(
      ["spf", "hhad", "goals", "goalMultiple"].map((market) => [
        market,
        {
          all: ledgerAlgorithmVersion(market, { sameLeague: false }),
          sameLeague:
            market === "goalMultiple"
              ? null
              : ledgerAlgorithmVersion(market, { sameLeague: true }),
        },
      ]),
    ),
  };
}

function ledgerCurrentAlgorithmVersions() {
  const versions = ledgerCurrentAlgorithmSpec().versions;
  return [...new Set(
    Object.values(versions)
      .flatMap((scopes) => Object.values(scopes))
      .filter(Boolean),
  )];
}

function ledgerEvidenceLayer(summary) {
  const totals = summary?.totals || {};
  return {
    settledFixtures: Number(totals.coreSettledFixtures || 0),
    pendingFixtures: Number(totals.corePendingFixtures || 0),
    settledPredictions: Number(totals.coreSettled || 0),
    allLeaguePredictions: Number(summary?.coreByScope?.all?.settled || 0),
    sameLeaguePredictions: Number(
      summary?.coreByScope?.sameLeague?.settled || 0,
    ),
    sampleLevel: totals.fixtureSampleLevel || "empty",
  };
}

function historicalValidationEvidence() {
  const counts = dataStore.getCounts();
  return {
    unifiedHistory: Number(counts.unifiedHistory || 0),
    verifiedHistory: Number(counts.verifiedHistory || 0),
    spfHistory: Number(counts.spfHistory || 0),
    hhadHistory: Number(counts.hhadHistory || 0),
    goalHistory: Number(counts.goalHistory || 0),
    sourceUpdatedAt: dataStore.getHistoricalSourceUpdatedAt(),
    generatedAt: reliabilityConfig.generatedAt || null,
    stale: Boolean(reliabilityConfig.stale),
    discipline:
      "按来源文件内行号递增回测；末段已用于历史研究，不能视为新的独立验证",
    markets: Object.fromEntries(
      ["spf", "hhad", "goals"].map((market) => {
        const validation = reliabilityConfig.markets?.[market]?.test;
        return [
          market,
          validation
            ? {
                evaluated: Number(validation.available || 0),
                accuracy:
                  validation.baselineAccuracy === null ||
                  validation.baselineAccuracy === undefined
                    ? null
                    : Number(validation.baselineAccuracy),
                coverage:
                  validation.modelCoverage === null ||
                  validation.modelCoverage === undefined
                    ? null
                    : Number(validation.modelCoverage),
                threshold: Number(productionPolicy.thresholds[market]),
                ordering: "latest-20-percent",
              }
            : null,
        ];
      }),
    ),
  };
}

function ledgerHistoryContext() {
  const history = dataStore.getSettlementHistory();
  const configuredSource =
    challengerConfig.data?.includedSources?.[0] || null;
  const sourceFields = {
    spf: ["spfSourceFile", "spfSourceRow"],
    hhad: ["hhadSourceFile", "hhadSourceRow"],
    goals: ["goalSourceFile", "goalSourceRow"],
  };
  const sources = Object.fromEntries(
    Object.entries(sourceFields).map(([market, [fileField, rowField]]) => {
      const sourceCounts = new Map();
      for (const row of history) {
        const source = row[fileField];
        const sourceRow = Number(row[rowField] || 0);
        if (!source || !sourceRow) continue;
        const current = sourceCounts.get(source) || { count: 0, maxRow: 0 };
        current.count += 1;
        current.maxRow = Math.max(current.maxRow, sourceRow);
        sourceCounts.set(source, current);
      }
      const source =
        configuredSource && sourceCounts.has(configuredSource)
          ? configuredSource
          : [...sourceCounts.entries()].sort(
              (left, right) => right[1].count - left[1].count,
            )[0]?.[0] || "";
      return [
        market,
        {
          source,
          watermark: sourceCounts.get(source)?.maxRow || 0,
          updatedAt: dataStore.getSourceFileUpdatedAt(source),
        },
      ];
    }),
  );
  const primary = sources.spf.source ? sources.spf : sources.hhad;
  return {
    history,
    sources,
    source: primary.source,
    watermark: primary.watermark,
  };
}

function ledgerMarketKey(market) {
  if (market === "had" || market === "spf") return "spf";
  if (market === "hhad") return "hhad";
  return "goals";
}

function ledgerResultReference(row, market) {
  const key = ledgerMarketKey(market);
  if (key === "spf") {
    return { source: row.spfSourceFile, row: Number(row.spfSourceRow || 0) };
  }
  if (key === "hhad") {
    return { source: row.hhadSourceFile, row: Number(row.hhadSourceRow || 0) };
  }
  return { source: row.goalSourceFile, row: Number(row.goalSourceRow || 0) };
}

function ledgerActualResult(row, market) {
  const key = ledgerMarketKey(market);
  if (key === "spf") return row.spf.result;
  if (key === "hhad") return row.hhad.result;
  return row.goals === null || row.goals === undefined
    ? null
    : String(row.goals);
}

function ledgerHistoryOdds(row, market) {
  const key = ledgerMarketKey(market);
  if (key === "spf") return row.spf.odds;
  if (key === "hhad") return row.hhad.odds;
  return row.goalMarket.odds;
}

function parseLedgerOdds(snapshot, selection) {
  if (Array.isArray(selection.odds)) return selection.odds.map(Number);
  try {
    const odds = JSON.parse(snapshot.odds_json || "[]");
    return Array.isArray(odds) ? odds.map(Number) : [];
  } catch {
    return [];
  }
}

function sameOdds(left, right, epsilon = 1e-8) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length > 0 &&
    left.length === right.length &&
    left.every(
      (value, index) =>
        Number.isFinite(Number(value)) &&
        Number.isFinite(Number(right[index])) &&
        Math.abs(Number(value) - Number(right[index])) <= epsilon,
    )
  );
}

// 结算的时序锚点：历史行的入库时间（imported_at）必须晚于投注捕获时间。
// 锚定行级时间戳而非来源文件名，文件名只是溯源信息，换名不影响结算。
function ledgerImportedAt(row, market) {
  const key = ledgerMarketKey(market);
  if (key === "spf") return row.spfImportedAt || null;
  if (key === "hhad") return row.hhadImportedAt || null;
  return row.goalImportedAt || null;
}

function findLedgerResult(history, snapshot, selection) {
  const market = selection.market;
  const capturedAtMs = Date.parse(snapshot.captured_at || "");
  const capturedAfter = (importedAt) => {
    const importedMs = Date.parse(importedAt || "");
    return (
      Number.isFinite(capturedAtMs) &&
      Number.isFinite(importedMs) &&
      importedMs > capturedAtMs
    );
  };
  const matching = history
    .filter((row) => {
      return (
        ledgerActualResult(row, market) !== null &&
        normalizeFixtureText(row.league) ===
          normalizeFixtureText(selection.league) &&
        normalizeTeamName(row.home) === normalizeTeamName(selection.home) &&
        normalizeTeamName(row.away) === normalizeTeamName(selection.away) &&
        (ledgerMarketKey(market) !== "hhad" ||
          Number(row.hhad.handicap) === Number(selection.handicap))
      );
    });
  const afterCapture = matching
    .filter((row) => capturedAfter(ledgerImportedAt(row, market)))
    .sort(
      (left, right) =>
        ledgerResultReference(left, market).row -
        ledgerResultReference(right, market).row,
    )[0];
  if (afterCapture) return afterCapture;

  // 待结算记录会随最新赔率更新，但历史行水位不应随数据库导入前进。
  // 兼容已经受旧逻辑影响的记录：只有队名、联赛、盘口和整组终赔都完全
  // 一致时，才允许在水位之前认领赛果，避免跨赛季同名对阵误结算。
  const snapshotOdds = parseLedgerOdds(snapshot, selection);
  if (!snapshotOdds.length) return undefined;
  return matching
    .filter((row) =>
      sameOdds(ledgerHistoryOdds(row, market), snapshotOdds),
    )
    .sort(
      (left, right) =>
        ledgerResultReference(right, market).row -
        ledgerResultReference(left, market).row,
    )[0];
}

function ledgerMarketOdds(match, market) {
  if (market === "spf") {
    return [match.had.h, match.had.d, match.had.a].map(Number);
  }
  if (market === "hhad") {
    return [match.hhad.h, match.hhad.d, match.hhad.a].map(Number);
  }
  return [
    match.goals.g0,
    match.goals.g1,
    match.goals.g2,
    match.goals.g3,
    match.goals.g4,
    match.goals.g5,
    match.goals.g6,
    match.goals.g7plus,
  ].map(Number);
}

function ledgerInitialMarketOdds(match, market) {
  const initial =
    market === "spf"
      ? match.had?.history?.initial
      : market === "hhad"
        ? match.hhad?.history?.initial
        : match.goals?.history?.initial;
  if (!initial) return null;
  const odds =
    market === "goals"
      ? goalOdds(initial, initial)
      : threeWayOdds(initial, initial);
  return odds.every((value) => Number.isFinite(Number(value)) && Number(value) > 0)
    ? odds.map(Number)
    : null;
}

function recordPredictionPayload(payload) {
  if (
    Math.abs(payload.settings.spfTolerance - productionPolicy.thresholds.spf) >
      1e-9 ||
    Math.abs(
      payload.settings.hhadTolerance - productionPolicy.thresholds.hhad,
    ) > 1e-9 ||
    Math.abs(
      payload.settings.goalTolerance - productionPolicy.thresholds.goals,
    ) > 1e-9
  ) {
    return 0;
  }
  const context = ledgerHistoryContext();
  if (!context.source || !context.watermark) return 0;
  const capturedAt = new Date().toISOString();
  let inserted = 0;
  for (const [market, prediction] of [
    ["spf", payload.spf],
    ["hhad", payload.hhad],
    ["goals", payload.goals],
  ]) {
    if (!prediction?.available || !prediction.reliability) continue;
    const marketContext = context.sources[market];
    if (!marketContext?.source || !marketContext.watermark) continue;
    const odds = ledgerMarketOdds(payload.match, market);
    const labels = prediction.labels || [];
    const topLabels = prediction.topLabels?.length
      ? prediction.topLabels
      : [prediction.predicted].filter(Boolean);
    if (labels.length > 0 && topLabels.length >= labels.length) continue;
    const selectedIndex = labels.indexOf(topLabels[0]);
    if (
      selectedIndex < 0 ||
      !Number.isFinite(odds[selectedIndex]) ||
      !Number.isFinite(prediction.final?.[selectedIndex])
    ) {
      continue;
    }
    inserted += predictionLedger.record({
      matchId: payload.match.id,
      policyVersion: ledgerPolicyVersion({
        sameLeague: Boolean(payload.settings.sameLeague),
      }),
      algorithmVersion: ledgerAlgorithmVersion(market, {
        sameLeague: Boolean(payload.settings.sameLeague),
      }),
      dataVersion: marketContext.updatedAt,
      validationStatus: challengerConfig.selectionStale
        ? "pending_revalidation"
        : "validated",
      market,
      handicap: market === "hhad" ? prediction.handicap : null,
      capturedAt,
      sourceUpdatedAt: marketContext.updatedAt,
      historySourceFile: marketContext.source,
      historyRowWatermark: marketContext.watermark,
      league: payload.match.league,
      home: payload.match.home,
      away: payload.match.away,
      displayName: payload.match.displayName,
      predicted: topLabels.join(" / "),
      topLabels,
      selectedProbability: prediction.final[selectedIndex],
      selectedOdds: odds[selectedIndex],
      probabilities: prediction.final,
      odds,
      reliabilityLevel: challengerConfig.selectionStale
        ? "cautious"
        : prediction.reliability.level,
      reliabilityLabel: challengerConfig.selectionStale
        ? "规则待验证"
        : prediction.reliability.label,
      reliabilityReason: challengerConfig.selectionStale
        ? `历史数据更新后尚未重新验证；${prediction.reliability.reason}`
        : prediction.reliability.reason,
      threshold:
        payload.settings.effectiveThresholds?.[market] ??
        payload.settings[
          market === "spf"
            ? "spfTolerance"
            : market === "hhad"
              ? "hhadTolerance"
              : "goalTolerance"
        ],
      samples: prediction.stats.total,
      settings: {
        ...payload.settings,
        recentForm: payload.recentForm?.available ? payload.recentForm : null,
        diagnostics: {
          smoothing: {
            applied: Boolean(prediction.smoothing?.applied),
            policyToken: prediction.smoothing?.applied
              ? smoothingPolicyToken(productionPolicy.smoothing[market], { sameLeague: Boolean(payload.settings.sameLeague) }) : "",
            strength: prediction.smoothing?.applied ? prediction.smoothing.strength : 0,
            prior: prediction.smoothing?.applied ? prediction.smoothing.prior : null,
          },
          initialOdds: ledgerInitialMarketOdds(payload.match, market),
          movementApplied: Boolean(prediction.movement?.applied),
          movementReferenceOnly: Boolean(prediction.movement?.referenceOnly),
          movementReason: prediction.movement?.reason || null,
        },
        ledgerValidationPending: Boolean(challengerConfig.selectionStale),
      },
    })
      ? 1
      : 0;
  }
  const goalMultiple = payload.goalMultiple;
  if (
    !payload.settings.sameLeague &&
    goalMultiple?.available &&
    payload.match.goals
  ) {
    const marketContext = context.sources.goals;
    const odds = ledgerMarketOdds(payload.match, "goals");
    if (marketContext?.source && marketContext.watermark) {
      inserted += predictionLedger.record({
        matchId: payload.match.id,
        policyVersion: `${productionPolicy.probabilityPolicy}:${GOAL_MULTIPLE_VERSION}:all-leagues`,
        algorithmVersion: ledgerAlgorithmVersion("goalMultiple", {
          sameLeague: false,
        }),
        dataVersion: marketContext.updatedAt,
        validationStatus: "reference_only",
        market: "goalMultiple",
        handicap: null,
        capturedAt,
        sourceUpdatedAt: marketContext.updatedAt,
        historySourceFile: marketContext.source,
        historyRowWatermark: marketContext.watermark,
        league: payload.match.league,
        home: payload.match.home,
        away: payload.match.away,
        displayName: payload.match.displayName,
        predicted: goalMultiple.labels.join(" / "),
        topLabels: goalMultiple.labels,
        selectedProbability: goalMultiple.coverageProbability,
        selectedOdds: goalMultiple.zeroOdds,
        probabilities: goalMultiple.probabilities,
        odds,
        reliabilityLevel: "cautious",
        reliabilityLabel: "倍数历史观察",
        reliabilityReason:
          "按相同0球终赔的整数倍历史档位统计前两名；独立记录命中率，不计模拟盈亏",
        threshold: 0,
        samples: goalMultiple.samples,
        settings: {
          sameLeague: false,
          goalMultipleCounts: goalMultiple.counts,
          goalMultipleProbabilities: goalMultiple.probabilities,
          goalMultipleCoverage: goalMultiple.coverageProbability,
          goalMultipleZeroOdds: goalMultiple.zeroOdds,
          goalMultipleRelations: goalMultiple.relations,
          goalMultipleSource: goalMultiple.source,
          goalMultipleTieBreak: goalMultiple.tieBreak,
        },
      })
        ? 1
        : 0;
    }
  }
  return inserted;
}

function recordSpfShadowPrediction(match) {
  if (!match?.had) return 0;
  const marketContext = ledgerHistoryContext().sources.spf;
  if (!marketContext?.source || !marketContext.watermark) return 0;
  const comparison = buildSpfShadowComparison(match, {
    spfHistory: dataStore.getSpfHistory(),
    hhadHistory: dataStore.getHhadHistory(),
    pairedHistory: dataStore.getPairedSpfHhadHistory(),
  });
  if (!comparison) return 0;
  return shadowPredictionLedger.record({
    ...comparison,
    matchId: match.id,
    capturedAt: new Date().toISOString(),
    sourceUpdatedAt: marketContext.updatedAt,
    historySourceFile: marketContext.source,
    historyRowWatermark: marketContext.watermark,
    league: match.league,
    home: match.home,
    away: match.away,
    displayName: match.displayName,
  })
    ? 1
    : 0;
}

function settlePredictionLedger() {
  const context = ledgerHistoryContext();
  const pending = predictionLedger.pending();
  const settledAt = new Date().toISOString();
  const settlements = [];
  for (const snapshot of pending) {
    const result = findLedgerResult(context.history, snapshot, {
      market: snapshot.market,
      league: snapshot.league,
      home: snapshot.home_team,
      away: snapshot.away_team,
      handicap: snapshot.handicap,
    });
    if (!result) continue;
    const actualResult = ledgerActualResult(result, snapshot.market);
    const resultReference = ledgerResultReference(result, snapshot.market);
    settlements.push({ id: snapshot.id, result: {
      actualResult,
      score: result.score,
      sourceFile: resultReference.source,
      sourceRow: resultReference.row,
      settledAt,
    } });
  }
  return predictionLedger.transaction(() =>
    settlements.reduce(
      (count, settlement) =>
        count +
        Number(
          predictionLedger.settle(settlement.id, settlement.result).changes || 0,
        ),
      0,
    ),
  );
}

function settleSpfShadowLedger() {
  const context = ledgerHistoryContext();
  const settledAt = new Date().toISOString();
  const settlements = [];
  for (const snapshot of shadowPredictionLedger.pending()) {
    const result = findLedgerResult(context.history, snapshot, {
      market: "spf",
      league: snapshot.league,
      home: snapshot.home_team,
      away: snapshot.away_team,
      handicap: null,
    });
    if (!result) continue;
    const reference = ledgerResultReference(result, "spf");
    settlements.push({
      id: snapshot.id,
      result: {
        actualResult: ledgerActualResult(result, "spf"),
        score: result.score,
        sourceFile: reference.source,
        sourceRow: reference.row,
        settledAt,
      },
    });
  }
  return shadowPredictionLedger.transaction(() =>
    settlements.reduce(
      (count, item) =>
        count +
        Number(
          shadowPredictionLedger.settle(item.id, item.result).changes || 0,
        ),
      0,
    ),
  );
}

function applyThreeWayProbabilityPolicy(
  prediction,
  market,
  samples,
  target,
  { sameLeague = false, tolerance = 0.1 } = {},
) {
  const scope = sameLeague ? "sameLeague" : "all";
  if (
    productionPolicy.probabilityPolicy !== "historical-similarity-v4"
  ) {
    return {
      ...prediction,
      probabilityModel: {
        enabled: false,
        scope,
        reason: `正式模型已锁定 ${LOCKED_PRODUCTION_PROBABILITY_POLICY}；v4仅保留为候选验证`,
      },
    };
  }
  const policy = productionPolicy.threeWayProbability?.scopes?.[scope]?.[market];
  const selected = policy?.selected;
  if (!policy?.enabled || !selected || !prediction?.available) {
    return {
      ...prediction,
      probabilityModel: {
        enabled: false,
        scope,
        reason: policy?.gate?.reason || "组合概率模型未通过当前范围验证",
      },
    };
  }
  const profile = selected.profile || {};
  const weighted = weightedThreeWayProbabilities(samples, target, {
    ...profile,
    decay: selected.decay,
    finalScale: tolerance,
    initialScale: tolerance * 1.5,
    movementScale: Math.max(0.006, tolerance * 0.15),
  });
  const marketProbabilities = impliedThreeWayProbabilities(target.odds);
  if (!weighted || !marketProbabilities) {
    return {
      ...prediction,
      probabilityModel: {
        enabled: false,
        scope,
        reason: "当前比赛缺少组合概率模型所需的完整赔率",
      },
    };
  }
  const final = blendThreeWayProbabilities(
    weighted.probabilities,
    marketProbabilities,
    selected.marketWeight,
  );
  const highest = Math.max(...final);
  const topLabels = prediction.labels.filter(
    (_, index) => Math.abs(final[index] - highest) < 1e-12,
  );
  const usesInitial = Number(profile.initialWeight || 0) > 0;
  const usesMovement = Number(profile.movementWeight || 0) > 0;
  const hasInitial = Array.isArray(target.initialOdds);
  return {
    ...prediction,
    market: marketProbabilities,
    weightedEmpirical: weighted.probabilities,
    stableEmpirical: weighted.probabilities,
    baseline: weighted.probabilities,
    final,
    empiricalWeight: 1 - Number(selected.marketWeight || 0),
    predicted: topLabels[0] || null,
    topLabels,
    isTie: topLabels.length > 1,
    confidence: confidenceLabel(final, weighted.effectiveSamples),
    productionModel: "validated-three-way-composite",
    weighting: {
      ...prediction.weighting,
      enabled: true,
      validated: true,
      method: "validated-composite-exponential-decay",
      tolerance,
      effectiveSamples: weighted.effectiveSamples,
      totalWeight: weighted.totalWeight,
      coreSamples: weighted.coreSamples,
      minimumWeight: weighted.minimumWeight,
      maximumWeight: weighted.maximumWeight,
    },
    movement: usesMovement && hasInitial
      ? {
          ...prediction.movement,
          applied: false,
          referenceOnly: false,
          reason: "included-in-composite-distance",
          sampleSize: weighted.usableSamples,
          weight: Number(profile.movementWeight || 0),
        }
      : prediction.movement,
    probabilityModel: {
      enabled: true,
      validated: true,
      scope,
      id: selected.id,
      marketWeight: Number(selected.marketWeight || 0),
      historyWeight: 1 - Number(selected.marketWeight || 0),
      decay: Number(selected.decay || 0),
      features: {
        final: Number(profile.finalWeight || 0),
        initial: usesInitial && hasInitial
          ? Number(profile.initialWeight || 0)
          : 0,
        movement: usesMovement && hasInitial
          ? Number(profile.movementWeight || 0)
          : 0,
      },
      initialAvailable: hasInitial,
      validation: policy.validation,
      gate: policy.gate,
    },
  };
}

function buildSpfPrediction(
  match,
  history,
  {
    tolerance = 0.05,
    model = null,
    challenger = null,
    sameLeague = false,
    similarOverride = null,
  } = {},
) {
  if (!match.had) return null;
  const hadOdds = [match.had.h, match.had.d, match.had.a];
  const initialOdds = threeWayOdds(match.had.history?.initial, match.had);
  const scope = resolveSimilarity(
    "spf",
    history,
    hadOdds,
    tolerance,
    findSimilarSpf,
    { sameLeague },
  );
  const similar = Array.isArray(similarOverride)
    ? similarOverride
    : scope.similar;
  const effectiveTolerance = scope.threshold;
  const effectiveModel =
    model ||
    modelDecision("spf", effectiveTolerance, {
      sameLeague,
      adaptive: scope.adaptive,
      segmented: scope.segmented,
    });
  const prior = historicalPriorFor(
    history,
    { odds: hadOdds, league: match.league },
    "spf",
    {
      labels: ["胜", "平", "负"],
      outcomeField: "result",
      distance: (left, right) => spfDistance(left.odds, right.odds),
      threshold: effectiveTolerance,
    },
  );
  const movementSimilar = findSimilarSpfMovements(
    similar,
    initialOdds,
    hadOdds,
    { finalTolerance: effectiveTolerance },
  );
  const prediction = predictSpfWithMovement(
      hadOdds,
      similar,
      movementSimilar,
      initialOdds,
      {
        ...movementOptions("spf", effectiveModel.usesRecommendedThreshold),
        blendOptions: blendOptions(
          effectiveModel,
          smoothingOptions(
            "spf",
            prior,
            effectiveModel.usesRecommendedThreshold,
          ),
        ),
      },
    );
  const productionPrediction = applyThreeWayProbabilityPolicy(
    prediction,
    "spf",
    similar,
    {
      odds: hadOdds,
      initialOdds: match.had.history?.initial
        ? threeWayOdds(match.had.history.initial, match.had)
        : null,
    },
    { sameLeague, tolerance: effectiveTolerance },
  );
  return {
    prediction: attachMarketComparison(
      attachChallenger(productionPrediction, "spf", challenger),
      hadOdds,
    ),
    similar,
    movementSimilar,
    tolerance: effectiveTolerance,
    adaptive: Array.isArray(similarOverride)
      ? { ...scope, similar, samples: similar.length }
      : scope,
    model: effectiveModel,
  };
}

function buildHhadPrediction(
  match,
  history,
  {
    tolerance = 0.05,
    model = null,
    challenger = null,
    sameLeague = false,
    similarOverride = null,
  } = {},
) {
  const handicap = handicapNumber(match.hhad);
  if (!match.hhad || handicap === null) return null;
  const odds = [match.hhad.h, match.hhad.d, match.hhad.a];
  const initialOdds = threeWayOdds(match.hhad.history?.initial, match.hhad);
  const handicapHistory = history.filter((row) => row.handicap === handicap);
  const scope = resolveSimilarity(
    "hhad",
    handicapHistory,
    odds,
    tolerance,
    findSimilarSpf,
    { sameLeague },
  );
  const similar = Array.isArray(similarOverride)
    ? similarOverride
    : scope.similar;
  const effectiveTolerance = scope.threshold;
  const effectiveModel =
    model ||
    modelDecision("hhad", effectiveTolerance, {
      sameLeague,
      adaptive: scope.adaptive,
      segmented: scope.segmented,
    });
  const prior = historicalPriorFor(
    handicapHistory,
    { odds, league: match.league, handicap },
    "hhad",
    {
      labels: ["胜", "平", "负"],
      outcomeField: "result",
      distance: (left, right) => spfDistance(left.odds, right.odds),
      threshold: effectiveTolerance,
    },
  );
  const movementSimilar = findSimilarSpfMovements(
    similar,
    initialOdds,
    odds,
    { finalTolerance: effectiveTolerance },
  );
  const prediction = predictSpfWithMovement(
      odds,
      similar,
      movementSimilar,
      initialOdds,
      {
        ...movementOptions("hhad", effectiveModel.usesRecommendedThreshold),
        blendOptions: blendOptions(
          effectiveModel,
          smoothingOptions(
            "hhad",
            prior,
            effectiveModel.usesRecommendedThreshold,
          ),
        ),
      },
    );
  const productionPrediction = applyThreeWayProbabilityPolicy(
    prediction,
    "hhad",
    similar,
    {
      odds,
      initialOdds: match.hhad.history?.initial
        ? threeWayOdds(match.hhad.history.initial, match.hhad)
        : null,
    },
    { sameLeague, tolerance: effectiveTolerance },
  );
  return {
    handicap,
    prediction: attachMarketComparison(
      attachChallenger(
        productionPrediction,
        "hhad",
        challenger,
      ),
      odds,
    ),
    similar,
    movementSimilar,
    tolerance: effectiveTolerance,
    adaptive: Array.isArray(similarOverride)
      ? { ...scope, similar, samples: similar.length }
      : scope,
    model: effectiveModel,
  };
}

function matchingLabel(mode, market) {
  if (mode === "joint") return "双盘口联合样本·独立赛果统计";
  if (mode === "joint-unavailable") {
    return "双盘口联合样本不足";
  }
  return `${market === "spf" ? "胜平负" : "让球"}单盘口匹配`;
}

function attachMatchingMode(result, mode, market, jointSamples = 0) {
  if (!result) return result;
  const label = matchingLabel(mode, market);
  return {
    ...result,
    matchingMode: mode,
    matchingLabel: label,
    jointSamples,
    prediction: {
      ...result.prediction,
      matchingMode: mode,
      matchingLabel: label,
      jointSamples,
    },
  };
}

function conditionalHhadBySpf(jointRows) {
  const labels = ["胜", "平", "负"];
  const groups = Object.fromEntries(
    labels.map((spfLabel) => [
      spfLabel,
      {
        samples: 0,
        counts: Object.fromEntries(labels.map((label) => [label, 0])),
      },
    ]),
  );
  for (const row of jointRows) {
    const spfResult = String(row?.spf?.result || "");
    const hhadResult = String(row?.hhad?.result || "");
    if (!labels.includes(spfResult) || !labels.includes(hhadResult)) continue;
    groups[spfResult].samples += 1;
    groups[spfResult].counts[hhadResult] += 1;
  }
  return Object.fromEntries(
    labels.map((spfLabel) => {
      const group = groups[spfLabel];
      return [
        spfLabel,
        {
          ...group,
          probabilities: Object.fromEntries(
            labels.map((hhadLabel) => [
              hhadLabel,
              group.samples
                ? group.counts[hhadLabel] / group.samples
                : 0,
            ]),
          ),
        },
      ];
    }),
  );
}

function buildThreeWayPredictionResults(
  match,
  {
    spfHistory,
    hhadHistory,
    pairedHistory,
    spfTolerance,
    hhadTolerance,
    challenger = null,
    sameLeague = false,
  },
) {
  let spfResult = buildSpfPrediction(match, spfHistory, {
    tolerance: spfTolerance,
    challenger: challenger?.spf,
    sameLeague,
  });
  let hhadResult = buildHhadPrediction(match, hhadHistory, {
    tolerance: hhadTolerance,
    challenger: challenger?.hhad,
    sameLeague,
  });
  const selection = selectThreeWaySimilarity(
    match,
    { spfHistory, hhadHistory, pairedHistory },
    {
      spfTolerance: spfResult?.tolerance ?? spfTolerance,
      hhadTolerance: hhadResult?.tolerance ?? hhadTolerance,
      sameLeague,
    },
  );
  if (selection.spf && spfResult) {
    spfResult = buildSpfPrediction(match, spfHistory, {
      tolerance: spfTolerance,
      challenger: challenger?.spf,
      sameLeague,
      similarOverride: selection.spf.similar,
    });
    spfResult = attachMatchingMode(
      spfResult,
      selection.spf.mode,
      "spf",
      selection.spf.jointSamples,
    );
  }
  if (selection.hhad && hhadResult) {
    hhadResult = buildHhadPrediction(match, hhadHistory, {
      tolerance: hhadTolerance,
      challenger: challenger?.hhad,
      sameLeague,
      similarOverride: selection.hhad.similar,
    });
    hhadResult = attachMatchingMode(
      hhadResult,
      selection.hhad.mode,
      "hhad",
      selection.hhad.jointSamples,
    );
  }
  if (
    selection.spf?.mode === "joint" &&
    selection.hhad?.mode === "joint" &&
    spfResult &&
    hhadResult
  ) {
    const conditionalDistribution = conditionalHhadBySpf(
      selection.jointRows,
    );
    const directCounting = {
      available: true,
      version: THREE_WAY_MATCHING_VERSION,
      method: "paired-market-direct-results",
      reason:
        "两种玩法使用同一批双盘口历史比赛，并分别直接统计各自保存的赛果",
      jointSamples: selection.jointRows.length,
      outcomeBasis: "stored-market-result",
      conditionalHhadBySpf: conditionalDistribution,
    };
    spfResult = {
      ...spfResult,
      jointRows: selection.jointRows,
      prediction: {
        ...spfResult.prediction,
        jointCounting: { ...directCounting, market: "spf" },
      },
    };
    hhadResult = {
      ...hhadResult,
      jointRows: selection.jointRows,
      prediction: {
        ...hhadResult.prediction,
        jointCounting: { ...directCounting, market: "hhad" },
      },
    };
  } else if (
    selection.spf?.mode === "joint-unavailable" &&
    selection.hhad?.mode === "joint-unavailable"
  ) {
    const jointCounting = {
      available: false,
      version: THREE_WAY_MATCHING_VERSION,
      method: "paired-market-direct-results",
      reason: "没有同时满足两个盘口相似范围的配对历史比赛",
      jointSamples: 0,
      outcomeBasis: "stored-market-result",
    };
    if (spfResult) {
      spfResult = {
        ...spfResult,
        prediction: { ...spfResult.prediction, jointCounting },
      };
    }
    if (hhadResult) {
      hhadResult = {
        ...hhadResult,
        prediction: { ...hhadResult.prediction, jointCounting },
      };
    }
  }
  return { spfResult, hhadResult };
}

function marketCandidate(match, market, prediction, handicap = null) {
  if (!prediction.available || !prediction.predicted || prediction.isTie) return null;
  const index = prediction.labels.indexOf(prediction.predicted);
  const source = market === "hhad" ? match.hhad : match.had;
  const odds = [source.h, source.d, source.a][index];
  const probability = prediction.final[index];
  const marketComparison = prediction.marketComparison || null;
  return {
    id: match.id,
    displayName: match.displayName,
    league: match.league,
    home: match.home,
    away: match.away,
    market,
    marketLabel:
      market === "hhad"
        ? `让球胜平负 (${handicap > 0 ? "+" : ""}${handicap})`
        : "胜平负",
    handicap,
    predicted: prediction.predicted,
    confidence: prediction.confidence,
    probability,
    marketProbability: prediction.market[index],
    probabilityDelta:
      marketComparison?.selected?.probabilityDelta ??
      probability - prediction.market[index],
    breakEvenProbability:
      marketComparison?.selected?.breakEvenProbability ?? 1 / odds,
    breakEvenDelta:
      marketComparison?.selected?.breakEvenDelta ?? probability - 1 / odds,
    marketComparison,
    odds,
    valueIndex: probability * odds,
    samples: prediction.stats.total,
    matchingMode: prediction.matchingMode || "standalone",
    matchingLabel:
      prediction.matchingLabel ||
      (market === "hhad" ? "让球单盘口匹配" : "胜平负单盘口匹配"),
    movement: prediction.movement,
    reliability: prediction.reliability || null,
    // 稳定性字段提到顶层，供串关「稳定优先」排序取用。
    // 这三项是本项目唯一通过门禁验证的筛选维度（见 data/reliability-config.json）。
    stabilityTopProbability: prediction.reliability?.observed?.topProbability ?? 0,
    stabilityMargin: prediction.reliability?.observed?.margin ?? 0,
    stabilityConsensus: prediction.reliability?.observed?.consensus ?? 0,
    reliabilityLevel: prediction.reliability?.level || null,
  };
}

function buildGoalPredictionResult(
  match,
  history,
  goalTolerance,
  challenger = null,
  { sameLeague = false } = {},
) {
  if (!match.goals) return null;
  const odds = goalOdds(match.goals, match.goals).map(Number);
  const initialOdds = goalOdds(
    match.goals.history?.initial,
    match.goals,
  ).map(Number);
  const scope = resolveSimilarity(
    "goals",
    history,
    odds,
    goalTolerance,
    findSimilarGoals,
    {
      sameLeague,
      finderOptions: {
        league: match.league,
        targetInitialOdds: initialOdds,
      },
    },
  );
  const similar = scope.similar;
  const effectiveTolerance = scope.threshold;
  const model = modelDecision("goals", effectiveTolerance, {
    sameLeague,
    adaptive: scope.adaptive,
    segmented: scope.segmented,
    zeroOdds: scope.zeroOdds,
  });
  const prior = historicalPriorFor(
    history,
    { odds, league: match.league },
    "goals",
    {
      labels: GOAL_LABELS,
      outcomeField: "goals",
      distance: (left, right) =>
        Math.abs(Number(left.odds?.[0]) - Number(right.odds?.[0])),
      threshold: sameLeague
        ? SAME_LEAGUE_GOAL_ZERO_ODDS_TOLERANCE
        : GOAL_ZERO_ODDS_TOLERANCE,
    },
  );
  const goalBlendOptions = blendOptions(
    model,
    smoothingOptions("goals", prior, model.usesRecommendedThreshold),
  );
  const base = {
    ...predictProductionGoals(odds, {
      similar,
      weighting: scope.goalWeighting,
    }, { blendOptions: goalBlendOptions }),
    movement: {
      applied: false,
      referenceOnly: false,
      reason: "included-in-composite-distance",
      sampleSize: similar.length,
      weight: 0,
    },
  };
  const predictionWithChallenger = attachMarketComparison(
    attachChallenger(
      base,
      "goals",
      challenger,
    ),
    odds,
  );
  const prediction = {
    ...predictionWithChallenger,
    goalPair: selectTopGoalPair(predictionWithChallenger.final, odds),
  };
  prediction.goalPair.validation = goalPairValidation(prediction, {
    policy: goalPairSelectionConfig, sameLeague, usesRecommendedThreshold: model.usesRecommendedThreshold,
    smoothingEnabled: productionPolicy.smoothing.goals.enabled,
  });
  prediction.goalPair.marketComparison = compareHistoricalToMarket(prediction.labels, odds, prediction.final, { available: prediction.available, selectionSize: 2 });
  const stability = buildGoalStability(
    history,
    odds,
    initialOdds,
    match.league,
    sameLeague,
  );
  const reliability = reliabilityView("goals", prediction, stability, {
    threshold: effectiveTolerance,
    sameLeague,
  });
  return {
    odds,
    initialOdds,
    scope,
    similar,
    tolerance: effectiveTolerance,
    model,
    prediction,
    stability,
    reliability,
  };
}

function buildGoalPairCandidate(
  match,
  history,
  goalTolerance,
  challenger,
  { sameLeague = false } = {},
) {
  const result = buildGoalPredictionResult(
    match,
    history,
    goalTolerance,
    challenger,
    { sameLeague },
  );
  if (!result) return null;
  const {
    odds,
    initialOdds,
    scope,
    tolerance: effectiveTolerance,
    prediction,
  } = result;
  const pair = prediction.goalPair;
  if (!prediction.available || !pair.available) return null;
  const stability = buildGoalPairStability(
    history,
    odds,
    initialOdds,
    match.league,
    sameLeague,
  );
  const notices = [];
  if (!stability.stable) {
    notices.push("不同相似阈值下的前两名会变化");
  }
  if (!goalPairSelectionConfig.validated) {
    notices.push("新规则的滚动验证仅作风险提示");
  }
  const selections = pair.indices.map((index) => ({
    label: GOAL_LABELS[index],
    probability: prediction.final[index],
    odds: odds[index],
  }));
  const expectedReturn = selections.reduce(
    (total, selection) =>
      total + selection.probability * selection.odds,
    0,
  );
  const marketComparison = compareHistoricalToMarket(
    prediction.labels,
    odds,
    prediction.final,
    { available: prediction.available, selectionSize: 2 },
  );
  return {
    id: match.id,
    displayName: match.displayName,
    league: match.league,
    home: match.home,
    away: match.away,
    market: "goalsPair",
    tolerance: effectiveTolerance,
    adaptive: adaptiveScopeView(scope),
    zeroOdds: zeroOddsScopeView(scope),
    marketLabel: "总进球双选",
    handicap: null,
    predicted: pair.labels.join(" / "),
    labels: pair.labels,
    selections,
    confidence: confidenceLabel(
      [pair.probability, 1 - pair.probability],
      prediction.stats.total,
    ),
    probability: pair.probability,
    marketProbability: marketComparison.selected.marketProbability,
    probabilityDelta: marketComparison.selected.probabilityDelta,
    breakEvenProbability: null,
    breakEvenDelta: null,
    marketComparison,
    odds: pair.odds,
    valueIndex: expectedReturn / pair.stakeUnits,
    samples: prediction.stats.total,
    sampleScope: sameLeague ? "同联赛" : "全部联赛",
    movement: prediction.movement,
    stability,
    eligible: true,
    eligibilityReason: notices.length
      ? `按当前范围的相似历史概率选择前两名；${notices.join("；")}`
      : "按当前范围的相似历史概率选择前两名；四档阈值结果稳定",
    reliability: {
      level: stability.stable ? "recommended" : "cautious",
      label: stability.stable ? "前两名稳定" : "前两名有波动",
      reason: notices.length
        ? notices.join("；")
        : "四档相似阈值均指向同一组前两名",
    },
    validation: {
      enabled: goalPairSelectionConfig.enabled,
      validated: goalPairSelectionConfig.validated,
      stale: goalPairSelectionConfig.stale,
      gate: goalPairSelectionConfig.gate,
      baseline: goalPairSelectionConfig.baseline,
      selected: goalPairSelectionConfig.selected,
    },
  };
}

function buildParlayCandidate(
  match,
  histories,
  spfTolerance,
  hhadTolerance,
  goalTolerance,
  { sameLeague = false } = {},
) {
  const {
    verifiedHistory,
    spfHistory,
    hhadHistory,
    pairedHistory,
    goalHistory,
  } = histories;
  const challenger =
    match.had && match.hhad && match.goals
      ? challengerEngine?.predict(match, verifiedHistory) || null
      : null;
  const { spfResult: hadResult, hhadResult: hhad } =
    buildThreeWayPredictionResults(match, {
      spfHistory,
      hhadHistory,
      pairedHistory,
      spfTolerance,
      hhadTolerance,
      challenger,
      sameLeague,
    });
  const threeWayStability = buildThreeWayStability(match, {
    spfHistory,
    hhadHistory,
    pairedHistory,
    spfResult: hadResult,
    hhadResult: hhad,
    sameLeague,
  });
  const had = hadResult
    ? (() => {
        const stability = threeWayStability.spf;
        return {
          ...hadResult.prediction,
          reliability: reliabilityView(
            "spf",
            hadResult.prediction,
            stability,
            { threshold: hadResult.tolerance, sameLeague },
          ),
        };
      })()
    : null;
  const hhadPrediction = hhad
    ? (() => {
        const stability = threeWayStability.hhad;
        return {
          ...hhad.prediction,
          reliability: reliabilityView(
            "hhad",
            hhad.prediction,
            stability,
            { threshold: hhad.tolerance, sameLeague },
          ),
        };
      })()
    : null;
  const hadBaseCandidate = had
    ? marketCandidate(match, "had", had)
    : null;
  const hhadBaseCandidate = hhadPrediction
    ? marketCandidate(
        match,
        "hhad",
        hhadPrediction,
        hhad.handicap,
      )
    : null;
  const hadCandidate = hadBaseCandidate
    ? {
        ...hadBaseCandidate,
        sampleScope: sameLeague ? "同联赛" : "全部联赛",
        tolerance: hadResult.tolerance,
        adaptive: adaptiveScopeView(hadResult.adaptive),
      }
    : null;
  const hhadCandidate = hhadBaseCandidate
    ? {
        ...hhadBaseCandidate,
        sampleScope: sameLeague ? "同联赛" : "全部联赛",
        tolerance: hhad.tolerance,
        adaptive: adaptiveScopeView(hhad.adaptive),
      }
    : null;
  const goalPairCandidate = buildGoalPairCandidate(
    match,
    goalHistory,
    goalTolerance,
    challenger?.goals,
    { sameLeague },
  );
  const markets = {
    ...(hadCandidate ? { had: hadCandidate } : {}),
    ...(hhadCandidate ? { hhad: hhadCandidate } : {}),
    ...(goalPairCandidate ? { goalsPair: goalPairCandidate } : {}),
  };
  const primary = hadCandidate || hhadCandidate || goalPairCandidate;
  return primary ? { ...primary, markets } : null;
}

function buildParlayPayload(url) {
  const mode =
    url.searchParams.get("mode") === "goalsPair"
      ? "goalsPair"
      : "standard";
  const legs = numberParam(url.searchParams, "legs", 2, 2, 5);
  const goalPairStake = 2 ** legs;
  const targetOdds = numberParam(url.searchParams, "targetOdds", 1.8, 1, 100);
  const minLegOdds = numberParam(
    url.searchParams,
    "minLegOdds",
    1.7,
    1.7,
    20,
  );
  const limit = numberParam(url.searchParams, "limit", 20, 1, 50);
  const maxMatchUses = Number(url.searchParams.get("maxMatchUses") || 0);
  if (![0, 1, 2].includes(maxMatchUses)) {
    throw new Error("每场使用次数仅支持不限制、1次或2次");
  }
  const spfTolerance = numberParam(
    url.searchParams,
    "spfTolerance",
    productionPolicy.thresholds.spf,
    0.02,
    0.3,
  );
  const hhadTolerance = numberParam(
    url.searchParams,
    "hhadTolerance",
    productionPolicy.thresholds.hhad,
    0.02,
    0.3,
  );
  const goalTolerance = numberParam(
    url.searchParams,
    "goalTolerance",
    productionPolicy.thresholds.goals,
    0.005,
    0.1,
  );
  const sameLeague = url.searchParams.get("sameLeague") === "true";
  const requestedSort = url.searchParams.get("sort") || "probability";
  const sort = [
    "stability",
    "value",
    "probability",
    "target",
  ].includes(requestedSort)
    ? requestedSort
    : "probability";
  const selectedIds = new Set(
    (url.searchParams.get("selected") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const marketSelections = new Map(
    (url.searchParams.get("markets") || "")
      .split(",")
      .map((item) => item.split(":"))
      .filter(
        ([id, market]) =>
          id && ["had", "hhad", "goalsPair"].includes(market),
      ),
  );

  const allLeagueHistory = sameLeague
    ? null
    : dataStore.getVerifiedHistory();
  const candidates = dataStore
    .getMatches()
    .filter((match) => match.had || match.hhad || match.goals)
    .map((match) => {
      const verifiedHistory = sameLeague
        ? dataStore.getVerifiedHistory({
            league: match.league,
            sameLeague: true,
          })
        : allLeagueHistory;
      const marketHistory = predictionMarketHistories(match, {
        spfTolerance,
        hhadTolerance,
        sameLeague,
      });
      return buildParlayCandidate(
        match,
        { verifiedHistory, ...marketHistory },
        spfTolerance,
        hhadTolerance,
        goalTolerance,
        { sameLeague },
      );
    })
    .filter(Boolean)
    .filter((candidate) =>
      mode === "goalsPair"
        ? Boolean(candidate.markets.goalsPair)
        : Boolean(candidate.markets.had || candidate.markets.hhad),
    );
  const selectedMatches = selectedIds.size
    ? candidates.filter((candidate) => selectedIds.has(candidate.id))
    : mode === "goalsPair"
      ? [...candidates]
          .sort(
            (left, right) =>
              right.markets.goalsPair.probability -
                left.markets.goalsPair.probability ||
              right.markets.goalsPair.samples -
                left.markets.goalsPair.samples,
          )
          .slice(0, legs)
      : candidates;
  const selectedCandidates =
    mode === "goalsPair"
      ? selectedMatches
          .map((candidate) => candidate.markets.goalsPair)
          .filter(Boolean)
      : selectedMatches
          .map((candidate) => {
            const eligibleMarkets = [
              candidate.markets.had,
              candidate.markets.hhad,
            ].filter(
              (market) => market && Number(market.odds) >= minLegOdds,
            );
            const fallback = eligibleMarkets[0];
            const market =
              marketSelections.get(candidate.id) || fallback?.market;
            const selected = candidate.markets[market];
            return selected && Number(selected.odds) >= minLegOdds
              ? selected
              : fallback;
          })
          .filter(Boolean);
  const combinations =
    mode === "goalsPair"
      ? generateGoalPairParlays(selectedCandidates, {
          legs,
          sort,
          limit,
          maxMatchUses,
        })
      : generateParlayCombinations(selectedCandidates, {
          legs,
          targetOdds,
          minLegOdds,
          sort,
          limit,
          maxMatchUses,
        });

  return {
    mode,
    candidates,
    combinations,
    selectedCount: selectedCandidates.length,
    goalPairPolicy: goalPairSelectionConfig,
    requestSettings: {
      mode,
      legs,
      limit,
      maxMatchUses,
      ...(mode === "goalsPair" ? {} : { targetOdds }),
      ...(mode === "goalsPair" ? {} : { minLegOdds }),
      sort,
      spfTolerance,
      hhadTolerance,
      goalTolerance,
      sameLeague,
      selected: [...selectedIds],
      markets: Object.fromEntries(marketSelections),
    },
    method:
      mode === "goalsPair"
        ? {
            scope: sameLeague ? "只看同联赛" : "全部联赛",
            tolerance: `${sameLeague ? "同联赛" : "全部联赛"} · 进球距离 ${(goalTolerance * 100).toFixed(1)}pp / 相似历史概率前两名`,
            probability:
              `默认按单场双选覆盖率选择${legs}场；不设置最低组合赔率；${legs}场均覆盖概率仅展示；后台按${goalPairStake}注核算`,
            value:
              `回报指数 = ${goalPairStake}种结果的概率加权预期返还 ÷ ${goalPairStake}注成本，1.00 为理论盈亏平衡线`,
          }
        : {
            scope: sameLeague ? "只看同联赛" : "全部联赛",
            tolerance: `${sameLeague ? "同联赛" : "全部联赛"} · 胜平负 ±${(spfTolerance * 100).toFixed(0)}% / 让球 ±${(hhadTolerance * 100).toFixed(0)}%`,
            probability:
              `每关赔率不低于 ${minLegOdds.toFixed(2)}；${
                sort === "stability"
                  ? "当前按最弱一环排序；这是未通过串关时间验证的研究观察口径"
                  : "组合命中率为各场验证后历史预测概率的乘积，按场次相互独立估算"
              }`,
            value:
              "回报指数 = 组合赔率 × 估算命中率，1.00 为理论盈亏平衡线",
          },
    sourceUpdatedAt: dataStore.getSourceUpdatedAt(),
  };
}

function parlaySnapshotLeg(leg, mode, context) {
  const selections =
    mode === "goalsPair"
      ? leg.selections.map((selection) => ({
          label: String(selection.label),
          odds: Number(selection.odds),
          probability: Number(selection.probability),
        }))
      : [
          {
            label: String(leg.predicted),
            odds: Number(leg.odds),
            probability: Number(leg.probability),
          },
        ];
  const market = mode === "goalsPair" ? "goalsPair" : leg.market;
  const marketContext = context.sources[ledgerMarketKey(market)];
  return {
    matchId: String(leg.id),
    league: leg.league,
    home: leg.home,
    away: leg.away,
    market,
    marketLabel: leg.marketLabel,
    handicap: leg.handicap ?? null,
    predicted: leg.predicted,
    selections,
    probability: Number(leg.probability),
    samples: Number(leg.samples || 0),
    historySourceFile: marketContext?.source || context.source,
    historyRowWatermark: marketContext?.watermark || context.watermark,
    historySourceUpdatedAt: marketContext?.updatedAt || null,
  };
}

function recordParlayCombination(payload, combination, selectionSource) {
  const context = ledgerHistoryContext();
  if (!context.source || !context.watermark) {
    throw new Error("历史数据缺少可用水位，暂时无法保存串关快照");
  }
  return parlayLedger.record({
    combinationId: combination.id,
    mode: payload.mode,
    selectionSource,
    policyVersion: ledgerPolicyVersion({
      sameLeague: Boolean(payload.requestSettings.sameLeague),
    }),
    capturedAt: new Date().toISOString(),
    sourceUpdatedAt:
      context.sources[ledgerMarketKey(combination.legs[0]?.market)]?.updatedAt ||
      context.sources.goals?.updatedAt ||
      dataStore.getSourceUpdatedAt(),
    historySourceFile: context.source,
    historyRowWatermark: context.watermark,
    legs: combination.legs.map((leg) =>
      parlaySnapshotLeg(leg, payload.mode, context),
    ),
    settings: {
      ...payload.requestSettings,
      algorithmVersion: ledgerParlayAlgorithmVersion(payload.mode, payload.requestSettings),
      ledgerValidationPending: Boolean(challengerConfig.selectionStale),
    },
    totalStake: Number(combination.totalStake || 1),
    hitProbability: Number(combination.hitProbability),
    valueIndex: Number(combination.valueIndex),
  });
}

function settleParlayLedger() {
  const context = ledgerHistoryContext();
  const settledAt = new Date().toISOString();
  let settled = 0;
  let backfilled = 0;
  const snapshots = [
    ...parlayLedger.pending().map((snapshot) => ({
      snapshot,
      alreadySettled: false,
    })),
    ...parlayLedger.incompleteSettled().map((snapshot) => ({
      snapshot,
      alreadySettled: true,
    })),
  ];
  return parlayLedger.transaction(() => {
    for (const { snapshot, alreadySettled } of snapshots) {
    const legs = JSON.parse(snapshot.legs_json || "[]");
    const previousResults = JSON.parse(snapshot.actual_results_json || "[]");
    const resultByMatch = new Map(
      previousResults.map((result) => [String(result.matchId), result]),
    );
    for (const leg of legs) {
      const result = findLedgerResult(context.history, snapshot, leg);
      if (!result) continue;
      const actualResult = ledgerActualResult(result, leg.market);
      const resultReference = ledgerResultReference(result, leg.market);
      const selection = leg.selections.find(
        (item) => String(item.label) === String(actualResult),
      );
      resultByMatch.set(String(leg.matchId), {
        matchId: leg.matchId,
        actualResult,
        score: result.score,
        correct: Boolean(selection),
        selectedOdds: selection ? Number(selection.odds) : null,
        sourceFile: resultReference.source,
        sourceRow: resultReference.row,
      });
    }
    const actualResults = legs
      .map((leg) => resultByMatch.get(String(leg.matchId)))
      .filter(Boolean);
      if (alreadySettled) {
        if (parlayLedger.updateProgress(snapshot.id, actualResults)) {
          backfilled += 1;
        }
        continue;
      }
      const decision = parlaySettlementDecision(legs.length, actualResults);
      if (!decision.ready) {
        parlayLedger.updateProgress(snapshot.id, actualResults);
        continue;
      }
      const simulatedReturn = decision.correct
        ? actualResults.reduce(
            (product, result) => product * Number(result.selectedOdds),
            1,
          )
        : 0;
      parlayLedger.settle(snapshot.id, {
        correct: decision.correct,
        simulatedReturn,
        totalStake: Number(snapshot.total_stake),
        actualResults,
        settledAt,
      });
      settled += 1;
    }
    return { settled, backfilled };
  });
}

async function handleApi(request, url, response) {
  refreshRuntimeConfiguration();
  if (url.pathname === "/api/prediction-audit") {
    if (request.method !== "GET") return sendJson(response, 405, { error: "请使用 GET 读取冻结预测复盘" });
    return sendJson(response, 200, readPredictionAudit(auditPaths(ROOT)));
  }
  if (url.pathname === "/api/runtime") {
    if (request.method !== "GET") return sendJson(response, 405, { error: "请使用 GET 查询运行状态" });
    return sendJson(response, 200, { runtime: runtimeView(), currentAlgorithmSpec: ledgerCurrentAlgorithmSpec() });
  }
  if (url.pathname === "/api/shadow/spf") {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      return sendJson(response, 405, { error: "请求方法不允许" });
    }
    return sendJson(response, 200, shadowPredictionLedger.summary());
  }

  if (
    url.pathname === "/api/ledger" ||
    url.pathname === "/api/ledger/settle"
  ) {
    const shouldSettle = url.pathname === "/api/ledger/settle";
    const expectedMethod = shouldSettle ? "POST" : "GET";
    if (request.method !== expectedMethod) {
      response.setHeader("Allow", expectedMethod);
      return sendJson(response, 405, { error: "请求方法不允许" });
    }
    const settledNow = shouldSettle ? settlePredictionLedger() : 0;
    const shadowSettledNow = shouldSettle ? settleSpfShadowLedger() : 0;
    const parlaySettlement = shouldSettle
      ? settleParlayLedger()
      : { settled: 0, backfilled: 0 };
    const singleOptions = {
      status: url.searchParams.get("singleStatus") || "all",
      market: url.searchParams.get("singleMarket") || "all",
      scope: url.searchParams.get("singleScope") || "all",
      league: url.searchParams.get("singleLeague") || "all",
      query: url.searchParams.get("singleQuery") || "",
      predicted: url.searchParams.get("singlePredicted") || "",
      actual: url.searchParams.get("singleActual") || "",
      from: url.searchParams.get("singleFrom") || "",
      to: url.searchParams.get("singleTo") || "",
      policyVersion: url.searchParams.get("singlePolicy") || "current",
      currentPolicyPrefix: ledgerPolicyPrefix(),
      currentPolicyVersions: ledgerCurrentAlgorithmVersions(),
      currentAlgorithmSpec: ledgerCurrentAlgorithmSpec(),
      page: numberParam(url.searchParams, "singlePage", 1, 1, 100000),
      pageSize: numberParam(url.searchParams, "pageSize", 20, 5, 100),
    };
    const parlayOptions = {
      status: url.searchParams.get("parlayStatus") || "all",
      mode: url.searchParams.get("parlayMode") || "all",
      source: url.searchParams.get("parlaySource") || "all",
      query: url.searchParams.get("parlayQuery") || "",
      from: url.searchParams.get("parlayFrom") || "",
      to: url.searchParams.get("parlayTo") || "",
      policyVersion: url.searchParams.get("parlayPolicy") || "current",
      currentPolicyPrefix: ledgerPolicyPrefix(),
      currentPolicyVersions: ledgerCurrentSnapshotPolicyVersions(),
      page: numberParam(url.searchParams, "parlayPage", 1, 1, 100000),
      pageSize: numberParam(url.searchParams, "pageSize", 20, 5, 100),
    };
    const overviewPolicy = url.searchParams.get("overviewPolicy") || "current";
    const overviewFrom = url.searchParams.get("overviewFrom") || "";
    const overviewTo = url.searchParams.get("overviewTo") || "";
    const overviewOptions = {
      status: "all",
      scope: "all",
      from: overviewFrom,
      to: overviewTo,
      applyFiltersToSummary: true,
      policyVersion: overviewPolicy,
      currentPolicyPrefix: ledgerPolicyPrefix(),
      currentPolicyVersions: ledgerCurrentAlgorithmVersions(),
      currentAlgorithmSpec: ledgerCurrentAlgorithmSpec(),
      page: 1,
      pageSize: 5,
    };
    const singleSummary = predictionLedger.summary(singleOptions);
    const parlaySummary = parlayLedger.summary(parlayOptions);
    const overviewSummary = predictionLedger.summary(overviewOptions);
    const currentEvidenceSummary =
      overviewPolicy === "current"
        ? overviewSummary
        : predictionLedger.summary({
            ...overviewOptions,
            policyVersion: "current",
          });
    const lifetimeEvidenceSummary =
      overviewPolicy === "all"
        ? overviewSummary
        : predictionLedger.summary({
            ...overviewOptions,
            policyVersion: "all",
          });
    const overviewParlays = parlayLedger.summary({
      status: "all",
      from: overviewFrom,
      to: overviewTo,
      applyFiltersToSummary: true,
      policyVersion: overviewPolicy,
      currentPolicyPrefix: ledgerPolicyPrefix(),
      currentPolicyVersions: ledgerCurrentSnapshotPolicyVersions(),
      page: 1,
      pageSize: 5,
    });
    return sendJson(response, 200, {
      ...singleSummary,
      parlays: parlaySummary,
      overview: {
        ...overviewSummary,
        policyMode: overviewPolicy,
        evidence: {
          current: ledgerEvidenceLayer(currentEvidenceSummary),
          lifetime: ledgerEvidenceLayer(lifetimeEvidenceSummary),
          historical: historicalValidationEvidence(),
        },
        parlays: overviewParlays,
      },
      settledNow,
      shadowSettledNow,
      parlaySettledNow: parlaySettlement.settled,
      parlayBackfilledNow: parlaySettlement.backfilled,
      policyVersion: ledgerPolicyVersion(),
      currentPolicyVersions: ledgerCurrentAlgorithmVersions(),
      currentSnapshotPolicyVersions: ledgerCurrentSnapshotPolicyVersions(),
      historicalSourceUpdatedAt: dataStore.getHistoricalSourceUpdatedAt(),
      sourceUpdatedAt: dataStore.getSourceUpdatedAt(),
      selectionPolicy: challengerConfig.selection || null,
    });
  }

  if (url.pathname === "/api/matches") {
    const matches = dataStore.getMatches();
    return sendJson(response, 200, {
      matches,
      dataStatus: dataStore.getDataStatus(),
      sourceUpdatedAt: dataStore.getSourceUpdatedAt(),
      modelConfig,
      adaptiveConfig,
      segmentConfig: segmentConfigView(),
      goalZeroConfig: goalZeroConfigView(),
      weightingConfig,
      movementConfig,
      smoothingConfig,
      challengerConfig,
      productionPolicy,
    });
  }

  if (url.pathname === "/api/parlay/save") {
    if (request.method !== "POST") {
      return sendJson(response, 405, { error: "请使用保存按钮记录串关" });
    }
    const payload = buildParlayPayload(url);
    const combinationId = url.searchParams.get("combinationId") || "";
    const combination = payload.combinations.rows.find(
      (row) => row.id === combinationId,
    );
    if (!combination) {
      return sendJson(response, 404, {
        error: "没有找到这组串关，请重新生成后再保存",
      });
    }
    const selectionSource =
      url.searchParams.get("selectionSource") === "system_default"
        ? "system_default"
        : "user_saved";
    const saved = recordParlayCombination(
      payload,
      combination,
      selectionSource,
    );
    return sendJson(response, saved.inserted ? 201 : 200, {
      inserted: saved.inserted,
      duplicate: !saved.inserted,
      record: saved.row,
    });
  }

  if (url.pathname === "/api/parlay") {
    const payload = buildParlayPayload(url);
    const context = ledgerHistoryContext();
    for (const combination of payload.combinations.rows) {
      combination.recorded = parlayLedger.findRecorded({
        mode: payload.mode,
        policyVersion: ledgerPolicyVersion({ sameLeague: Boolean(payload.requestSettings.sameLeague) }),
        settings: { algorithmVersion: ledgerParlayAlgorithmVersion(payload.mode, payload.requestSettings) },
        legs: combination.legs.map(leg => parlaySnapshotLeg(leg, payload.mode, context)),
      });
    }
    return sendJson(response, 200, payload);
  }

  if (
    url.pathname === "/api/predict" ||
    url.pathname === "/api/predict/snapshot"
  ) {
    const shouldSnapshot = url.pathname === "/api/predict/snapshot";
    if (
      (!shouldSnapshot && request.method !== "GET") ||
      (shouldSnapshot && request.method !== "POST")
    ) {
      return sendJson(response, 405, {
        error: shouldSnapshot
          ? "预测留档请使用POST"
          : "预测查询请使用GET",
      });
    }
    const matches = dataStore.getMatches();
    const match = matches.find((item) => item.id === url.searchParams.get("matchId"));
    if (!match) return sendJson(response, 404, { error: "没有找到这场比赛" });

    const spfTolerance = numberParam(
      url.searchParams,
      "spfTolerance",
      productionPolicy.thresholds.spf,
      0.02,
      0.3,
    );
    const hhadTolerance = numberParam(
      url.searchParams,
      "hhadTolerance",
      productionPolicy.thresholds.hhad,
      0.02,
      0.3,
    );
    const goalTolerance = numberParam(
      url.searchParams,
      "goalTolerance",
      productionPolicy.thresholds.goals,
      0.001,
      0.03,
    );
    const sameLeague = url.searchParams.get("sameLeague") === "true";
    const spfPage = numberParam(url.searchParams, "spfPage", 1, 1, 10000);
    const goalPage = numberParam(url.searchParams, "goalPage", 1, 1, 10000);
    const hhadPage = numberParam(url.searchParams, "hhadPage", 1, 1, 10000);
    const pageSize = numberParam(url.searchParams, "pageSize", 18, 8, 50);

    const hadOdds = match.had
      ? [match.had.h, match.had.d, match.had.a]
      : null;
    const verifiedHistory = dataStore.getVerifiedHistory({
      league: match.league,
      sameLeague,
    });
    const historyOptions = { league: match.league, sameLeague };
    const {
      spfHistory,
      hhadHistory,
      pairedHistory,
      goalHistory,
    } = predictionMarketHistories(match, {
      spfTolerance,
      hhadTolerance,
      sameLeague,
    });
    const scopedHistoryCounts = dataStore.getHistoryCounts(historyOptions);
    const challengerHistory = sameLeague
      ? dataStore.getVerifiedHistory()
      : verifiedHistory;
    const challengerGoalHistory = sameLeague
      ? dataStore.getGoalHistory()
      : goalHistory;
    const challenger =
      match.had && match.hhad && match.goals
        ? challengerEngine?.predict(match, {
            paired: challengerHistory,
            goals: challengerGoalHistory,
          }) || null
        : null;

    const { spfResult, hhadResult } = buildThreeWayPredictionResults(match, {
      spfHistory,
      hhadHistory,
      pairedHistory,
      spfTolerance,
      hhadTolerance,
      challenger,
      sameLeague,
    });
    const spfPrediction = spfResult?.prediction || null;
    const similarSpf = spfResult?.similar || [];
    const goalResult = buildGoalPredictionResult(
      match,
      goalHistory,
      goalTolerance,
      challenger?.goals,
      { sameLeague },
    );
    const goalScope = goalResult?.scope || null;
    const similarGoals = goalResult?.similar || [];
    const effectiveGoalTolerance = goalResult?.tolerance ?? null;
    const goalModel = goalResult?.model || null;
    const goalPrediction = goalResult?.prediction || null;
    const goalMultiple = match.goals
      ? selectGoalMultiplePrediction(
          ledgerMarketOdds(match, "goals"),
          goalMultipleDistribution,
        )
      : null;
    const goalEquality = match.goals
      ? selectGoalEqualityPrediction(
          ledgerMarketOdds(match, "goals"),
          goalEqualityDistribution,
        )
      : null;
    const {
      spf: spfStability,
      hhad: hhadStability,
    } = buildThreeWayStability(match, {
      spfHistory,
      hhadHistory,
      pairedHistory,
      spfResult,
      hhadResult,
      sameLeague,
    });
    const goalStability = goalResult?.stability || null;
    const spfReliability = spfPrediction
      ? reliabilityView(
          "spf",
          spfPrediction,
          spfStability,
          { threshold: spfResult.tolerance, sameLeague },
        )
      : null;
    const hhadReliability = hhadResult
      ? reliabilityView(
          "hhad",
          hhadResult.prediction,
          hhadStability,
          { threshold: hhadResult.tolerance, sameLeague },
        )
      : null;
    const goalReliability = goalResult?.reliability || null;

    const topScores = computeScoreDistribution(similarGoals);
    const topScoresSuggest = topScores.length
      ? `历史出现较多 ${topScores[0].score}${topScores[1] ? ` · 其次 ${topScores[1].score}` : ""}`
      : "";

    const initialHad = match.had?.history?.initial;
    const initialHadOdds = initialHad
      ? [initialHad.h, initialHad.d, initialHad.a]
      : hadOdds;

    const payload = {
      topScores,
      runtime: runtimeView(),
      currentAlgorithmSpec: ledgerCurrentAlgorithmSpec(),
      configuration: { modelConfig, productionPolicy, adaptiveConfig, segmentConfig: segmentConfigView(),
        goalZeroConfig: goalZeroConfigView(), weightingConfig, movementConfig, smoothingConfig, challengerConfig },
      topScoresSuggest,
      recentForm: dataStore.getRecentForm(match),
      match: {
        id: match.id,
        displayName: match.displayName,
        league: match.league,
        home: match.home,
        away: match.away,
        had: match.had,
        hhad: match.hhad,
        goals: match.goals,
        hadTimeline: match.hadTimeline,
        hhadTimeline: match.hhadTimeline,
        goalTimeline: match.goalTimeline,
        initialHadProbability: initialHadOdds
          ? normalizeOdds(initialHadOdds)
          : null,
      },
      settings: {
        spfTolerance,
        hhadTolerance,
        goalTolerance,
        effectiveThresholds: {
          spf: spfResult?.tolerance ?? spfTolerance,
          hhad: hhadResult?.tolerance ?? hhadTolerance,
          goals: effectiveGoalTolerance,
        },
        adaptive: {
          spf: adaptiveScopeView(spfResult?.adaptive),
          hhad: adaptiveScopeView(hhadResult?.adaptive),
          goals: adaptiveScopeView(goalScope),
        },
        segmentation: {
          spf: segmentScopeView(spfResult?.adaptive),
          hhad: segmentScopeView(hhadResult?.adaptive),
          goals: segmentScopeView(goalScope),
        },
        zeroOdds: zeroOddsScopeView(goalScope),
        matching: {
          spf: spfResult?.matchingLabel || null,
          hhad: hhadResult?.matchingLabel || null,
          goals: goalResult ? "总进球独立匹配" : null,
          jointSamples: Math.max(
            spfResult?.jointSamples || 0,
            hhadResult?.jointSamples || 0,
          ),
        },
        sameLeague,
        pageSize,
      },
      model: {
        generatedAt: modelConfig.generatedAt,
        spf: {
          ...(spfResult?.model ||
            modelDecision("spf", spfTolerance, { sameLeague })),
          applied: Boolean(spfPrediction?.available),
        },
        hhad: {
          ...(hhadResult?.model ||
            modelDecision("hhad", hhadTolerance, { sameLeague })),
          applied: Boolean(hhadResult?.prediction.available),
        },
        goals: {
          ...(goalModel ||
            modelDecision("goals", goalTolerance, { sameLeague })),
          applied: Boolean(goalPrediction?.available),
        },
      },
      spf: spfPrediction
        ? {
            ...spfPrediction,
            reliability: spfReliability,
          }
        : null,
      hhad: hhadResult
        ? {
            ...hhadResult.prediction,
            handicap: hhadResult.handicap,
            reliability: hhadReliability,
          }
        : null,
      goals: goalPrediction
        ? {
            ...goalPrediction,
            reliability: goalReliability,
          }
        : null,
      goalMultiple,
      goalEquality,
      stability: {
        spf: spfStability
          ? {
              ...spfStability,
              selectedThreshold: spfResult.tolerance,
            }
          : null,
        hhad: hhadStability
          ? {
              ...hhadStability,
              selectedThreshold: hhadResult.tolerance,
            }
          : null,
        goals: goalStability
          ? {
              ...goalStability,
              selectedThreshold: effectiveGoalTolerance,
            }
          : null,
      },
      sampleOrigins: {
        spf: spfPrediction ? summarizeSampleOrigins(similarSpf, {
          league: match.league, mode: spfResult.matchingMode,
          effectiveSamples: spfPrediction.weighting?.effectiveSamples,
        }) : null,
        hhad: hhadResult ? summarizeSampleOrigins(hhadResult.similar || [], {
          league: match.league, mode: hhadResult.matchingMode,
          effectiveSamples: hhadResult.prediction.weighting?.effectiveSamples,
        }) : null,
        goals: goalPrediction ? summarizeSampleOrigins(similarGoals, {
          league: match.league, mode: "goals-independent",
          effectiveSamples: goalPrediction.weighting?.effectiveSamples,
        }) : null,
      },
      similarSpf: paginate(
        spfPrediction
          ? similarSpf.map((row) => compactSpfRow(row, spfPrediction))
          : [],
        spfPage,
        pageSize,
      ),
      similarHhad: paginate(
        (hhadResult?.similar || []).map((row) =>
          compactSpfRow(row, hhadResult.prediction),
        ),
        hhadPage,
        pageSize,
      ),
      similarGoals: paginate(
        goalPrediction
          ? similarGoals.map((row) => compactGoalRow(row, goalPrediction))
          : [],
        goalPage,
        pageSize,
      ),
      method: {
        spf: threeWayMethodText(spfResult, "spf"),
        hhad: threeWayMethodText(hhadResult, "hhad"),
        goals: !goalResult
          ? "缺少总进球赔率"
          : goalScope.zeroOddsBlocked
            ? goalScope.reason
            : goalScope.zeroOdds
            ? `总进球独立匹配；${zeroOddsMethodText(goalScope, goalPrediction)}；${smoothingMethodText(goalPrediction)}；${movementMethodText(goalPrediction)}`
            : `总进球独立匹配；八档最新去水概率每一档差值均不超过 ${(effectiveGoalTolerance * 100).toFixed(1)} 个百分点；${historicalMethodText(goalPrediction, "按概率距离加权")}；${smoothingMethodText(goalPrediction)}；${movementMethodText(goalPrediction)}`,
        goalMultiple: goalMultiple?.available
          ? `${goalMultiple.reason}；前两名覆盖 ${(
              goalMultiple.coverageProbability * 100
            ).toFixed(1)}%，只作独立倍数历史预测并记录命中率`
          : goalMultiple?.reason || "缺少总进球赔率",
        goalEquality: goalEquality?.available
          ? `${goalEquality.reason}；仅作同赔历史参考`
          : goalEquality?.reason || "缺少总进球赔率",
      },
      dataStats: {
        ...dataStore.getCounts(),
        currentSpfHistory: scopedHistoryCounts.spfHistory,
        currentHhadHistory: scopedHistoryCounts.hhadHistory,
        currentGoalHistory: scopedHistoryCounts.goalHistory,
      },
    };
    const ledgerSnapshotInserted = shouldSnapshot
      ? recordPredictionPayload(payload)
      : 0;
    const shadowSnapshotInserted =
      shouldSnapshot &&
      !sameLeague &&
      Math.abs(spfTolerance - productionPolicy.thresholds.spf) <= 1e-9 &&
      Math.abs(hhadTolerance - productionPolicy.thresholds.hhad) <= 1e-9
        ? recordSpfShadowPrediction(match)
        : 0;
    return sendJson(response, 200, {
      ...payload,
      ledgerSnapshotInserted,
      shadowSnapshotInserted,
    });
  }

  return false;
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
  return true;
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

async function serveStatic(url, response) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC, safePath);
  if (!filePath.startsWith(PUBLIC)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("页面不存在");
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(request, url, response);
      if (handled === false) sendJson(response, 404, { error: "接口不存在" });
      return;
    }
    await serveStatic(url, response);
  } catch (error) {
    const requestId = randomUUID();
    console.error(`[request ${requestId}]`, error);
    sendJson(response, 500, { error: "服务处理失败", requestId });
  }
});

let lastLedgerSourceUpdatedAt = null;
let ledgerRefreshPromise = null;

async function refreshCurrentLedger({ force = false } = {}) {
  refreshRuntimeConfiguration();
  const sourceUpdatedAt = `${dataStore.getSourceUpdatedAt()}|${runtime.revision}`;
  if (!force && sourceUpdatedAt === lastLedgerSourceUpdatedAt) {
    return Promise.resolve();
  }
  if (ledgerRefreshPromise) return ledgerRefreshPromise;
  ledgerRefreshPromise = snapshotCurrentMatches()
    .then(() => {
      lastLedgerSourceUpdatedAt = sourceUpdatedAt;
    })
    .finally(() => {
      ledgerRefreshPromise = null;
    });
  return ledgerRefreshPromise;
}

let ledgerRefreshTimer = null;
let resourcesClosed = false;

function closeResources() {
  if (resourcesClosed) return;
  resourcesClosed = true;
  predictionLedger.close();
  shadowPredictionLedger.close();
  parlayLedger.close();
  dataStore.close();
}

let fatalShutdownStarted = false;

function fatalShutdown(kind, error) {
  if (fatalShutdownStarted) return;
  fatalShutdownStarted = true;
  const detail = error instanceof Error ? error.stack || error.message : error;
  console.error(`[${kind}] 进程发生不可恢复异常：`, detail);
  if (ledgerRefreshTimer) clearInterval(ledgerRefreshTimer);
  try {
    server.close();
  } catch {
    // 服务器可能尚未开始监听；仍需继续关闭数据库。
  }
  try {
    closeResources();
  } catch (closeError) {
    console.error("关闭数据库资源失败：", closeError);
  }
  process.exit(1);
}

process.on("unhandledRejection", (reason) => {
  fatalShutdown("unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
  fatalShutdown("uncaughtException", error);
});

server.on("error", (error) => {
  if (ledgerRefreshTimer) clearInterval(ledgerRefreshTimer);
  if (error?.code === "EADDRINUSE") {
    console.error(
      `无法启动：端口 ${PORT} 已被占用。原服务可能已经在运行，请先打开 http://localhost:${PORT}；如需另开服务，可执行 PORT=${PORT + 1} npm start。`,
    );
  } else {
    console.error(`服务器启动失败：${error?.message || error}`);
  }
  closeResources();
  process.exitCode = 1;
});

server.listen(PORT, "127.0.0.1", () => {
  const counts = dataStore.getCounts();
  console.log(`竞彩赔率雷达已启动：http://localhost:${PORT}`);
  console.log(`数据库：${DATABASE_PATH}`);
  console.log(
    `历史样本：统一已校验 ${counts.verifiedHistory.toLocaleString()} / 全部统一比赛 ${counts.unifiedHistory.toLocaleString()}`,
  );
  refreshCurrentLedger({ force: true }).catch((error) => {
    console.error(`赛前账本自动留档失败：${error.message}`);
  });
});

ledgerRefreshTimer = setInterval(() => {
  refreshCurrentLedger().catch((error) => {
    console.error(`赛前账本自动更新失败：${error.message}`);
  });
}, 10_000);
ledgerRefreshTimer.unref();

async function snapshotCurrentMatches() {
  let inserted = 0;
  let shadowInserted = 0;
  let eligible = 0;
  const context = ledgerHistoryContext();
  for (const match of dataStore.getMatches()) {
    if (!match.had && !match.hhad && !match.goals) continue;
    const resultAlreadyImported = ["goals", "spf", "hhad"].some((market) => {
      if (
        (market === "spf" && !match.had) ||
        (market === "hhad" && !match.hhad) ||
        (market === "goals" && !match.goals)
      ) {
        return false;
      }
      const marketContext = context.sources[market];
      if (!marketContext?.source) return false;
      return Boolean(
        findLedgerResult(
          context.history,
          {
            history_source_file: marketContext.source,
            history_row_watermark: marketContext.watermark,
            odds_json: JSON.stringify(ledgerMarketOdds(match, market)),
          },
          {
            market,
            league: match.league,
            home: match.home,
            away: match.away,
            handicap: market === "hhad" ? match.hhad.goalLine : null,
          },
        ),
      );
    });
    if (resultAlreadyImported) continue;
    eligible += 1;
    for (const sameLeague of [false, true]) {
      const params = new URLSearchParams({
        matchId: match.id,
        spfTolerance: String(productionPolicy.thresholds.spf),
        hhadTolerance: String(productionPolicy.thresholds.hhad),
        goalTolerance: String(productionPolicy.thresholds.goals),
        sameLeague: String(sameLeague),
      });
      const response = await fetch(
        `http://127.0.0.1:${PORT}/api/predict/snapshot?${params}`,
        { method: "POST" },
      );
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`${match.displayName}: ${response.status} ${detail}`);
      }
      const payload = await response.json();
      inserted += Number(payload.ledgerSnapshotInserted || 0);
      shadowInserted += Number(payload.shadowSnapshotInserted || 0);
    }
  }
  const settled = settlePredictionLedger();
  const shadowSettled = settleSpfShadowLedger();
  console.log(
    `赛前账本：检查 ${eligible} 场 × 2种口径，新增或更新 ${inserted} 条，结算 ${settled} 条；` +
      `SPF影子模型新增或更新 ${shadowInserted} 条，结算 ${shadowSettled} 条`,
  );
}

function shutdown() {
  if (ledgerRefreshTimer) clearInterval(ledgerRefreshTimer);
  server.close(() => {
    closeResources();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
