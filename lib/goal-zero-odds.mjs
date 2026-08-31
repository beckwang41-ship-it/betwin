import { GOAL_LABELS, goalDistance, normalizeOdds } from "./predictor.mjs";

export const GOAL_MATCHING_VERSION = "goal-zero-composite-v1";

export const GOAL_ZERO_BANDS = [
  { id: "g0-1", lower: null, upper: 10.25, label: "≤10.00" },
  { id: "g0-2", lower: 10.25, upper: 22.75, label: "10.50～22.50" },
  { id: "g0-3", lower: 22.75, upper: 25.75, label: "23.00～25.50" },
  { id: "g0-4", lower: 25.75, upper: 32.5, label: "26.00～32.00" },
  { id: "g0-5", lower: 32.5, upper: null, label: "≥33.00" },
];

// 参考 n52goalfx.py 的“先筛0球赔率、再比较整组曲线”思路，并按本项目
// 历史数据独立验证门槛。固定分段只保留作历史统计元数据，不能再被
// 当作“相似赔率”的范围。
export const GOAL_ZERO_ODDS_TOLERANCE = 2;
export const SAME_LEAGUE_GOAL_ZERO_ODDS_TOLERANCE = 2.5;

const GOAL_DISTANCE_WEIGHTS = {
  final: 0.6,
  initial: 0.15,
  movement: 0.15,
  expectedGoals: 0.1,
};

function validEightOdds(odds) {
  return (
    Array.isArray(odds) &&
    odds.length === 8 &&
    odds.every((value) => Number.isFinite(Number(value)) && Number(value) > 1)
  );
}

function l1Distance(left, right) {
  return left.reduce(
    (sum, value, index) => sum + Math.abs(value - right[index]),
    0,
  );
}

function impliedExpectedGoals(probabilities) {
  return probabilities.reduce(
    (sum, probability, index) =>
      sum + probability * (index === 7 ? 7.5 : index),
    0,
  );
}

export function compositeGoalDistance(
  historyOdds,
  targetOdds,
  { historyInitialOdds = null, targetInitialOdds = null } = {},
) {
  if (!validEightOdds(historyOdds) || !validEightOdds(targetOdds)) {
    return null;
  }
  const historyFinal = normalizeOdds(historyOdds);
  const targetFinal = normalizeOdds(targetOdds);
  const historyInitial = validEightOdds(historyInitialOdds)
    ? normalizeOdds(historyInitialOdds)
    : historyFinal;
  const targetInitial = validEightOdds(targetInitialOdds)
    ? normalizeOdds(targetInitialOdds)
    : targetFinal;
  const historyMovement = historyFinal.map(
    (value, index) => value - historyInitial[index],
  );
  const targetMovement = targetFinal.map(
    (value, index) => value - targetInitial[index],
  );
  const components = {
    final: l1Distance(historyFinal, targetFinal) / 2,
    initial: l1Distance(historyInitial, targetInitial) / 2,
    movement: l1Distance(historyMovement, targetMovement) / 2,
    expectedGoals: Math.min(
      1,
      Math.abs(
        impliedExpectedGoals(historyFinal) - impliedExpectedGoals(targetFinal),
      ) / 2,
    ),
  };
  return {
    distance: Object.entries(GOAL_DISTANCE_WEIGHTS).reduce(
      (sum, [key, weight]) => sum + components[key] * weight,
      0,
    ),
    components,
    weights: GOAL_DISTANCE_WEIGHTS,
  };
}

function labelIndex(value) {
  return GOAL_LABELS.indexOf(String(value));
}

function emptyCounts() {
  return GOAL_LABELS.map(() => 0);
}

function addCounts(left, right) {
  return left.map((value, index) => value + right[index]);
}

function subtractCounts(left, right) {
  return left.map((value, index) => value - right[index]);
}

function total(counts) {
  return counts.reduce((sum, value) => sum + value, 0);
}

function entropyCost(counts) {
  const samples = total(counts);
  if (!samples) return Number.POSITIVE_INFINITY;
  return counts.reduce((cost, count) => {
    if (!count) return cost;
    const probability = count / samples;
    return cost - count * Math.log(probability);
  }, 0);
}

