function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function percentile(values, probability) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const ratio = position - lower;
  return sorted[lower] * (1 - ratio) + sorted[upper] * ratio;
}

function correctScore(probabilities, actualIndex) {
  const highest = Math.max(...probabilities);
  const topIndices = probabilities
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => Math.abs(value - highest) < 1e-12)
    .map(({ index }) => index);
  return topIndices.includes(actualIndex) ? 1 / topIndices.length : 0;
}

function brier(probabilities, actualIndex) {
  return probabilities.reduce((sum, probability, index) => {
    const actual = index === actualIndex ? 1 : 0;
    return sum + (probability - actual) ** 2;
  }, 0);
}

export function classificationDelta(
  candidate,
  baseline,
  actualIndex,
  { sourceFile = "unknown", order = 0 } = {},
) {
  return {
    sourceFile,
    order,
    accuracy:
      correctScore(candidate, actualIndex) -
      correctScore(baseline, actualIndex),
    logLoss:
      -Math.log(Math.max(1e-12, candidate[actualIndex])) +
      Math.log(Math.max(1e-12, baseline[actualIndex])),
    brier:
      brier(candidate, actualIndex) -
      brier(baseline, actualIndex),
  };
}

function emptyResult(reason) {
  return {
    passed: false,
    status: "insufficient",
    reason,
    iterations: 0,
    blockSize: 0,
    confidence: 0.95,
    evaluated: 0,
    metrics: null,
  };
}

export function blockBootstrapMean(
  cases,
  {
    iterations = 1000,
    blockSize = 20,
    confidence = 0.95,
    seed = 20260727,
  } = {},
) {
  const safeCases = cases.filter((item) => Number.isFinite(item.value));
  if (!safeCases.length) {
    return {
      status: "insufficient",
      reason: "没有可用于时间分块检验的样本",
      iterations: 0,
      blockSize: 0,
      confidence,
      evaluated: 0,
      mean: null,
      lower: null,
      upper: null,
      improvementProbability: null,
    };
  }
  const groups = new Map();
  for (const item of safeCases) {
    const key = item.sourceFile || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
  }

  const safeIterations = Math.max(200, Math.floor(iterations));
  const safeBlockSize = Math.max(1, Math.floor(blockSize));
  const random = mulberry32(seed);
  const samples = [];
  for (let iteration = 0; iteration < safeIterations; iteration += 1) {
    let total = 0;
    let sampled = 0;
    for (const group of groups.values()) {
      let groupSampled = 0;
      while (groupSampled < group.length) {
        const start = Math.floor(random() * group.length);
        const take = Math.min(safeBlockSize, group.length - groupSampled);
        for (let offset = 0; offset < take; offset += 1) {
          total += group[(start + offset) % group.length].value;
          sampled += 1;
          groupSampled += 1;
        }
      }
    }
    samples.push(total / sampled);
  }

  const alpha = (1 - confidence) / 2;
  const lower = percentile(samples, alpha);
  const upper = percentile(samples, 1 - alpha);
  return {
    status: lower > 0 ? "better" : upper < 0 ? "worse" : "uncertain",
    reason:
      lower > 0
        ? "时间分块Bootstrap区间整体高于0"
        : upper < 0
          ? "时间分块Bootstrap区间整体低于0"
          : "时间分块Bootstrap区间仍跨过0",
    iterations: safeIterations,
    blockSize: safeBlockSize,
    confidence,
    evaluated: safeCases.length,
    mean: mean(safeCases.map((item) => item.value)),
    lower,
    upper,
    improvementProbability:
      samples.filter((value) => value > 0).length / samples.length,
  };
}

export function blockBootstrapComparison(
  cases,
  {
    iterations = 1000,
    blockSize = 20,
    confidence = 0.95,
    seed = 20260727,
    // 命中率非劣界限。默认 0 表示要求区间下界不低于 0（严格不退步）。
    // 传入负值时改为「非劣性检验」：允许下界落在 margin 以内，
    // 用于跳出 bootstrap 种子噪声带。调用方须自行论证 margin 取值，
    // 见 scripts/test_gate_margin.mjs 与 scripts/test_gate_stability.mjs。
    accuracyMargin = 0,
  } = {},
) {
  const safeCases = cases.filter(
    (item) =>
      Number.isFinite(item.accuracy) &&
      Number.isFinite(item.logLoss) &&
      Number.isFinite(item.brier),
  );
  if (!safeCases.length) {
    return emptyResult("没有可用于显著性检验的共同验证样本");
  }
  const groups = new Map();
  for (const item of safeCases) {
    const key = item.sourceFile || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.order - right.order);
  }

  const safeIterations = Math.max(200, Math.floor(iterations));
  const safeBlockSize = Math.max(1, Math.floor(blockSize));
  const random = mulberry32(seed);
  const samples = {
    accuracy: [],
    logLoss: [],
    brier: [],
  };

  for (let iteration = 0; iteration < safeIterations; iteration += 1) {
    const totals = { accuracy: 0, logLoss: 0, brier: 0 };
    let sampled = 0;
    for (const group of groups.values()) {
      let groupSampled = 0;
      while (groupSampled < group.length) {
        const start = Math.floor(random() * group.length);
        const take = Math.min(
          safeBlockSize,
          group.length - groupSampled,
        );
        for (let offset = 0; offset < take; offset += 1) {
          const item = group[(start + offset) % group.length];
          totals.accuracy += item.accuracy;
          totals.logLoss += item.logLoss;
          totals.brier += item.brier;
          sampled += 1;
          groupSampled += 1;
        }
      }
    }
    samples.accuracy.push(totals.accuracy / sampled);
    samples.logLoss.push(totals.logLoss / sampled);
    samples.brier.push(totals.brier / sampled);
  }

  const alpha = (1 - confidence) / 2;
  const metrics = Object.fromEntries(
    ["accuracy", "logLoss", "brier"].map((metric) => {
      const values = safeCases.map((item) => item[metric]);
      const bootstrap = samples[metric];
      const improvement = bootstrap.filter((value) =>
        metric === "accuracy" ? value >= 0 : value < 0,
      ).length / bootstrap.length;
      return [
        metric,
        {
          delta: mean(values),
          lower: percentile(bootstrap, alpha),
          upper: percentile(bootstrap, 1 - alpha),
          improvementProbability: improvement,
        },
      ];
    }),
  );
  const epsilon = 1e-12;
  const safeMargin = Math.min(0, Number(accuracyMargin) || 0);
  const accuracyThreshold = safeMargin - epsilon;
  const accuracyPassed = metrics.accuracy.lower >= accuracyThreshold;
  const passed =
    metrics.logLoss.upper < -epsilon &&
    metrics.brier.upper < -epsilon &&
    accuracyPassed;
  const marginLabel = safeMargin < 0
    ? `命中率在非劣界限 ${(safeMargin * 100).toFixed(2)}pp 内`
    : "命中率没有下降";
  return {
    passed,
    status: passed ? "significant" : "uncertain",
    reason: passed
      ? `95%区间确认 Log Loss、Brier 均改善，且${marginLabel}`
      : `指标均值虽可能改善，但95%区间仍包含无改善或命中率超出${
          safeMargin < 0 ? "非劣界限" : "不退步要求"
        }的情况`,
    iterations: safeIterations,
    blockSize: safeBlockSize,
    confidence,
    evaluated: safeCases.length,
    accuracyMargin: safeMargin,
    accuracyPassed,
    metrics,
  };
}
