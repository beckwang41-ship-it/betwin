function emptyCounts(labels) {
  return Object.fromEntries(labels.map((label) => [label, 0]));
}

function countOutcomes(rows, labels, outcomeField) {
  const counts = emptyCounts(labels);
  for (const row of rows) {
    const label = String(row?.[outcomeField] ?? "");
    if (label in counts) counts[label] += 1;
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    counts,
    total,
    probabilities: labels.map((label) =>
      total ? counts[label] / total : 1 / labels.length,
    ),
  };
}

function sourceLabel(source) {
  return {
    "same-league-nearby": "同联赛宽赔率带",
    "all-leagues-nearby": "全联赛宽赔率带",
    "same-league-all": "同联赛全部历史",
    "all-history": "全部历史基础分布",
    "adjusted-market": "当前让球赔率去水概率",
    uniform: "均匀先验",
  }[source] || source;
}

export function adjustedThreeWayProbabilities(odds, market) {
  if (
    !Array.isArray(odds) ||
    odds.length !== 3 ||
    odds.some((odd) => !Number.isFinite(Number(odd)) || Number(odd) <= 0)
  ) {
    return null;
  }
  const bases = market === "spf" ? [0.862, 0.899, 0.88] : [0.89, 0.89, 0.89];
  const raw = odds.map((odd, index) => {
    const value = Number(odd);
    let rtp = bases[index];
    if (value > 4.5) rtp = market === "spf" ? 0.815 : 0.84;
    else if (value < 1.5) rtp = market === "spf" ? 0.902 : 0.9;
    return rtp / value;
  });
  const total = raw.reduce((sum, value) => sum + value, 0);
  return total > 0 ? raw.map((value) => value / total) : null;
}

export function adjustedThreeWayMarketPrior(odds, market) {
  const probabilities = adjustedThreeWayProbabilities(odds, market);
  if (!probabilities) return null;
  return {
    source: "adjusted-market",
    sourceLabel: sourceLabel("adjusted-market"),
    sampleSize: 0,
    counts: null,
    probabilities,
    relaxedTolerance: null,
    minLocalizedSamples: null,
  };
}

export function selectHistoricalPrior(
  history,
  target,
  {
    labels,
    outcomeField,
    distance,
    compatible = () => true,
    relaxedTolerance,
    minLocalizedSamples = 30,
  },
) {
  const valid = history.filter(
    (row) =>
      compatible(row, target) &&
      labels.includes(String(row?.[outcomeField] ?? "")),
  );
  const nearby = valid.filter(
    (row) => distance(row, target) <= relaxedTolerance,
  );
  const sameLeague = valid.filter(
    (row) => row.league && row.league === target.league,
  );
  const sameLeagueNearby = nearby.filter(
    (row) => row.league && row.league === target.league,
  );
  const minimum = Math.max(1, Math.trunc(minLocalizedSamples));

  let rows = valid;
  let source = "all-history";
  if (sameLeagueNearby.length >= minimum) {
    rows = sameLeagueNearby;
    source = "same-league-nearby";
  } else if (nearby.length >= minimum) {
    rows = nearby;
    source = "all-leagues-nearby";
  } else if (sameLeague.length >= minimum) {
    rows = sameLeague;
    source = "same-league-all";
  }

  if (!rows.length) {
    return {
      source: "uniform",
      sourceLabel: sourceLabel("uniform"),
      sampleSize: 0,
      counts: emptyCounts(labels),
      probabilities: labels.map(() => 1 / labels.length),
      relaxedTolerance,
      minLocalizedSamples: minimum,
    };
  }

  const stats = countOutcomes(rows, labels, outcomeField);
  return {
    source,
    sourceLabel: sourceLabel(source),
    sampleSize: stats.total,
    counts: stats.counts,
    probabilities: stats.probabilities,
    relaxedTolerance,
    minLocalizedSamples: minimum,
  };
}

// 对称加性防零：p_i = (c_i + a) / (n + k*a)。
//
// 为什么无条件生效、不需要门禁批准：
// 分母对所有分量相同、分子加同一常数，所以这是各分量的同一个单调仿射
// 变换，完全保留 argmax 与并列结构（穷举 12340 组 + 随机 20 万组验证，
// 见 scripts/test_jeffreys_argmax.mjs）。它不改变「该押哪一边」，
// 只修正「零样本格被报成 0%」这一确定性错误。
//
// 为什么必须修：实测验证段中模型报 0% 的格子真实发生率
// 14.6%（胜平负）/ 17.6%（让球），n<=3 档 98% 的场次含零格。
// 高概率档因此虚高 12.71pp（宣称 86.62% / 实际 73.91%）。
// 防零把虚高压到 2.44pp，命中率一位不变（50.20% → 50.20%），
// argmax 变动 0 场。见 scripts/test_prior_floor.mjs。
//
// 为什么用「总先验质量」而不是固定 alpha：
// 固定 alpha=0.5（Jeffreys）时先验总质量是 k*alpha，随分类数线性增长。
// 3 分类 n=2 时先验占 42.9%，但 8 分类 n=2 时占到 66.7%，样本被完全
// 压制。改为固定总质量 priorMass（alpha = priorMass/k）后，收缩强度
// 只由样本量决定，与分类数解耦：默认 m=1.5 时，n=2 两者都是42.9%，
// n=15 都是9.1%。
// 默认总先验质量 1.5：三分类下精确等价经典 Jeffreys（alpha=0.5），
// 八分类下 alpha=0.1875，n=2 时先验占 42.9%（固定 alpha=0.5 会占到 66.7%）。
export const DEFAULT_ZERO_CELL_PRIOR_MASS = 1.5;
export const ZERO_CELL_FLOOR_VERSION =
  `zero-floor-m${DEFAULT_ZERO_CELL_PRIOR_MASS}`;