function aggregatePrices(rows) {
  const byPrice = new Map();
  for (const row of rows) {
    const price = Number(row.odds?.[0]);
    const index = labelIndex(row.goals);
    if (!Number.isFinite(price) || price <= 1 || index < 0) continue;
    if (!byPrice.has(price)) byPrice.set(price, emptyCounts());
    byPrice.get(price)[index] += 1;
  }
  return [...byPrice.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([price, counts]) => ({ price, counts, samples: total(counts) }));
}

function prefixCounts(points) {
  const prefix = [emptyCounts()];
  for (const point of points) {
    prefix.push(addCounts(prefix.at(-1), point.counts));
  }
  return prefix;
}

function segmentCounts(prefix, start, end) {
  return subtractCounts(prefix[end], prefix[start]);
}

function fitForLeaves(points, leaves, minLeaf) {
  const size = points.length;
  const prefix = prefixCounts(points);
  const costs = Array.from({ length: leaves + 1 }, () =>
    Array(size + 1).fill(Number.POSITIVE_INFINITY),
  );
  const previous = Array.from({ length: leaves + 1 }, () =>
    Array(size + 1).fill(-1),
  );
  costs[0][0] = 0;
  for (let leaf = 1; leaf <= leaves; leaf += 1) {
    for (let end = 1; end <= size; end += 1) {
      for (let start = leaf - 1; start < end; start += 1) {
        if (!Number.isFinite(costs[leaf - 1][start])) continue;
        const counts = segmentCounts(prefix, start, end);
        if (total(counts) < minLeaf) continue;
        const cost = costs[leaf - 1][start] + entropyCost(counts);
        if (cost < costs[leaf][end]) {
          costs[leaf][end] = cost;
          previous[leaf][end] = start;
        }
      }
    }
  }
  if (!Number.isFinite(costs[leaves][size])) return null;
  const ranges = [];
  let end = size;
  for (let leaf = leaves; leaf > 0; leaf -= 1) {
    const start = previous[leaf][end];
    ranges.unshift({ start, end });
    end = start;
  }
  return { cost: costs[leaves][size], ranges };
}

export function learnZeroOddsIntervals(
  rows,
  { minLeaf = 300, maxLeaves = 6 } = {},
) {
  const points = aggregatePrices(rows);
  if (points.length < 2) throw new Error("0球赔率取值不足，无法学习区间");
  const sampleSize = points.reduce((sum, point) => sum + point.samples, 0);
  let best = null;
  for (let leaves = 2; leaves <= maxLeaves; leaves += 1) {
    const fit = fitForLeaves(points, leaves, minLeaf);
    if (!fit) continue;
    const parameters = leaves * (GOAL_LABELS.length - 1) + (leaves - 1);
    const bic = 2 * fit.cost + parameters * Math.log(sampleSize);
    if (!best || bic < best.bic) best = { ...fit, leaves, bic };
  }
  if (!best) throw new Error("最低样本限制过高，无法生成0球赔率区间");
  const intervals = best.ranges.map(({ start, end }, index) => {
    const slice = points.slice(start, end);
    const counts = slice.reduce(
      (value, point) => addCounts(value, point.counts),
      emptyCounts(),
    );
    const observedMin = slice[0].price;
    const observedMax = slice.at(-1).price;
    const lower = index === 0
      ? null
      : (points[start - 1].price + points[start].price) / 2;
    const upper = index === best.ranges.length - 1
      ? null
      : (points[end - 1].price + points[end].price) / 2;
    return {
      id: `g0-${index + 1}`,
      lower,
      upper,
      observedMin,
      observedMax,
      scale: Math.max(0.01, observedMax - observedMin),
      samples: total(counts),
      counts: Object.fromEntries(
        GOAL_LABELS.map((label, labelIndex) => [label, counts[labelIndex]]),
      ),
      probabilities: Object.fromEntries(
        GOAL_LABELS.map((label, labelIndex) => [
          label,
          counts[labelIndex] / total(counts),
        ]),
      ),
    };
  });
  return {
    method: "multinomial-bic-segmentation",
    samples: sampleSize,
    uniquePrices: points.length,
    leaves: best.leaves,
    minLeaf,
    bic: best.bic,
    intervals,
  };
}

export function findZeroOddsInterval(intervals, price) {
  const value = Number(price);
  return intervals.find(
    (interval) =>
      (interval.lower === null || value >= interval.lower) &&
      (interval.upper === null || value < interval.upper),
  ) || null;
}

