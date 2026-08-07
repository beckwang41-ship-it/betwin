import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "./lib/database.mjs";
import { selectAdaptiveSimilarity } from "./lib/adaptive-threshold.mjs";
import {
  classifyGoalOdds,
  classifyThreeWayOdds,
} from "./lib/odds-segments.mjs";
import {
  findSimilarByGoalBand,
  findZeroOddsInterval,
} from "./lib/goal-zero-odds.mjs";
import { createChallenger } from "./lib/challenger.mjs";
import {
  normalizeFixtureText,
  normalizeTeamName,
} from "./lib/fixture-name.mjs";
import { createParlayLedger } from "./lib/parlay-ledger.mjs";
import { createPredictionLedger } from "./lib/prediction-ledger.mjs";
import { evaluateReliability } from "./lib/reliability.mjs";
import {
  generateGoalPairParlays,
  generateParlayCombinations,
} from "./lib/parlay.mjs";
import {
  GOAL_LABELS,
  confidenceLabel,
  distanceWeight,
  findSimilarGoalMovements,
  findSimilarGoals,
  findSimilarSpfMovements,
  findSimilarSpf,
  goalDistance,
  normalizeOdds,
  paginate,
  predictGoals,
  predictGoalsWithMovement,
  predictSpf,
  predictSpfWithMovement,
  selectTopGoalPair,
  spfDistance,
  summarizeStability,
} from "./lib/predictor.mjs";
import { selectHistoricalPrior } from "./lib/smoothing.mjs";
import {
  THREE_WAY_MATCHING_VERSION,
  selectThreeWaySimilarity,
} from "./lib/three-way-matching.mjs";

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
const GOAL_ZERO_CONFIG_PATH = path.join(
  ROOT,
  "data",
  "goal-zero-odds-config.json",
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
const SMOOTHING_CONFIG_PATH = path.join(
  ROOT,
  "data",
  "smoothing-config.json",
);
const CHALLENGER_CONFIG_PATH = path.join(
  ROOT,
  "data",
  "challenger-config.json",
);
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
const parlayLedger = createParlayLedger(DATABASE_PATH);
const DEFAULT_THRESHOLDS = {
  spf: 0.07,
  hhad: 0.07,
  goals: 0.015,
};
const productionPolicy = {
  empiricalOnly: true,
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
    enabled: false,
    intervals: [],
    policies: {},
    reason: "0球赔率区间模型尚未验证",
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
};
const STABILITY_THRESHOLDS = {
  spf: [0.03, 0.05, 0.07, 0.1],
  hhad: [0.03, 0.05, 0.07, 0.1],
  goals: [0.005, 0.01, 0.015, 0.02],
};

function loadModelConfig() {
  try {
    const config = JSON.parse(readFileSync(MODEL_CONFIG_PATH, "utf8"));
    const counts = dataStore.getCounts();
    const sourceUpdatedAt = dataStore.getSourceUpdatedAt();
    const stale =
      config.data?.verifiedMatches !== counts.verifiedHistory ||
      !config.data?.sourceUpdatedAt ||
      config.data.sourceUpdatedAt !== sourceUpdatedAt ||
      config.methodology?.matchingVersion !== THREE_WAY_MATCHING_VERSION;
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
              currentThreshold: DEFAULT_THRESHOLDS[market],
              candidateThreshold: DEFAULT_THRESHOLDS[market],
              threshold: DEFAULT_THRESHOLDS[market],
              changed: false,
              gate: {
                ...(value.gate || {}),
                passed: false,
                reason:
                  "历史数据已更新，旧阈值验证失效，暂时保留原默认阈值",
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
            currentThreshold: DEFAULT_THRESHOLDS[market],
            candidateThreshold: DEFAULT_THRESHOLDS[market],
            threshold: DEFAULT_THRESHOLDS[market],
            changed: false,
            gate: {
              passed: false,
              reason: "尚未运行严格阈值验证，暂时保留原默认阈值",
            },
          },
        ]),
      ),
    };
  }
}

const modelConfig = loadModelConfig();
if (!modelConfig.stale) {
  for (const market of ["spf", "hhad", "goals"]) {
    const threshold = Number(modelConfig.markets?.[market]?.threshold);
    if (Number.isFinite(threshold) && threshold > 0) {
      productionPolicy.thresholds[market] = threshold;
    }
  }
}

