const THREE_WAY_SEGMENTS = [
  "home-strong",
  "home-edge",
  "balanced",
  "away-edge",
  "away-strong",
];

const GOAL_SEGMENTS = ["low", "mid-low", "mid-high", "high"];

function validOdds(odds, size) {
  return (
    Array.isArray(odds) &&
    odds.length === size &&
    odds.every((value) => Number.isFinite(Number(value)) && Number(value) > 1)
  );
}

function normalize(odds) {
  const implied = odds.map((value) => 1 / Number(value));
  const total = implied.reduce((sum, value) => sum + value, 0);
  return implied.map((value) => value / total);
}

export function classifyThreeWayOdds(odds) {
  if (!validOdds(odds, 3)) return "unknown";
  const [home, , away] = normalize(odds);
  if (home >= 0.55) return "home-strong";
  if (away >= 0.55) return "away-strong";
  if (Math.abs(home - away) < 0.08) return "balanced";
  return home > away ? "home-edge" : "away-edge";
}

export function classifyGoalOdds(odds) {
  if (!validOdds(odds, 8)) return "unknown";
  const probabilities = normalize(odds);
  const goalValues = [0, 1, 2, 3, 4, 5, 6, 7.5];
  const expectedGoals = probabilities.reduce(
    (sum, probability, index) =>
      sum + probability * goalValues[index],
    0,
  );
  if (expectedGoals < 2.6) return "low";
  if (expectedGoals < 2.9) return "mid-low";
  if (expectedGoals < 3.2) return "mid-high";
  return "high";
}

export function segmentLabels(market) {
  return market === "goals" ? [...GOAL_SEGMENTS] : [...THREE_WAY_SEGMENTS];
}

function groupBySource(rows) {
  const groups = new Map();
  for (const row of rows) {
    const source = row.sourceFile || "unknown";
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push(row);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.sourceRow - right.sourceRow);
  }
  return groups;
}

function accumulator() {
  return {
    targets: 0,
    evaluated: 0,
    correct: 0,
    topTwoCorrect: 0,
    logLoss: 0,
    brier: 0,
    sampleSizes: [],
  };
}