export function zeroOddsDistance(price, targetPrice, interval) {
  return Math.abs(Number(price) - Number(targetPrice)) / interval.scale;
}

export function remainingGoalDistance(historyOdds, targetOdds) {
  const history = normalizeOdds(historyOdds);
  const target = normalizeOdds(targetOdds);
  return Math.max(
    ...history.slice(1).map((value, index) =>
      Math.abs(value - target[index + 1]),
    ),
  );
}

export function findSimilarByGoalBand(
  history,
  targetOdds,
  {
    intervals = GOAL_ZERO_BANDS,
    policies = {},
    zeroOddsTolerance = null,
    targetInitialOdds = null,
    league = "",
    sameLeague = false,
  } = {},
) {
  const targetZeroOdds = Number(targetOdds?.[0]);
  const tolerance = Number(
    zeroOddsTolerance ??
      (sameLeague
        ? SAME_LEAGUE_GOAL_ZERO_ODDS_TOLERANCE
        : GOAL_ZERO_ODDS_TOLERANCE),
  );
  const interval = findZeroOddsInterval(intervals, targetZeroOdds);
  if (
    !interval ||
    !Number.isFinite(targetZeroOdds) ||
    !Number.isFinite(tolerance) ||
    tolerance < 0
  ) {
    return {
      interval: null,
      policy: null,
      zeroOddsWindow: null,
      similar: [],
    };
  }
  const policy = {
    ...(policies[interval.id] || {}),
    enabled: true,
    threshold: null,
    gate: {
      ...(policies[interval.id]?.gate || {}),
      passed: true,
      reason:
        `0球赔率统一±${tolerance.toFixed(2)}后，使用终赔、初赔、走势和隐含进球综合距离`,
    },
  };
  const zeroOddsWindow = {
    target: targetZeroOdds,
    tolerance,
    lower: targetZeroOdds - tolerance,
    upper: targetZeroOdds + tolerance,
    label: `${(targetZeroOdds - tolerance).toFixed(2)}～${(targetZeroOdds + tolerance).toFixed(2)}`,
  };
  const similar = history
    .filter((row) => !sameLeague || row.league === league)
    .filter(
      (row) =>
        Number.isFinite(Number(row.odds?.[0])) &&
        Math.abs(Number(row.odds[0]) - targetZeroOdds) <= tolerance,
    )
    .map((row) => {
      const composite = compositeGoalDistance(row.odds, targetOdds, {
        historyInitialOdds: row.initialOdds,
        targetInitialOdds,
      });
      return composite
        ? {
            ...row,
            distance: composite.distance,
            distanceComponents: composite.components,
            zeroOddsDistance: Math.abs(Number(row.odds[0]) - targetZeroOdds),
          }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.distance - right.distance);
  const positiveDistances = similar
    .map((row) => row.distance)
    .filter((distance) => Number.isFinite(distance) && distance > 1e-9)
    .sort((left, right) => left - right);
  const bandwidth = positiveDistances.length
    ? positiveDistances[Math.floor(positiveDistances.length / 2)]
    : 0.01;
  const weighted = similar.map((row) => ({
    ...row,
    similarityWeight: Math.exp(
      -row.distance / Math.max(0.005, bandwidth),
    ),
  }));
  return {
    interval,
    policy,
    zeroOddsWindow,
    similar: weighted,
    weighting: {
      method: "exponential-composite-distance",
      bandwidth,
      usesAllSamples: true,
      sampleLimit: null,
    },
  };
}

export function findSimilarByZeroOdds(
  history,
  targetOdds,
  { intervals, radius, league = "", sameLeague = false } = {},
) {
  const targetPrice = Number(targetOdds?.[0]);
  const interval = findZeroOddsInterval(intervals || [], targetPrice);
  if (!interval) return { interval: null, similar: [] };
  const similar = history
    .filter((row) => !sameLeague || row.league === league)
    .filter((row) => {
      const price = Number(row.odds?.[0]);
      return findZeroOddsInterval(intervals, price)?.id === interval.id;
    })
    .map((row) => ({
      ...row,
      distance: zeroOddsDistance(row.odds[0], targetPrice, interval),
    }))
    .filter((row) => row.distance <= Number(radius))
    .sort((left, right) => left.distance - right.distance);
  return { interval, similar };
}

function accumulator() {
  return {
    targets: 0,
    evaluated: 0,
    exact: 0,
    topTwo: 0,
    logLoss: 0,
    brier: 0,
    samples: [],
  };
}

function probabilities(counts) {
  const samples = total(counts);
  return samples ? counts.map((count) => count / samples) : null;
}

function addCase(value, distribution, actualIndex, samples) {
  value.targets += 1;
  if (!distribution) return;
  value.evaluated += 1;
  value.samples.push(samples);
  const ranked = distribution
    .map((probability, index) => ({ probability, index }))
    .sort((left, right) => right.probability - left.probability || left.index - right.index);
  if (ranked[0].index === actualIndex) value.exact += 1;
  if (ranked.slice(0, 2).some(({ index }) => index === actualIndex)) {
    value.topTwo += 1;
  }
  value.logLoss -= Math.log(Math.max(1e-12, distribution[actualIndex]));
  value.brier += distribution.reduce((sum, probability, index) => {
    const actual = index === actualIndex ? 1 : 0;
    return sum + (probability - actual) ** 2;
  }, 0);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function summarize(value) {
  return {
    targets: value.targets,
    evaluated: value.evaluated,
    coverage: value.targets ? value.evaluated / value.targets : 0,
    accuracy: value.evaluated ? value.exact / value.evaluated : 0,
    topTwoCoverage: value.evaluated ? value.topTwo / value.evaluated : 0,
    logLoss: value.evaluated ? value.logLoss / value.evaluated : 0,
    brier: value.evaluated ? value.brier / value.evaluated : 0,
    medianSamples: median(value.samples),
  };
}

function compare(candidate, baseline) {
  const left = summarize(candidate);
  const right = summarize(baseline);
  return {
    candidate: left,
    baseline: right,
    delta: {
      accuracy: left.accuracy - right.accuracy,
      topTwoCoverage: left.topTwoCoverage - right.topTwoCoverage,
      logLoss: left.logLoss - right.logLoss,
      brier: left.brier - right.brier,
      coverage: left.coverage - right.coverage,
    },
  };
}

function countsFor(history, target, predicate) {
  const counts = emptyCounts();
  let samples = 0;
  for (const row of history) {
    if (!predicate(row)) continue;
    const index = labelIndex(row.goals);
    if (index < 0) continue;
    counts[index] += 1;
    samples += 1;
  }
  return { distribution: probabilities(counts), samples };
}

function selectRadius(metrics) {
  return [...metrics].sort((left, right) =>
    right.summary.topTwoCoverage - left.summary.topTwoCoverage ||
    left.summary.logLoss - right.summary.logLoss ||
    left.summary.brier - right.summary.brier ||
    left.radius - right.radius,
  )[0];
}

function evaluatePhase(
  rows,
  start,
  end,
  intervals,
  radiiByInterval,
  baselineTolerance,
  radiusCandidates = null,
) {
  const candidate = accumulator();
  const baseline = accumulator();
  const radiusMetrics = Object.fromEntries(
    intervals.map((interval) => [
      interval.id,
      (radiusCandidates || []).map((radius) => ({
        radius,
        value: accumulator(),
      })),
    ]),
  );
  for (let index = start; index < end; index += 1) {
    const target = rows[index];
    const actualIndex = labelIndex(target.goals);
    const interval = findZeroOddsInterval(intervals, target.odds[0]);
    if (actualIndex < 0 || !interval) continue;
    const history = rows.slice(0, index);
    const baselineResult = countsFor(
      history,
      target,
      (row) => goalDistance(row.odds, target.odds) <= baselineTolerance,
    );
    const baselineForCase = baselineResult.distribution;
    const radius = radiiByInterval?.[interval.id];
    if (radius !== undefined) {
      const result = countsFor(
        history,
        target,
        (row) =>
          findZeroOddsInterval(intervals, row.odds[0])?.id === interval.id &&
          zeroOddsDistance(row.odds[0], target.odds[0], interval) <= radius,
      );
      addCase(candidate, result.distribution, actualIndex, result.samples);
      addCase(baseline, baselineForCase, actualIndex, baselineResult.samples);
    }
    for (const metric of radiusMetrics[interval.id]) {
      const result = countsFor(
        history,
        target,
        (row) =>
          findZeroOddsInterval(intervals, row.odds[0])?.id === interval.id &&
          zeroOddsDistance(row.odds[0], target.odds[0], interval) <= metric.radius,
      );
      addCase(metric.value, result.distribution, actualIndex, result.samples);
    }
  }
  return {
    comparison: radiiByInterval ? compare(candidate, baseline) : null,
    radiusMetrics: Object.fromEntries(
      Object.entries(radiusMetrics).map(([id, metrics]) => [
        id,
        metrics.map(({ radius, value }) => ({ radius, summary: summarize(value) })),
      ]),
    ),
  };
}

export function tuneZeroOddsModel(
  rows,
  {
    trainFraction = 0.6,
    tuningFraction = 0.2,
    minLeaf = 300,
    maxLeaves = 6,
    radii = [0.1, 0.2, 0.35, 0.5, 0.75, 1],
    baselineTolerance = 0.02,
  } = {},
) {
  const ordered = [...rows].sort((left, right) => left.sourceRow - right.sourceRow);
  const trainEnd = Math.floor(ordered.length * trainFraction);
  const tuningEnd = Math.floor(ordered.length * (trainFraction + tuningFraction));
  const learned = learnZeroOddsIntervals(ordered.slice(0, trainEnd), {
    minLeaf,
    maxLeaves,
  });
  const tuningRadii = evaluatePhase(
    ordered,
    trainEnd,
    tuningEnd,
    learned.intervals,
    null,
    baselineTolerance,
    radii,
  ).radiusMetrics;
  const radiiByInterval = Object.fromEntries(
    Object.entries(tuningRadii).map(([id, metrics]) => [id, selectRadius(metrics).radius]),
  );
  const tuning = evaluatePhase(
    ordered,
    trainEnd,
    tuningEnd,
    learned.intervals,
    radiiByInterval,
    baselineTolerance,
  ).comparison;
  const validation = evaluatePhase(
    ordered,
    tuningEnd,
    ordered.length,
    learned.intervals,
    radiiByInterval,
    baselineTolerance,
  ).comparison;
  const passes = (comparison) =>
    comparison.candidate.coverage >= comparison.baseline.coverage * 0.98 &&
    comparison.delta.topTwoCoverage > 0 &&
    comparison.delta.logLoss < 0 &&
    comparison.delta.brier < 0;
  const enabled = passes(tuning) && passes(validation);
  return {
    enabled,
    baselineTolerance,
    splits: { trainEnd, tuningEnd, validationEnd: ordered.length },
    learned,
    radii,
    radiiByInterval,
    tuningRadii,
    tuning,
    validation,
    gate: {
      passed: enabled,
      tuningPassed: passes(tuning),
      validationPassed: passes(validation),
      reason: enabled
        ? "0球赔率区间模型在中间20%和最新20%均优于八档逐档基准"
        : !passes(tuning)
          ? "0球赔率区间模型未通过中间20%调参段"
          : "中间20%选出的0球赔率区间距离未通过最新20%验证",
    },
  };
}

function fixedBandIntervals(rows, bands = GOAL_ZERO_BANDS) {
  return bands.map((band) => {
    const matching = rows.filter(
      (row) => findZeroOddsInterval(bands, row.odds?.[0])?.id === band.id,
    );
    const counts = emptyCounts();
    for (const row of matching) {
      const index = labelIndex(row.goals);
      if (index >= 0) counts[index] += 1;
    }
    const prices = matching.map((row) => Number(row.odds[0]));
    const samples = total(counts);
    return {
      ...band,
      observedMin: prices.length ? Math.min(...prices) : null,
      observedMax: prices.length ? Math.max(...prices) : null,
      samples,
      counts: Object.fromEntries(
        GOAL_LABELS.map((label, index) => [label, counts[index]]),
      ),
      probabilities: Object.fromEntries(
        GOAL_LABELS.map((label, index) => [
          label,
          samples ? counts[index] / samples : 0,
        ]),
      ),
    };
  });
}

function withinZeroOddsTolerance(
  row,
  target,
  tolerance = GOAL_ZERO_ODDS_TOLERANCE,
) {
  const price = Number(row.odds?.[0]);
  const targetPrice = Number(target.odds?.[0]);
  return (
    Number.isFinite(price) &&
    Number.isFinite(targetPrice) &&
    Math.abs(price - targetPrice) <= Number(tolerance)
  );
}

function bandAccumulators(intervals, thresholds = []) {
  return Object.fromEntries(
    intervals.map((interval) => [
      interval.id,
      {
        baseline: accumulator(),
        candidates: thresholds.map((threshold) => ({
          threshold,
          value: accumulator(),
        })),
      },
    ]),
  );
}

function evaluateBandThresholds(
  rows,
  start,
  end,
  intervals,
  thresholds,
) {
  const values = bandAccumulators(intervals, thresholds);
  for (let index = start; index < end; index += 1) {
    const target = rows[index];
    const actualIndex = labelIndex(target.goals);
    const interval = findZeroOddsInterval(intervals, target.odds?.[0]);
    if (actualIndex < 0 || !interval) continue;
    const history = rows.slice(0, index);
    const baseline = countsFor(
      history,
      target,
      (row) => withinZeroOddsTolerance(row, target),
    );
    addCase(
      values[interval.id].baseline,
      baseline.distribution,
      actualIndex,
      baseline.samples,
    );
    for (const candidate of values[interval.id].candidates) {
      const result = countsFor(
        history,
        target,
        (row) =>
          withinZeroOddsTolerance(row, target) &&
          remainingGoalDistance(row.odds, target.odds) <= candidate.threshold,
      );
      addCase(
        candidate.value,
        result.distribution,
        actualIndex,
        result.samples,
      );
    }
  }
  return Object.fromEntries(
    intervals.map((interval) => [
      interval.id,
      {
        baseline: summarize(values[interval.id].baseline),
        candidates: values[interval.id].candidates.map((candidate) => ({
          threshold: candidate.threshold,
          summary: summarize(candidate.value),
        })),
      },
    ]),
  );
}

function selectBandThreshold(entry) {
  return [...entry.candidates]
    .filter(
      (candidate) =>
        candidate.summary.coverage >= entry.baseline.coverage * 0.98,
    )
    .sort(
      (left, right) =>
        right.summary.topTwoCoverage - left.summary.topTwoCoverage ||
        left.summary.logLoss - right.summary.logLoss ||
        left.threshold - right.threshold,
    )[0];
}

function evaluateBandPolicies(
  rows,
  start,
  end,
  intervals,
  policies,
  legacyTolerance,
) {
  const candidate = accumulator();
  const bandBaseline = accumulator();
  const legacy = accumulator();
  const perBand = Object.fromEntries(
    intervals.map((interval) => [
      interval.id,
      { candidate: accumulator(), baseline: accumulator() },
    ]),
  );
  for (let index = start; index < end; index += 1) {
    const target = rows[index];
    const actualIndex = labelIndex(target.goals);
    const interval = findZeroOddsInterval(intervals, target.odds?.[0]);
    if (actualIndex < 0 || !interval) continue;
    const history = rows.slice(0, index);
    const baselineResult = countsFor(
      history,
      target,
      (row) => withinZeroOddsTolerance(row, target),
    );
    const policy = policies[interval.id] || { enabled: false };
    const candidateResult = policy.enabled
      ? countsFor(
          history,
          target,
          (row) =>
            withinZeroOddsTolerance(row, target) &&
            remainingGoalDistance(row.odds, target.odds) <= policy.threshold,
        )
      : baselineResult;
    const legacyResult = countsFor(
      history,
      target,
      (row) => goalDistance(row.odds, target.odds) <= legacyTolerance,
    );
    addCase(
      candidate,
      candidateResult.distribution,
      actualIndex,
      candidateResult.samples,
    );
    addCase(
      bandBaseline,
      baselineResult.distribution,
      actualIndex,
      baselineResult.samples,
    );
    addCase(
      legacy,
      legacyResult.distribution,
      actualIndex,
      legacyResult.samples,
    );
    addCase(
      perBand[interval.id].candidate,
      candidateResult.distribution,
      actualIndex,
      candidateResult.samples,
    );
    addCase(
      perBand[interval.id].baseline,
      baselineResult.distribution,
      actualIndex,
      baselineResult.samples,
    );
  }
  return {
    candidate: summarize(candidate),
    bandBaseline: summarize(bandBaseline),
    legacy: summarize(legacy),
    perBand: Object.fromEntries(
      intervals.map((interval) => [
        interval.id,
        compare(
          perBand[interval.id].candidate,
          perBand[interval.id].baseline,
        ),
      ]),
    ),
  };
}

export function tuneGoalBandModel(
  rows,
  {
    trainFraction = 0.6,
    tuningFraction = 0.2,
    intervals = GOAL_ZERO_BANDS,
    thresholds = [0.005, 0.0075, 0.01, 0.0125, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05],
    legacyTolerance = 0.02,
  } = {},
) {
  const ordered = [...rows].sort(
    (left, right) => left.sourceRow - right.sourceRow,
  );
  const trainEnd = Math.floor(ordered.length * trainFraction);
  const tuningEnd = Math.floor(
    ordered.length * (trainFraction + tuningFraction),
  );
  const learnedIntervals = fixedBandIntervals(
    ordered.slice(0, trainEnd),
    intervals,
  );
  const tuningSearch = evaluateBandThresholds(
    ordered,
    trainEnd,
    tuningEnd,
    learnedIntervals,
    thresholds,
  );
  const selected = Object.fromEntries(
    learnedIntervals.map((interval) => [
      interval.id,
      selectBandThreshold(tuningSearch[interval.id]),
    ]),
  );
  const provisionalPolicies = Object.fromEntries(
    learnedIntervals.map((interval) => [
      interval.id,
      {
        enabled: true,
        threshold: selected[interval.id]?.threshold ?? null,
      },
    ]),
  );
  const provisionalTuning = evaluateBandPolicies(
    ordered,
    trainEnd,
    tuningEnd,
    learnedIntervals,
    provisionalPolicies,
    legacyTolerance,
  );
  const provisionalValidation = evaluateBandPolicies(
    ordered,
    tuningEnd,
    ordered.length,
    learnedIntervals,
    provisionalPolicies,
    legacyTolerance,
  );
  const policies = Object.fromEntries(
    learnedIntervals.map((interval) => {
      const tuning = provisionalTuning.perBand[interval.id];
      const validation = provisionalValidation.perBand[interval.id];
      const threshold = provisionalPolicies[interval.id].threshold;
      const passed = Boolean(
        Number.isFinite(threshold) &&
        tuning.candidate.coverage >= tuning.baseline.coverage * 0.98 &&
        validation.candidate.coverage >= validation.baseline.coverage * 0.98 &&
        tuning.delta.topTwoCoverage > 0 &&
        validation.delta.topTwoCoverage > 0
      );
      return [
        interval.id,
        {
          enabled: passed,
          threshold,
          tuning,
          validation,
          gate: {
            passed,
            reason: passed
              ? "0球赔率±3.00后，其余七项赔率距离在中间20%和最新20%均提高双选覆盖率"
              : "其余七项赔率距离未在中间20%和最新20%重复提高，仅使用0球赔率±3.00近邻",
          },
        },
      ];
    }),
  );
  const tuning = evaluateBandPolicies(
    ordered,
    trainEnd,
    tuningEnd,
    learnedIntervals,
    policies,
    legacyTolerance,
  );
  const validation = evaluateBandPolicies(
    ordered,
    tuningEnd,
    ordered.length,
    learnedIntervals,
    policies,
    legacyTolerance,
  );
  const enabled =
    validation.candidate.coverage >= validation.legacy.coverage * 0.98 &&
    validation.candidate.topTwoCoverage > validation.legacy.topTwoCoverage &&
    validation.candidate.logLoss < validation.legacy.logLoss;
  return {
    enabled,
    method: "n52-zero-odds-neighborhood-plus-seven-probability-distance",
    distance: "0球赔率先按绝对差±3.00筛选；再比较1球至7+球去水概率的最大绝对差",
    legacyTolerance,
    splits: { trainEnd, tuningEnd, validationEnd: ordered.length },
    intervals: learnedIntervals,
    thresholds,
    tuningSearch,
    policies,
    tuning,
    validation,
    gate: {
      passed: enabled,
      reason: enabled
        ? "0球赔率±3.00近邻与已验证七项距离在最新20%优于原八档整体距离"
        : "0球赔率±3.00近邻与七项距离未整体超过原八档距离，保留旧模型",
    },
  };
}