function loadAdaptiveConfig() {
  try {
    const config = JSON.parse(readFileSync(ADAPTIVE_CONFIG_PATH, "utf8"));
    const counts = dataStore.getCounts();
    const sourceUpdatedAt = dataStore.getSourceUpdatedAt();
    const stale =
      config.data?.verifiedMatches !== counts.verifiedHistory ||
      !config.data?.sourceUpdatedAt ||
      config.data.sourceUpdatedAt !== sourceUpdatedAt;
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

const adaptiveConfig = loadAdaptiveConfig();
if (!adaptiveConfig.stale) {
  for (const market of ["spf", "hhad", "goals"]) {
    const config = adaptiveConfig.markets?.[market];
    productionPolicy.adaptive[market] = {
      enabled: Boolean(config?.enabled),
      minSamples: Number(config?.minSamples) || null,
      thresholds: Array.isArray(config?.thresholds)
        ? config.thresholds.map(Number)
        : [],
      reason: config?.gate?.reason || "尚未验证动态范围",
    };
  }
}

function loadSegmentConfig() {
  try {
    const config = JSON.parse(readFileSync(SEGMENT_CONFIG_PATH, "utf8"));
    const counts = dataStore.getCounts();
    const sourceUpdatedAt = dataStore.getSourceUpdatedAt();
    const stale =
      config.data?.verifiedMatches !== counts.verifiedHistory ||
      !config.data?.sourceUpdatedAt ||
      config.data.sourceUpdatedAt !== sourceUpdatedAt;
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
if (!segmentConfig.stale) {
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

function loadGoalZeroConfig() {
  try {
    const config = JSON.parse(readFileSync(GOAL_ZERO_CONFIG_PATH, "utf8"));
    const counts = dataStore.getCounts();
    const sourceUpdatedAt = dataStore.getSourceUpdatedAt();
    const stale =
      config.data?.verifiedMatches !== counts.verifiedHistory ||
      !config.data?.sourceUpdatedAt ||
      config.data.sourceUpdatedAt !== sourceUpdatedAt;
    return { ...config, stale };
  } catch {
    return {
      version: 0,
      generatedAt: null,
      stale: true,
      model: null,
    };
  }
}

const goalZeroConfig = loadGoalZeroConfig();
if (!goalZeroConfig.stale && goalZeroConfig.model?.enabled) {
  productionPolicy.zeroGoals = {
    enabled: true,
    intervals:
      goalZeroConfig.model.intervals ||
      goalZeroConfig.model.learned?.intervals ||
      [],
    policies: goalZeroConfig.model.policies || {},
    reason: goalZeroConfig.model.gate?.reason || "0球赔率区间模型已通过验证",
  };
}

function goalZeroConfigView() {
  return {
    version: goalZeroConfig.version,
    generatedAt: goalZeroConfig.generatedAt,
    stale: goalZeroConfig.stale,
    enabled: Boolean(productionPolicy.zeroGoals.enabled),
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
    const sourceUpdatedAt = dataStore.getSourceUpdatedAt();
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
      thresholdChanged;
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
productionPolicy.weighting = Object.fromEntries(
  ["spf", "hhad", "goals"].map((market) => {
    const config = weightingConfig.markets[market];
    return [
      market,
      {
        ...config.production,
        validated: Boolean(config.gate?.passed),
        significanceStatus:
          config.selected?.significance?.status || "not-run",
        reason: config.gate?.reason,
      },
    ];
  }),
);

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
    const sourceUpdatedAt = dataStore.getSourceUpdatedAt();
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
      thresholdChanged;
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
productionPolicy.movement = Object.fromEntries(
  ["spf", "hhad", "goals"].map((market) => {
    const config = movementConfig.markets[market];
    return [
      market,
      {
        ...config.production,
        validated: Boolean(config.gate?.passed),
        significanceStatus:
          config.selected?.significance?.status || "not-run",
        reason: config.gate?.reason,
      },
    ];
  }),
);

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
    const sourceUpdatedAt = dataStore.getSourceUpdatedAt();
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
      thresholdChanged;
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
              "尚未运行严格小样本平滑验证，最终预测使用原始历史占比",
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

const smoothingConfig = loadSmoothingConfig();
productionPolicy.smoothing = Object.fromEntries(
  ["spf", "hhad", "goals"].map((market) => {
    const config = smoothingConfig.markets[market];
    return [
      market,
      {
        ...config.production,
        validated: Boolean(config.gate?.passed),
        significanceStatus:
          config.selected?.significance?.status || "not-run",
        reason: config.gate?.reason,
      },
    ];
  }),
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
    const sourceUpdatedAt = dataStore.getSourceUpdatedAt();
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
const challengerConfig = challengerArtifacts.config;
const challengerEngine = challengerArtifacts.model
  ? createChallenger(challengerArtifacts.model)
  : null;

function loadGoalPairSelectionConfig() {
  try {
    const config = JSON.parse(
      readFileSync(GOAL_PAIR_SELECTION_PATH, "utf8"),
    );
    const stale =
      !config.data?.sourceUpdatedAt ||
      config.data.sourceUpdatedAt !== dataStore.getSourceUpdatedAt();
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
    return [
      market,
      {
        ...(config.production || unavailableChallenger(config.gate?.reason)),
        validated: Boolean(config.gate?.passed),
        reason: config.gate?.reason,
        selectedCandidate: config.selectedCandidate || null,
      },
    ];
  }),
);

function movementOptions(market) {
  const policy = productionPolicy.movement[market];
  return {
    applyCorrection: policy.enabled,
    fixedWeight: policy.fixedWeight,
    minSamples: policy.minSamples,
    validation: {
      validated: policy.validated,
      enabled: policy.enabled,
      significanceStatus: policy.significanceStatus,
      reason: policy.reason,
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
  return {
    policy: "historical-similarity",
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
    enabled: true,
    empiricalOnly: true,
    fixedWeight: 1,
    minSamples: productionPolicy.minimumSamples,
    sameLeague,
    weighting: {
      tolerance: Number(threshold),
      ...weighting,
    },
    reason:
      weighting.enabled
        ? "距离权重已通过较早80%调参与最新20%验证；阈值内全部保留，零样本时不预测"
        : "距离权重未通过严格验证；最终概率采用等权历史结果占比，零样本时不预测",
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
  const zeroOddsEnabled =
    market === "goals" &&
    Boolean(productionPolicy.zeroGoals.enabled) &&
    !goalZeroConfig.stale &&
    usesProductionMaximum;
  if (zeroOddsEnabled) {
    const interval = findZeroOddsInterval(
      productionPolicy.zeroGoals.intervals,
      targetOdds?.[0],
    );
    const policy = interval
      ? productionPolicy.zeroGoals.policies?.[interval.id] || null
      : null;
    const resolved = findSimilarByGoalBand(history, targetOdds, {
      intervals: productionPolicy.zeroGoals.intervals,
      policies: productionPolicy.zeroGoals.policies,
      ...finderOptions,
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
      zeroOddsInterval: resolved.interval,
      zeroOddsPolicy: policy,
      segment,
      reason: productionPolicy.zeroGoals.reason,
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
  const policy = scope.zeroOddsPolicy;
  return {
    enabled: Boolean(scope.zeroOdds),
    intervalId: interval?.id || null,
    intervalLabel: interval?.label || null,
    lower: interval?.lower ?? null,
    upper: interval?.upper ?? null,
    observedMin: interval?.observedMin ?? null,
    observedMax: interval?.observedMax ?? null,
    distanceEnabled: Boolean(policy?.enabled),
    threshold:
      policy?.threshold === null || policy?.threshold === undefined
        ? null
        : Number(policy.threshold),
    samples: Number(scope.samples || 0),
    reason: policy?.gate?.reason || scope.reason,
  };
}

function blendOptions(decision, smoothing = null) {
  return {
    enabled: decision.enabled,
    fixedWeight: decision.fixedWeight,
    minSamples: decision.minSamples,
    empiricalOnly: decision.empiricalOnly,
    weighting: decision.weighting,
    smoothing,
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
  const weight = distanceWeight(row.distance, prediction.weighting);
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
    similarity: 1 - Math.min(1, row.distance / 0.05),
    ...weightDetail(row, prediction),
  };
}

function stabilityPoint(threshold, prediction) {
  return {
    threshold,
    available: prediction.available,
    predicted: prediction.predicted,
    topLabels: prediction.topLabels,
    isTie: prediction.isTie,
    probabilities: prediction.final,
    topProbability: prediction.available
      ? Math.max(...prediction.final)
      : null,
    samples: prediction.stats.total,
    coreSamples: prediction.weighting.coreSamples,
    effectiveSamples: prediction.weighting.effectiveSamples,
  };
}

function historicalMethodText(prediction, weightedDescription) {
  if (!prediction.available) return "没有相似历史比赛，本场不生成预测";
  if (!prediction.weighting.enabled) {
    return `严格权重验证未通过，使用 ${prediction.stats.total.toLocaleString()} 场相似比赛等权统计`;
  }
  return `保留 ${prediction.stats.total.toLocaleString()} 场并${weightedDescription}，核心 ${prediction.weighting.coreSamples.toLocaleString()} 场、加权等效 ${prediction.weighting.effectiveSamples.toFixed(1)} 场`;
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
  return smoothing.applied
    ? `小样本平滑通过严格验证，已使用${detail}`
    : `小样本平滑未通过严格验证，${detail}，仅供参考`;
}

function zeroOddsMethodText(scope, prediction) {
  const interval = scope?.zeroOddsInterval;
  if (!scope?.zeroOdds || !interval) return "";
  const label = interval.label ||
    `${interval.lower === null ? "最低" : Number(interval.lower).toFixed(2)}～${interval.upper === null ? "最高" : Number(interval.upper).toFixed(2)}`;
  const policy = scope.zeroOddsPolicy;
  const distanceText = policy?.enabled
    ? `段内1球至7+球去水概率每项差不超过 ${(Number(policy.threshold) * 100).toFixed(2)}pp`
    : "该段七项赔率距离未重复通过验证，使用整段历史";
  return (
    `0球赔率先进入 ${label} 档，${distanceText}；` +
    `${historicalMethodText(prediction, "按其余七项赔率距离加权")}`
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
) {
  const points = STABILITY_THRESHOLDS[market].map((threshold) => {
    const similar = similarAtThreshold
      ? similarAtThreshold(threshold)
      : findSimilarSpf(history, odds, { tolerance: threshold });
    const decision = modelDecision(market, threshold);
    const prior = historicalPriorFor(
      history,
      { odds, league },
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
  return summarizeStability(points);
}

function buildThreeWayStability(
  match,
  { spfHistory, hhadHistory, pairedHistory, spfResult, hhadResult },
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
        ? buildSpfStability(spfHistory, hadOdds, "spf", match.league)
        : null,
      hhad: hhadResult
        ? buildSpfStability(
            hhadHistory.filter(
              (row) => row.handicap === hhadResult.handicap,
            ),
            hhadOdds,
            "hhad",
            match.league,
          )
        : null,
    };
  }

  const handicap = hhadResult.handicap;
  const jointSimilar = (market, threshold) =>
    pairedHistory
      .filter(
        (row) =>
          row.hhad.handicap === handicap &&
          spfDistance(row.spf.odds, hadOdds) <=
            (market === "spf" ? threshold : spfResult.tolerance) &&
          spfDistance(row.hhad.odds, hhadOdds) <=
            (market === "hhad" ? threshold : hhadResult.tolerance),
      )
      .map((row) => {
        const selected = market === "spf" ? row.spf : row.hhad;
        const target = market === "spf" ? hadOdds : hhadOdds;
        return {
          ...selected,
          distance: spfDistance(selected.odds, target),
        };
      });
  const pairedSpfHistory = pairedHistory.map((row) => row.spf);
  const pairedHhadHistory = pairedHistory
    .filter((row) => row.hhad.handicap === handicap)
    .map((row) => row.hhad);
  return {
    spf: buildSpfStability(
      pairedSpfHistory,
      hadOdds,
      "spf",
      match.league,
      (threshold) => jointSimilar("spf", threshold),
    ),
    hhad: buildSpfStability(
      pairedHhadHistory,
      hhadOdds,
      "hhad",
      match.league,
      (threshold) => jointSimilar("hhad", threshold),
    ),
  };
}

function buildGoalStability(history, odds, league) {
  const points = STABILITY_THRESHOLDS.goals.map((threshold) => {
    const similar = findSimilarGoals(history, odds, { tolerance: threshold });
    const decision = modelDecision("goals", threshold);
    const prior = historicalPriorFor(
      history,
      { odds, league },
      "goals",
      {
        labels: GOAL_LABELS,
        outcomeField: "goals",
        distance: (left, right) => goalDistance(left.odds, right.odds),
        threshold,
      },
    );
    const prediction = predictGoals(odds, similar, {
      ...blendOptions(
        decision,
        smoothingOptions("goals", prior, decision.usesRecommendedThreshold),
      ),
    });
    return stabilityPoint(threshold, prediction);
  });
  return summarizeStability(points);
}

function buildGoalPairStability(history, odds, league) {
  const points = STABILITY_THRESHOLDS.goals.map((threshold) => {
    const similar = findSimilarGoals(history, odds, { tolerance: threshold });
    const decision = modelDecision("goals", threshold);
    const prior = historicalPriorFor(
      history,
      { odds, league },
      "goals",
      {
        labels: GOAL_LABELS,
        outcomeField: "goals",
        distance: (left, right) => goalDistance(left.odds, right.odds),
        threshold,
      },
    );
    const prediction = predictGoals(odds, similar, {
      ...blendOptions(
        decision,
        smoothingOptions("goals", prior, decision.usesRecommendedThreshold),
      ),
    });
    const pair = selectTopGoalPair(prediction.final, odds);
    return {
      threshold,
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
      productionModel: "historical-similarity",
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

function reliabilityView(
  market,
  prediction,
  stability,
  { threshold, sameLeague = false } = {},
) {
  const policy = challengerConfig.selection?.markets?.[market];
  return evaluateReliability({
    prediction,
    stability,
    policy,
    threshold,
    sameLeague,
  });
}

function ledgerPolicyVersion({ sameLeague = false } = {}) {
  const validation = challengerConfig.stale ? ":pending-validation" : "";
  const scope = sameLeague ? ":same-league" : ":all-leagues";
  return `selection-v${challengerConfig.version || 0}@${challengerConfig.generatedAt || "untrained"}${validation}${scope}`;
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
        { source, watermark: sourceCounts.get(source)?.maxRow || 0 },
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

function findLedgerResult(history, snapshot, selection) {
  const market = selection.market;
  const source =
    selection.historySourceFile || snapshot.history_source_file;
  const watermark = Number(
    selection.historyRowWatermark ?? snapshot.history_row_watermark,
  );
  const matching = history
    .filter((row) => {
      const reference = ledgerResultReference(row, market);
      return (
        reference.source === source &&
        ledgerActualResult(row, market) !== null &&
        normalizeFixtureText(row.league) ===
          normalizeFixtureText(selection.league) &&
        normalizeTeamName(row.home) === normalizeTeamName(selection.home) &&
        normalizeTeamName(row.away) === normalizeTeamName(selection.away) &&
        (ledgerMarketKey(market) !== "hhad" ||
          Number(row.hhad.handicap) === Number(selection.handicap))
      );
    });
  const afterWatermark = matching
    .filter((row) => ledgerResultReference(row, market).row > watermark)
    .sort(
      (left, right) =>
        ledgerResultReference(left, market).row -
        ledgerResultReference(right, market).row,
    )[0];
  if (afterWatermark) return afterWatermark;

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
      market,
      handicap: market === "hhad" ? prediction.handicap : null,
      capturedAt,
      sourceUpdatedAt: dataStore.getSourceUpdatedAt(),
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
      reliabilityLevel: challengerConfig.stale
        ? "cautious"
        : prediction.reliability.level,
      reliabilityLabel: challengerConfig.stale
        ? "规则待验证"
        : prediction.reliability.label,
      reliabilityReason: challengerConfig.stale
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
        ledgerValidationPending: Boolean(challengerConfig.stale),
      },
    })
      ? 1
      : 0;
  }
  return inserted;
}

function settlePredictionLedger() {
  const context = ledgerHistoryContext();
  const pending = predictionLedger.pending();
  const settledAt = new Date().toISOString();
  let settled = 0;
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
    const topLabels = JSON.parse(snapshot.top_labels_json || "[]");
    predictionLedger.settle(snapshot.id, {
      actualResult,
      score: result.score,
      correct: topLabels.includes(actualResult),
      selectedOdds: snapshot.selected_odds,
      sourceFile: resultReference.source,
      sourceRow: resultReference.row,
      settledAt,
    });
    settled += 1;
  }
  return settled;
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
        ...movementOptions("spf"),
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
  return {
    prediction: attachChallenger(prediction, "spf", challenger),
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
        ...movementOptions("hhad"),
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
  return {
    handicap,
    prediction: attachChallenger(prediction, "hhad", challenger),
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
  if (mode === "joint") return "胜平负＋让球联合匹配";
  if (mode === "standalone-fallback") {
    return `${market === "spf" ? "胜平负" : "让球"}单盘口回退`;
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
  return { spfResult, hhadResult };
}

function marketCandidate(match, market, prediction, handicap = null) {
  if (!prediction.available || !prediction.predicted || prediction.isTie) return null;
  const index = prediction.labels.indexOf(prediction.predicted);
  const source = market === "hhad" ? match.hhad : match.had;
  const odds = [source.h, source.d, source.a][index];
  const probability = prediction.final[index];
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
    odds,
    valueIndex: probability * odds,
    samples: prediction.stats.total,
    matchingMode: prediction.matchingMode || "standalone",
    matchingLabel:
      prediction.matchingLabel ||
      (market === "hhad" ? "让球单盘口匹配" : "胜平负单盘口匹配"),
    movement: prediction.movement,
    reliability: prediction.reliability || null,
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
    { sameLeague },
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
      distance: (left, right) => goalDistance(left.odds, right.odds),
      threshold: effectiveTolerance,
    },
  );
  const movementSimilar = findSimilarGoalMovements(
    similar,
    initialOdds,
    odds,
    { finalTolerance: effectiveTolerance },
  );
  const base = predictGoalsWithMovement(
    odds,
    similar,
    movementSimilar,
    initialOdds,
    {
      ...movementOptions("goals"),
      blendOptions: blendOptions(
        model,
        smoothingOptions("goals", prior, model.usesRecommendedThreshold),
      ),
    },
  );
  const predictionWithChallenger = attachChallenger(
    base,
    "goals",
    challenger,
  );
  const prediction = {
    ...predictionWithChallenger,
    goalPair: selectTopGoalPair(predictionWithChallenger.final, odds),
  };
  const stability = buildGoalStability(history, odds, match.league);
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
    scope,
    tolerance: effectiveTolerance,
    prediction,
  } = result;
  const pair = prediction.goalPair;
  if (!prediction.available || !pair.available) return null;
  const stability = buildGoalPairStability(
    history,
    odds,
    match.league,
  );
  const notices = [];
  if (
    Math.abs(
      goalTolerance -
        Number(goalPairSelectionConfig.settings?.goalTolerance || 0),
    ) > 1e-9
  ) {
    notices.push("当前使用的是自定义进球相似阈值");
  }
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
    marketProbability: pair.indices.reduce(
      (total, index) => total + prediction.market[index],
      0,
    ),
    odds: pair.odds,
    valueIndex: expectedReturn / pair.stakeUnits,
    samples: prediction.stats.total,
    sampleScope: sameLeague ? "同联赛" : "全部联赛",
    movement: prediction.movement,
    stability,
    eligible: true,
    eligibilityReason: notices.length
      ? `按相似历史占比选择前两名；${notices.join("；")}`
      : "按相似历史占比选择前两名；四档阈值结果稳定",
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
  const targetOdds = numberParam(url.searchParams, "targetOdds", 1.8, 1, 100);
  const minLegOdds = numberParam(
    url.searchParams,
    "minLegOdds",
    1.7,
    1.7,
    20,
  );
  const limit = numberParam(url.searchParams, "limit", 20, 1, 50);
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
  const requestedSort = url.searchParams.get("sort") || "value";
  const sort = ["value", "probability", "target"].includes(requestedSort)
    ? requestedSort
    : "value";
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
  const allLeagueMarketHistory = sameLeague
    ? null
    : {
        spfHistory: dataStore.getSpfHistory(),
        hhadHistory: dataStore.getHhadHistory(),
        pairedHistory: dataStore.getPairedSpfHhadHistory(),
        goalHistory: dataStore.getGoalHistory(),
      };
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
      const marketHistory = sameLeague
        ? {
            spfHistory: dataStore.getSpfHistory({
              league: match.league,
              sameLeague: true,
            }),
            hhadHistory: dataStore.getHhadHistory({
              league: match.league,
              sameLeague: true,
            }),
            pairedHistory: dataStore.getPairedSpfHhadHistory({
              league: match.league,
              sameLeague: true,
            }),
            goalHistory: dataStore.getGoalHistory({
              league: match.league,
              sameLeague: true,
            }),
          }
        : allLeagueMarketHistory;
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
          .slice(0, 2)
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
          sort,
          limit,
        })
      : generateParlayCombinations(selectedCandidates, {
          legs,
          targetOdds,
          minLegOdds,
          sort,
          limit,
        });

  return {
    mode,
    candidates,
    combinations,
    selectedCount: selectedCandidates.length,
    goalPairPolicy: goalPairSelectionConfig,
    requestSettings: {
      mode,
      legs: mode === "goalsPair" ? 2 : legs,
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
            tolerance: `${sameLeague ? "同联赛" : "全部联赛"} · 进球距离 ${(goalTolerance * 100).toFixed(1)}pp / 历史占比前两名`,
            probability:
              "默认按单场双选覆盖率选两场；不设置最低组合赔率；两场均覆盖概率仅展示；后台按4注核算",
            value:
              "回报指数 = 四种结果的概率加权预期返还 ÷ 4注成本，1.00 为理论盈亏平衡线",
          }
        : {
            scope: sameLeague ? "只看同联赛" : "全部联赛",
            tolerance: `${sameLeague ? "同联赛" : "全部联赛"} · 胜平负 ±${(spfTolerance * 100).toFixed(0)}% / 让球 ±${(hhadTolerance * 100).toFixed(0)}%`,
            probability:
              `每关赔率不低于 ${minLegOdds.toFixed(2)}；组合命中率为各场验证后历史预测概率的乘积，按场次相互独立估算`,
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
    sourceUpdatedAt: dataStore.getSourceUpdatedAt(),
    historySourceFile: context.source,
    historyRowWatermark: context.watermark,
    legs: combination.legs.map((leg) =>
      parlaySnapshotLeg(leg, payload.mode, context),
    ),
    settings: {
      ...payload.requestSettings,
      ledgerValidationPending: Boolean(challengerConfig.stale),
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
  for (const snapshot of parlayLedger.pending()) {
    const legs = JSON.parse(snapshot.legs_json || "[]");
    const actualResults = [];
    let ready = true;
    for (const leg of legs) {
      const result = findLedgerResult(context.history, snapshot, leg);
      if (!result) {
        ready = false;
        break;
      }
      const actualResult = ledgerActualResult(result, leg.market);
      const resultReference = ledgerResultReference(result, leg.market);
      const selection = leg.selections.find(
        (item) => String(item.label) === String(actualResult),
      );
      actualResults.push({
        matchId: leg.matchId,
        actualResult,
        score: result.score,
        correct: Boolean(selection),
        selectedOdds: selection ? Number(selection.odds) : null,
        sourceFile: resultReference.source,
        sourceRow: resultReference.row,
      });
    }
    if (!ready || actualResults.length !== legs.length) continue;
    const correct = actualResults.every((result) => result.correct);
    const simulatedReturn = correct
      ? actualResults.reduce(
          (product, result) => product * Number(result.selectedOdds),
          1,
        )
      : 0;
    parlayLedger.settle(snapshot.id, {
      correct,
      simulatedReturn,
      totalStake: Number(snapshot.total_stake),
      actualResults,
      settledAt,
    });
    settled += 1;
  }
  return settled;
}

async function handleApi(request, url, response) {
  if (url.pathname === "/api/ledger") {
    const shouldSettle = url.searchParams.get("settle") !== "false";
    const settledNow = shouldSettle ? settlePredictionLedger() : 0;
    const parlaySettledNow = shouldSettle ? settleParlayLedger() : 0;
    const singleOptions = {
      status: url.searchParams.get("singleStatus") || "all",
      market: url.searchParams.get("singleMarket") || "all",
      scope: url.searchParams.get("singleScope") || "all",
      league: url.searchParams.get("singleLeague") || "all",
      query: url.searchParams.get("singleQuery") || "",
      from: url.searchParams.get("singleFrom") || "",
      to: url.searchParams.get("singleTo") || "",
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
      page: numberParam(url.searchParams, "parlayPage", 1, 1, 100000),
      pageSize: numberParam(url.searchParams, "pageSize", 20, 5, 100),
    };
    return sendJson(response, 200, {
      ...predictionLedger.summary(singleOptions),
      parlays: parlayLedger.summary(parlayOptions),
      settledNow,
      parlaySettledNow,
      policyVersion: ledgerPolicyVersion(),
      sourceUpdatedAt: dataStore.getSourceUpdatedAt(),
      selectionPolicy: challengerConfig.selection || null,
    });
  }

  if (url.pathname === "/api/matches") {
    const matches = dataStore.getMatches();
    return sendJson(response, 200, {
      matches,
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
    return sendJson(response, 200, buildParlayPayload(url));
  }

  if (url.pathname === "/api/predict") {
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
    const spfHistory = match.had
      ? dataStore.getSpfHistory(historyOptions)
      : [];
    const hhadHistory = match.hhad
      ? dataStore.getHhadHistory(historyOptions)
      : [];
    const pairedHistory = match.had && match.hhad
      ? dataStore.getPairedSpfHhadHistory(historyOptions)
      : [];
    const goalHistory = match.goals
      ? dataStore.getGoalHistory(historyOptions)
      : [];
    const challengerHistory = sameLeague
      ? dataStore.getVerifiedHistory()
      : verifiedHistory;
    const challenger =
      match.had && match.hhad && match.goals
        ? challengerEngine?.predict(match, challengerHistory) || null
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
    const {
      spf: spfStability,
      hhad: hhadStability,
    } = buildThreeWayStability(match, {
      spfHistory,
      hhadHistory,
      pairedHistory,
      spfResult,
      hhadResult,
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

    const initialHad = match.had?.history?.initial;
    const initialHadOdds = initialHad
      ? [initialHad.h, initialHad.d, initialHad.a]
      : hadOdds;

    const payload = {
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
        spf: spfPrediction
          ? `${spfResult.matchingLabel}；三项胜平负赔率相对误差均不超过 ±${(spfResult.tolerance * 100).toFixed(0)}%；${historicalMethodText(spfPrediction, "按赔率距离加权")}；${smoothingMethodText(spfPrediction)}；${movementMethodText(spfPrediction)}`
          : "竞彩未开售普通胜平负，本场不生成该玩法预测",
        hhad: hhadResult
          ? `${hhadResult.matchingLabel}；让球数 ${hhadResult.handicap > 0 ? "+" : ""}${hhadResult.handicap}，三项让球赔率误差均不超过 ±${(hhadResult.tolerance * 100).toFixed(0)}%；${historicalMethodText(hhadResult.prediction, "按赔率距离加权")}；${smoothingMethodText(hhadResult.prediction)}；${movementMethodText(hhadResult.prediction)}`
          : "缺少让球胜平负赔率",
        goals: !goalResult
          ? "缺少总进球赔率"
          : goalScope.zeroOdds
            ? `总进球独立匹配；${zeroOddsMethodText(goalScope, goalPrediction)}；${smoothingMethodText(goalPrediction)}；${movementMethodText(goalPrediction)}`
            : `总进球独立匹配；八档最新去水概率每一档差值均不超过 ${(effectiveGoalTolerance * 100).toFixed(1)} 个百分点；${historicalMethodText(goalPrediction, "按概率距离加权")}；${smoothingMethodText(goalPrediction)}；${movementMethodText(goalPrediction)}`,
      },
      dataStats: {
        ...dataStore.getCounts(),
        currentSpfHistory: spfHistory.length,
        currentHhadHistory: hhadHistory.length,
        currentGoalHistory: goalHistory.length,
      },
    };
    const ledgerSnapshotInserted = recordPredictionPayload(payload);
    return sendJson(response, 200, {
      ...payload,
      ledgerSnapshotInserted,
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
    console.error(error);
    sendJson(response, 500, { error: "服务处理失败", detail: error.message });
  }
});

let lastLedgerSourceUpdatedAt = null;
let ledgerRefreshPromise = null;

function refreshCurrentLedger({ force = false } = {}) {
  const sourceUpdatedAt = dataStore.getSourceUpdatedAt();
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

server.listen(PORT, () => {
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

const ledgerRefreshTimer = setInterval(() => {
  refreshCurrentLedger().catch((error) => {
    console.error(`赛前账本自动更新失败：${error.message}`);
  });
}, 10_000);
ledgerRefreshTimer.unref();

async function snapshotCurrentMatches() {
  let inserted = 0;
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
        `http://127.0.0.1:${PORT}/api/predict?${params}`,
      );
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`${match.displayName}: ${response.status} ${detail}`);
      }
      const payload = await response.json();
      inserted += Number(payload.ledgerSnapshotInserted || 0);
    }
  }
  const settled = settlePredictionLedger();
  console.log(
    `赛前账本：检查 ${eligible} 场 × 2种口径，新增或更新 ${inserted} 条，结算 ${settled} 条`,
  );
}

function shutdown() {
  clearInterval(ledgerRefreshTimer);
  server.close(() => {
    predictionLedger.close();
    dataStore.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
