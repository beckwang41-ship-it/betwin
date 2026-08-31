const DEFAULT_GOAL_LABELS = ["0", "1", "2", "3", "4", "5", "6", "7+"];
const MULTIPLE_PREDICTION_LABELS = ["2", "3", "4", "5", "6", "7+"];
const EQUALITY_PREDICTION_LABELS = DEFAULT_GOAL_LABELS;

const PRIORITY_EQUALITY_INDEXES = [
  [2, 3],
  [1, 7],
  [1, 6],
  [0, 7],
];

function equalityPair(leftIndex, rightIndex) {
  return Object.freeze({
    id: `g${leftIndex}-g${rightIndex}`,
    label: `${DEFAULT_GOAL_LABELS[leftIndex]}球＝${DEFAULT_GOAL_LABELS[rightIndex]}球`,
    leftIndex,
    rightIndex,
  });
}

const priorityEqualityIds = new Set(
  PRIORITY_EQUALITY_INDEXES.map(([left, right]) => `g${left}-g${right}`),
);

export const GOAL_EQUALITY_PAIRS = Object.freeze([
  ...PRIORITY_EQUALITY_INDEXES.map(([left, right]) =>
    equalityPair(left, right),
  ),
  ...DEFAULT_GOAL_LABELS.flatMap((_, leftIndex) =>
    DEFAULT_GOAL_LABELS.slice(leftIndex + 1).flatMap((__, offset) => {
      const rightIndex = leftIndex + offset + 1;
      return priorityEqualityIds.has(`g${leftIndex}-g${rightIndex}`)
        ? []
        : [equalityPair(leftIndex, rightIndex)];
    }),
  ),
]);

export function exactGoalOddsEqualities(
  odds,
  pairs = GOAL_EQUALITY_PAIRS,
) {
  if (!Array.isArray(odds) || odds.length < 8) return [];
  return pairs.flatMap((pair) => {
    const leftCents = Math.round(Number(odds[pair.leftIndex]) * 100);
    const rightCents = Math.round(Number(odds[pair.rightIndex]) * 100);
    if (
      !Number.isFinite(leftCents) ||
      !Number.isFinite(rightCents) ||
      leftCents <= 0 ||
      leftCents !== rightCents
    ) {
      return [];
    }
    return [{ ...pair, equalOdds: leftCents / 100 }];
  });
}

export function goalOddsEqualitiesForMarket(
  market,
  pairs = GOAL_EQUALITY_PAIRS,
) {
  if (!market) return [];
  const odds = [
    market.g0,
    market.g1,
    market.g2,
    market.g3,
    market.g4,
    market.g5,
    market.g6,
    market.g7plus,
  ].map(Number);
  return exactGoalOddsEqualities(odds, pairs);
}

export function buildGoalEqualityDistribution(records) {
  const grouped = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const odds = recordGoalOdds(record);
    const goals = String(record?.goals ?? "");
    if (odds.length < 8 || !EQUALITY_PREDICTION_LABELS.includes(goals)) {
      continue;
    }
    for (const relation of exactGoalOddsEqualities(odds)) {
      const equalOddsCents = Math.round(Number(relation.equalOdds) * 100);
      const key = `${relation.id}:${equalOddsCents}`;
      const group = grouped.get(key) || {
        id: relation.id,
        label: relation.label,
        leftIndex: relation.leftIndex,
        rightIndex: relation.rightIndex,
        equalOdds: equalOddsCents / 100,
        counts: Object.fromEntries(
          EQUALITY_PREDICTION_LABELS.map((label) => [label, 0]),
        ),
        samples: 0,
      };
      group.counts[goals] += 1;
      group.samples += 1;
      grouped.set(key, group);
    }
  }
  return [...grouped.values()].sort(
    (left, right) =>
      left.id.localeCompare(right.id) || left.equalOdds - right.equalOdds,
  );
}

export function selectGoalEqualityPrediction(odds, distribution) {
  const numericOdds = Array.isArray(odds) ? odds.map(Number) : [];
  const relations = exactGoalOddsEqualities(numericOdds);
  if (numericOdds.length < 8 || relations.length === 0) {
    return {
      available: false,
      relations,
      predictions: [],
      reason: "当前总进球终赔没有两档赔率完全相同",
    };
  }

  const predictions = relations.flatMap((relation) => {
    const equalOddsCents = Math.round(Number(relation.equalOdds) * 100);
    const group = (Array.isArray(distribution) ? distribution : []).find(
      (item) =>
        item.id === relation.id &&
        Math.round(Number(item.equalOdds) * 100) === equalOddsCents,
    );
    if (!group?.samples) return [];
    const ranked = EQUALITY_PREDICTION_LABELS
      .map((label, order) => ({
        label,
        order,
        count: Number(group.counts?.[label] || 0),
      }))
      .filter((item) => item.count > 0)
      .sort(
        (left, right) => right.count - left.count || left.order - right.order,
      )
      .slice(0, 2);
    if (ranked.length < 2) return [];
    const probabilities = ranked.map((item) => item.count / group.samples);
    return [{
      ...relation,
      labels: ranked.map((item) => item.label),
      counts: ranked.map((item) => item.count),
      probabilities,
      coverageProbability: probabilities.reduce(
        (sum, probability) => sum + probability,
        0,
      ),
      samples: group.samples,
    }];
  });

  return {
    available: predictions.length > 0,
    relations,
    predictions,
    source: "倍数赔率历史比赛.html · 同赔组合与相同赔率精确档位",
    tieBreak: "场次相同时按较小进球数优先",
    reason: predictions.length
      ? "按同赔组合与相同赔率值精确匹配历史实际进球"
      : "历史报告没有当前同赔组合及赔率值的两个可用进球档位",
  };
}

