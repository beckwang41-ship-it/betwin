function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function percentile(sortedValues, probability) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return (
    sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight
  );
}

function mulberry32(seed) {
  let value = Number(seed) >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function selectedIndices(probabilities, epsilon = 1e-12) {
  const safe = Array.isArray(probabilities)
    ? probabilities.map(Number)
    : [];
  if (!safe.length || safe.some((value) => !Number.isFinite(value))) return [];
  const highest = Math.max(...safe);
  const selected = safe
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => Math.abs(value - highest) <= epsilon)
    .map(({ index }) => index);
  // 覆盖全部结果没有投注信息量，与账本 selection-cost-v2 口径一致。
  return selected.length === safe.length ? [] : selected;
}

export function strategyOutcome(probabilities, odds, actualIndex) {
  const selected = selectedIndices(probabilities);
  const safeOdds = Array.isArray(odds) ? odds.map(Number) : [];
  if (
    !selected.length ||
    !Number.isInteger(actualIndex) ||
    actualIndex < 0 ||
    actualIndex >= safeOdds.length ||
    selected.some(
      (index) => !Number.isFinite(safeOdds[index]) || safeOdds[index] <= 1,
    )
  ) {
    return {
      selected,
      noPrediction: true,
      stakeUnits: 0,
      returnUnits: 0,
      profitUnits: 0,
      won: false,
    };
  }
  const stakeUnits = selected.length;
  const won = selected.includes(actualIndex);
  const returnUnits = won ? safeOdds[actualIndex] : 0;
  return {
    selected,
    noPrediction: false,
    stakeUnits,
    returnUnits,
    profitUnits: returnUnits - stakeUnits,
    won,
  };
}

export function pairedStrategyCase(
  candidateProbabilities,
  baselineProbabilities,
  odds,
  actualIndex,
  { sourceFile = "unknown", order = 0 } = {},
) {
  return {
    sourceFile,
    order: Number(order) || 0,
    candidate: strategyOutcome(candidateProbabilities, odds, actualIndex),
    baseline: strategyOutcome(baselineProbabilities, odds, actualIndex),
  };
}

export function summarizeStrategy(cases, side) {
  const outcomes = cases.map((item) => item?.[side]).filter(Boolean);
  const active = outcomes.filter((item) => !item.noPrediction);
  const stakeUnits = active.reduce((sum, item) => sum + item.stakeUnits, 0);
  const returnUnits = active.reduce((sum, item) => sum + item.returnUnits, 0);
  const profitUnits = returnUnits - stakeUnits;
  return {
    evaluatedMatches: cases.length,
    bettingMatches: active.length,
    noPredictionMatches: outcomes.length - active.length,
    wins: active.filter((item) => item.won).length,
    multiSelectionMatches: active.filter((item) => item.stakeUnits > 1).length,
    stakeUnits,
    returnUnits,
    profitUnits,
    roi: stakeUnits ? profitUnits / stakeUnits : null,
  };
}

function bootstrapStatus(lower, upper) {
  if (lower === null || upper === null) return "insufficient";
  if (lower > 0) return "better";
  if (upper < 0) return "worse";
  return "uncertain";
}

export function blockBootstrapStrategyComparison(
  cases,
  {
    iterations = 1000,
    blockSize = 20,
    confidence = 0.95,
    seed = 20260727,
  } = {},
) {
  const safeCases = cases.filter(
    (item) => item?.candidate && item?.baseline,
  );
  const candidate = summarizeStrategy(safeCases, "candidate");
  const baseline = summarizeStrategy(safeCases, "baseline");
  if (!safeCases.length || !candidate.stakeUnits || !baseline.stakeUnits) {
    return {
      status: "insufficient",
      reason: "没有足够的共同投注样本",
      passed: false,
      positiveEdge: false,
      evaluated: safeCases.length,
      iterations: 0,
      blockSize: 0,
      confidence,
      candidate,
      baseline,
      roiDelta: null,
      intervals: null,
    };
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
  const samples = { candidate: [], baseline: [], delta: [] };
  for (let iteration = 0; iteration < safeIterations; iteration += 1) {
    const totals = {
      candidateStake: 0,
      candidateReturn: 0,
      baselineStake: 0,
      baselineReturn: 0,
    };
    for (const group of groups.values()) {
      let sampled = 0;
      while (sampled < group.length) {
        const start = Math.floor(random() * group.length);
        const take = Math.min(safeBlockSize, group.length - sampled);
        for (let offset = 0; offset < take; offset += 1) {
          const item = group[(start + offset) % group.length];
          totals.candidateStake += item.candidate.stakeUnits;
          totals.candidateReturn += item.candidate.returnUnits;
          totals.baselineStake += item.baseline.stakeUnits;
          totals.baselineReturn += item.baseline.returnUnits;
          sampled += 1;
        }
      }
    }
    if (!totals.candidateStake || !totals.baselineStake) continue;
    const candidateRoi =
      totals.candidateReturn / totals.candidateStake - 1;
    const baselineRoi = totals.baselineReturn / totals.baselineStake - 1;
    samples.candidate.push(candidateRoi);
    samples.baseline.push(baselineRoi);
    samples.delta.push(candidateRoi - baselineRoi);
  }

  for (const values of Object.values(samples)) {
    values.sort((left, right) => left - right);
  }
  const alpha = (1 - confidence) / 2;
  const interval = (values) => ({
    lower: percentile(values, alpha),
    upper: percentile(values, 1 - alpha),
  });
  const intervals = {
    candidate: interval(samples.candidate),
    baseline: interval(samples.baseline),
    delta: interval(samples.delta),
  };
  const status = bootstrapStatus(
    intervals.delta.lower,
    intervals.delta.upper,
  );
  const positiveEdge = intervals.candidate.lower > 0;
  return {
    status,
    reason:
      status === "better"
        ? "候选相对基线的ROI提升区间整体高于0"
        : status === "worse"
          ? "候选相对基线的ROI提升区间整体低于0"
          : "候选相对基线的ROI提升区间包含0",
    // 这是独立的投注策略门禁，不替代概率质量门禁。
    passed: status === "better",
    positiveEdge,
    evaluated: safeCases.length,
    iterations: samples.delta.length,
    blockSize: safeBlockSize,
    confidence,
    candidate,
    baseline,
    roiDelta:
      candidate.roi === null || baseline.roi === null
        ? null
        : candidate.roi - baseline.roi,
    intervals,
    improvementProbability:
      mean(samples.delta.map((value) => (value > 0 ? 1 : 0))),
  };
}