function addCase(target, probabilities, actualIndex, samples) {
  target.targets += 1;
  if (!probabilities) return;
  target.evaluated += 1;
  target.sampleSizes.push(samples);
  const ranked = probabilities
    .map((value, index) => ({ value, index }))
    .sort((left, right) => right.value - left.value || left.index - right.index);
  const highest = ranked[0].value;
  const leaders = ranked.filter(({ value }) => Math.abs(value - highest) < 1e-12);
  if (leaders.some(({ index }) => index === actualIndex)) {
    target.correct += 1 / leaders.length;
  }
  if (ranked.slice(0, 2).some(({ index }) => index === actualIndex)) {
    target.topTwoCorrect += 1;
  }
  target.logLoss -= Math.log(Math.max(1e-12, probabilities[actualIndex]));
  target.brier += probabilities.reduce((sum, probability, index) => {
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
  const count = value.evaluated;
  return {
    targets: value.targets,
    evaluated: count,
    coverage: value.targets ? count / value.targets : 0,
    accuracy: count ? value.correct / count : 0,
    topTwoCoverage: count ? value.topTwoCorrect / count : 0,
    logLoss: count ? value.logLoss / count : 0,
    brier: count ? value.brier / count : 0,
    medianSamples: median(value.sampleSizes),
  };
}

function distribution(counts, total) {
  return total ? counts.map((count) => count / total) : null;
}

function comparison(candidate, baseline) {
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

function passes(value, objective, minCases) {
  if (!value || value.candidate.evaluated < minCases) return false;
  const metric = objective === "top-two" ? "topTwoCoverage" : "accuracy";
  return (
    value.candidate.coverage >= value.baseline.coverage * 0.98 &&
    value.delta[metric] > 1e-10 &&
    value.delta.logLoss < -1e-10 &&
    value.delta.brier < -1e-10
  );
}

function better(left, right, objective) {
  if (!right) return true;
  const metric = objective === "top-two" ? "topTwoCoverage" : "accuracy";
  if (Math.abs(left.delta[metric] - right.delta[metric]) > 1e-10) {
    return left.delta[metric] > right.delta[metric];
  }
  if (Math.abs(left.delta.logLoss - right.delta.logLoss) > 1e-10) {
    return left.delta.logLoss < right.delta.logLoss;
  }
  return left.threshold < right.threshold;
}

export function tuneSegmentThresholds(
  rows,
  {
    segments,
    labels,
    outcomeField,
    thresholds,
    baselineThreshold,
    segmenter,
    distance,
    compatible = () => true,
    warmup = 500,
    validationFraction = 0.2,
    objective = "accuracy",
    minimumTuningCases = 200,
    minimumValidationCases = 50,
  },
) {
  const ladder = [...new Set(thresholds.map(Number))]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  const buckets = Object.fromEntries(
    segments.map((segment) => [
      segment,
      Object.fromEntries(
        ladder.map((threshold) => [
          String(threshold),
          {
            threshold,
            tuning: accumulator(),
            tuningBaseline: accumulator(),
            validation: accumulator(),
            validationBaseline: accumulator(),
          },
        ]),
      ),
    ]),
  );

  for (const group of groupBySource(rows).values()) {
    const validationStart = Math.max(
      warmup + 1,
      Math.floor(group.length * (1 - validationFraction)),
    );
    for (let targetIndex = warmup; targetIndex < group.length; targetIndex += 1) {
      const target = group[targetIndex];
      const segment = segmenter(target);
      const actualIndex = labels.indexOf(String(target[outcomeField]));
      if (!buckets[segment] || actualIndex < 0) continue;
      const phase = targetIndex >= validationStart ? "validation" : "tuning";
      const baselineCounts = labels.map(() => 0);
      let baselineSamples = 0;
      const candidateCounts = ladder.map(() => labels.map(() => 0));
      const candidateSamples = ladder.map(() => 0);

      for (let historyIndex = 0; historyIndex < targetIndex; historyIndex += 1) {
        const history = group[historyIndex];
        if (!compatible(history, target)) continue;
        const labelIndex = labels.indexOf(String(history[outcomeField]));
        if (labelIndex < 0) continue;
        const value = distance(history, target);
        if (value <= baselineThreshold) {
          baselineCounts[labelIndex] += 1;
          baselineSamples += 1;
        }
        for (let index = 0; index < ladder.length; index += 1) {
          if (value <= ladder[index]) {
            candidateCounts[index][labelIndex] += 1;
            candidateSamples[index] += 1;
          }
        }
      }

      const baseline = distribution(baselineCounts, baselineSamples);
      for (let index = 0; index < ladder.length; index += 1) {
        const record = buckets[segment][String(ladder[index])];
        addCase(
          record[phase],
          distribution(candidateCounts[index], candidateSamples[index]),
          actualIndex,
          candidateSamples[index],
        );
        addCase(
          record[phase + "Baseline"],
          baseline,
          actualIndex,
          baselineSamples,
        );
      }
    }
  }

  const policies = {};
  for (const segment of segments) {
    const candidates = ladder.map((threshold) => {
      const record = buckets[segment][String(threshold)];
      return {
        threshold,
        tuning: comparison(record.tuning, record.tuningBaseline),
        validation: comparison(record.validation, record.validationBaseline),
      };
    });
    let selected = null;
    for (const candidate of candidates) {
      if (
        passes(candidate.tuning, objective, minimumTuningCases) &&
        better({ threshold: candidate.threshold, ...candidate.tuning }, selected, objective)
      ) {
        selected = { threshold: candidate.threshold, ...candidate.tuning };
      }
    }
    const selectedResult = selected
      ? candidates.find((candidate) => candidate.threshold === selected.threshold)
      : null;
    const validationPassed = passes(
      selectedResult?.validation,
      objective,
      minimumValidationCases,
    );
    policies[segment] = {
      enabled: Boolean(selectedResult && validationPassed),
      threshold: selectedResult?.threshold || baselineThreshold,
      selected: selectedResult,
      candidates,
      gate: {
        passed: Boolean(selectedResult && validationPassed),
        reason: !selectedResult
          ? "较早80%没有同时改善目标指标、Log Loss、Brier和覆盖率的分组范围"
          : validationPassed
            ? "该赔率类型在较早80%和最新20%均优于全局范围"
            : "较早80%选出的分组范围未通过最新20%验证",
      },
    };
  }

  return {
    objective,
    baselineThreshold,
    thresholds: ladder,
    policies,
    enabledSegments: Object.values(policies).filter((policy) => policy.enabled)
      .length,
  };
}