export function exactGoalMultipleRelations(
  odds,
  labels = DEFAULT_GOAL_LABELS,
) {
  if (!Array.isArray(odds) || odds.length < 2) return [];
  const zeroCents = Math.round(Number(odds[0]) * 100);
  if (!Number.isFinite(zeroCents) || zeroCents <= 0) return [];

  return odds.slice(1).flatMap((value, offset) => {
    const cents = Math.round(Number(value) * 100);
    if (!Number.isFinite(cents) || cents <= 0 || zeroCents % cents !== 0) {
      return [];
    }
    const multiple = zeroCents / cents;
    if (!Number.isInteger(multiple) || multiple < 2) return [];
    const index = offset + 1;
    return [{ index, label: labels[index] ?? String(index), multiple }];
  });
}

export function goalMultipleRelationsForMarket(
  market,
  labels = DEFAULT_GOAL_LABELS,
) {
  if (!market) return [];
  const odds = [
    market.g0,
    market.g1,
    market.g2,
    market.g3,
    market.g4,
    market.g5,
    market.g6,
    market.g7plus,
  ].map(Number);
  return exactGoalMultipleRelations(odds, labels);
}

function recordGoalOdds(record) {
  const odds = record?.odds || record?.goalMarket?.odds;
  return Array.isArray(odds) ? odds.map(Number) : [];
}

function recordSourceFile(record) {
  return record?.sourceFile || record?.goalSourceFile || "";
}

export function buildGoalMultipleDistribution(
  records,
  {
    sourceFile = null,
    minimumZeroOdds = 11,
  } = {},
) {
  const grouped = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (sourceFile && recordSourceFile(record) !== sourceFile) continue;
    const odds = recordGoalOdds(record);
    const zeroOdds = Number(odds[0]);
    const goals = String(record?.goals ?? "");
    if (
      odds.length < 8 ||
      !Number.isFinite(zeroOdds) ||
      zeroOdds < minimumZeroOdds ||
      !MULTIPLE_PREDICTION_LABELS.includes(goals) ||
      exactGoalMultipleRelations(odds).length === 0
    ) {
      continue;
    }
    const key = Math.round(zeroOdds * 100);
    const group = grouped.get(key) || {
      zeroOdds: key / 100,
      counts: Object.fromEntries(
        MULTIPLE_PREDICTION_LABELS.map((label) => [label, 0]),
      ),
      samples: 0,
    };
    group.counts[goals] += 1;
    group.samples += 1;
    grouped.set(key, group);
  }
  return [...grouped.values()].sort(
    (left, right) => left.zeroOdds - right.zeroOdds,
  );
}

export function selectGoalMultiplePrediction(
  odds,
  distribution,
  { minimumZeroOdds = 11 } = {},
) {
  const numericOdds = Array.isArray(odds) ? odds.map(Number) : [];
  const zeroOdds = Number(numericOdds[0]);
  const relations = exactGoalMultipleRelations(numericOdds);
  if (
    numericOdds.length < 8 ||
    !Number.isFinite(zeroOdds) ||
    zeroOdds < minimumZeroOdds ||
    relations.length === 0
  ) {
    return {
      available: false,
      zeroOdds: Number.isFinite(zeroOdds) ? zeroOdds : null,
      relations,
      labels: [],
      counts: [],
      probabilities: [],
      coverageProbability: 0,
      samples: 0,
      reason: "当前0球终赔没有符合报告口径的整数倍关系",
    };
  }
  const zeroCents = Math.round(zeroOdds * 100);
  const group = (Array.isArray(distribution) ? distribution : []).find(
    (item) => Math.round(Number(item.zeroOdds) * 100) === zeroCents,
  );
  if (!group?.samples) {
    return {
      available: false,
      zeroOdds,
      relations,
      labels: [],
      counts: [],
      probabilities: [],
      coverageProbability: 0,
      samples: 0,
      reason: `历史报告没有0球终赔 ${zeroOdds.toFixed(2)} 的可用样本`,
    };
  }
  const ranked = MULTIPLE_PREDICTION_LABELS
    .map((label, order) => ({
      label,
      order,
      count: Number(group.counts?.[label] || 0),
    }))
    .filter((item) => item.count > 0)
    .sort(
      (left, right) => right.count - left.count || left.order - right.order,
    )
    .slice(0, 2);
  if (ranked.length < 2) {
    return {
      available: false,
      zeroOdds,
      relations,
      labels: ranked.map((item) => item.label),
      counts: ranked.map((item) => item.count),
      probabilities: ranked.map((item) => item.count / group.samples),
      coverageProbability: ranked.reduce(
        (sum, item) => sum + item.count / group.samples,
        0,
      ),
      samples: group.samples,
      reason: `0球终赔 ${zeroOdds.toFixed(2)} 只有一个有赛果的历史进球档位`,
    };
  }
  const probabilities = ranked.map((item) => item.count / group.samples);
  return {
    available: true,
    zeroOdds,
    relations,
    labels: ranked.map((item) => item.label),
    counts: ranked.map((item) => item.count),
    probabilities,
    coverageProbability: probabilities.reduce((sum, value) => sum + value, 0),
    samples: group.samples,
    source: "倍数赔率历史比赛.html · 实际2球至7+球精确档位",
    tieBreak: "场次相同时按较小进球数优先",
    reason: `按0球终赔 ${zeroOdds.toFixed(2)} 精确匹配整数倍历史档位`,
  };
}