export function applyZeroCellFloor(
  counts,
  {
    priorMass = DEFAULT_ZERO_CELL_PRIOR_MASS,
    alpha = null,
    labelCount = null,
  } = {},
) {
  const safeCounts = (Array.isArray(counts) ? counts : []).map((count) =>
    Math.max(0, Number(count) || 0),
  );
  const size = Number(labelCount) > 0 ? Number(labelCount) : safeCounts.length;
  const total = safeCounts.reduce((sum, count) => sum + count, 0);
  if (!size) {
    return { applied: false, alpha: 0, priorMass: 0, sampleSize: total, probabilities: [] };
  }
  // 显式 alpha 优先（便于诊断脚本复现经典 Jeffreys），否则由总质量推导。
  const safeAlpha =
    alpha === null || alpha === undefined
      ? Math.max(0, Number(priorMass) || 0) / size
      : Math.max(0, Number(alpha) || 0);
  const effectiveMass = safeAlpha * size;
  if (!total) {
    return {
      applied: false,
      alpha: safeAlpha,
      priorMass: effectiveMass,
      sampleSize: 0,
      probabilities: safeCounts.map(() => 1 / size),
    };
  }
  if (!safeAlpha) {
    return {
      applied: false,
      alpha: 0,
      priorMass: 0,
      sampleSize: total,
      probabilities: safeCounts.map((count) => count / total),
    };
  }
  const denominator = total + effectiveMass;
  return {
    applied: true,
    alpha: safeAlpha,
    priorMass: effectiveMass,
    priorShare: effectiveMass / denominator,
    sampleSize: total,
    zeroCells: safeCounts.filter((count) => count === 0).length,
    probabilities: safeCounts.map((count) => (count + safeAlpha) / denominator),
  };
}

export function smoothHistoricalDistribution(
  empirical,
  sampleSize,
  {
    enabled = false,
    strength = 0,
    strengthMode = "fixed",
    dynamicNumerator = 20,
    minStrength = 1,
    maxStrength = 20,
    prior = null,
    validated = false,
    reason = "",
  } = {},
) {
  const safeSampleSize = Math.max(0, Number(sampleSize) || 0);
  const configuredStrength = Math.max(0, Number(strength) || 0);
  const safeMinimum = Math.max(0, Number(minStrength) || 0);
  const safeMaximum = Math.max(safeMinimum, Number(maxStrength) || 0);
  const safeStrength =
    strengthMode === "inverse-samples" && safeSampleSize > 0
      ? Math.max(
          safeMinimum,
          Math.min(
            safeMaximum,
            Math.max(0, Number(dynamicNumerator) || 0) / safeSampleSize,
          ),
        )
      : configuredStrength;
  const fallback = empirical.map(() => 1 / Math.max(1, empirical.length));
  const priorProbabilities =
    Array.isArray(prior?.probabilities) &&
    prior.probabilities.length === empirical.length
      ? prior.probabilities
      : fallback;
  const priorTotal = priorProbabilities.reduce(
    (sum, value) => sum + Math.max(0, Number(value) || 0),
    0,
  );
  const normalizedPrior = priorProbabilities.map((value) =>
    priorTotal ? Math.max(0, Number(value) || 0) / priorTotal : 1 / empirical.length,
  );
  const stable =
    safeSampleSize > 0 && safeStrength > 0
      ? empirical.map(
          (value, index) =>
            (safeSampleSize * value +
              safeStrength * normalizedPrior[index]) /
            (safeSampleSize + safeStrength),
        )
      : [...empirical];
  const applied = Boolean(enabled && safeSampleSize > 0 && safeStrength > 0);

  return {
    applied,
    referenceOnly: !applied && safeSampleSize > 0 && safeStrength > 0,
    validated: Boolean(validated),
    strength: safeStrength,
    strengthMode,
    configuredStrength,
    prior: {
      source: prior?.source || "uniform",
      sourceLabel: prior?.sourceLabel || sourceLabel("uniform"),
      sampleSize: Number(prior?.sampleSize || 0),
      counts: prior?.counts || null,
      probabilities: normalizedPrior,
      relaxedTolerance: prior?.relaxedTolerance ?? null,
      minLocalizedSamples: prior?.minLocalizedSamples ?? null,
    },
    probabilities: stable,
    adjustment: stable.map((value, index) => value - empirical[index]),
    reason,
  };
}
