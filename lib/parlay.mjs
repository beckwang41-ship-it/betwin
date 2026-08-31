function round(value, digits = 4) {
  return Number(Number(value).toFixed(digits));
}

function choose(items, size, start = 0, picked = [], output = []) {
  if (picked.length === size) {
    output.push([...picked]);
    return output;
  }

  const remaining = size - picked.length;
  for (let index = start; index <= items.length - remaining; index += 1) {
    picked.push(items[index]);
    choose(items, size, index + 1, picked, output);
    picked.pop();
  }
  return output;
}

// 三项赔率倒数之和实测约 1.129 → 市场无优势假设下，单关基准返还率约 88.6%。
// 该值用于提示水钱随关数复合，不是收益上限；若模型存在真实概率优势，
// 实际期望可以高于这个市场基准。
const MARKET_BASELINE_SINGLE_LEG_RTP = 0.886;

// 找出组合里最弱的一关：先比历史占比，占比相同再比领先幅度。
// 串关全中才算赢，稳定性由最不稳定那一关决定（木桶原理），
// 平均值和乘积都会掩盖单点风险。
function weakestLeg(legs) {
  return legs.reduce((weak, leg) => {
    if (!weak) return leg;
    const legTop = Number(leg.stabilityTopProbability || 0);
    const weakTop = Number(weak.stabilityTopProbability || 0);
    if (legTop < weakTop) return leg;
    if (
      Math.abs(legTop - weakTop) < 1e-9 &&
      Number(leg.stabilityMargin || 0) < Number(weak.stabilityMargin || 0)
    ) {
      return leg;
    }
    return weak;
  }, null);
}

function scoreCombination(legs) {
  const combinedOdds = legs.reduce((total, leg) => total * leg.odds, 1);
  // 注意：这里假设各关独立。真实比赛之间可能同联赛、同时段、同球队关联，
  // 独立假设会让 hitProbability 偏高；模型单场概率的误差也在乘法下被放大
  // （单场 10% 相对误差 → 4 关约 46%）。因此该值是乐观估计，不是预测。
  const hitProbability = legs.reduce(
    (total, leg) => total * leg.probability,
    1,
  );
  const weakest = weakestLeg(legs);
  return {
    id: legs.map((leg) => leg.id).join("__"),
    legs,
    combinedOdds: round(combinedOdds, 2),
    hitProbability: round(hitProbability, 6),
    // valueIndex 只用于横向排序，不代表期望回报：
    // 从 C(n,k) 个组合里取最大值这个动作本身就会系统性虚高
    // （实测无偏噪声下 16 场选 4 关虚高约 54%，见 scripts/report_parlay_math.mjs）。
    valueIndex: round(combinedOdds * hitProbability, 3),
    // 假设真实概率等于市场去水概率时的基准返还率，不是收益上限。
    marketBaselineRtp: round(
      MARKET_BASELINE_SINGLE_LEG_RTP ** legs.length,
      4,
    ),
    // 最弱一环指标。它比乘积口径更直观，但从大量候选中挑最大值仍有选择偏差，
    // 因此只作为用户主动选择的研究排序，不作为默认推荐依据。
    weakestTopProbability: round(
      Number(weakest?.stabilityTopProbability || 0),
      4,
    ),
    weakestMargin: round(Number(weakest?.stabilityMargin || 0), 4),
    weakestConsensus: round(Number(weakest?.stabilityConsensus || 0), 4),
    weakestLegId: weakest?.id || null,
    // 信心等级基于「有多少关通过了各自玩法的已验证规则」。
    // 不写死概率门槛，因为 spf 与 hhad 的验证规则本身就不同
    // （spf 要求 top≥60%/margin≥36.1pp/四档全一致，hhad 要求 top≥54.8%/margin≥28.6pp）。
    ...parlayConfidence(legs),
  };
}

function parlayConfidence(legs) {
  const recommendedLegs = legs.filter(
    (leg) => leg.reliabilityLevel === "recommended",
  ).length;
  const skippedLegs = legs.filter(
    (leg) => leg.reliabilityLevel === "skip",
  ).length;
  const totalLegs = legs.length;
  let confidenceLevel = "低";
  if (recommendedLegs === totalLegs) confidenceLevel = "高";
  else if (!skippedLegs && recommendedLegs > 0) confidenceLevel = "中";
  return {
    confidenceLevel,
    recommendedLegs,
    skippedLegs,
    totalLegs,
  };
}

function comparator(sort, targetOdds) {
  // 稳定优先：只看最弱一环，不看组合乘积。
  // 乘积口径会有多重比较偏差（scripts/report_parlay_math.mjs 实测
  // 8场选2关虚高 23.0%、12场选4关 45.8%、16场选4关 54.0%）。
  // 最弱一环同样未经串关时间验证，因此只保留为显式研究选项。
  if (sort === "stability") {
    return (left, right) =>
      right.weakestTopProbability - left.weakestTopProbability ||
      right.weakestMargin - left.weakestMargin ||
      right.weakestConsensus - left.weakestConsensus ||
      right.hitProbability - left.hitProbability;
  }

  if (sort === "probability") {
    return (left, right) =>
      right.hitProbability - left.hitProbability ||
      right.valueIndex - left.valueIndex;
  }

  if (sort === "target") {
    return (left, right) =>
      Math.abs(left.combinedOdds - targetOdds) -
        Math.abs(right.combinedOdds - targetOdds) ||
      right.hitProbability - left.hitProbability;
  }

  return (left, right) =>
    right.valueIndex - left.valueIndex ||
    right.hitProbability - left.hitProbability;
}

export function generateParlayCombinations(
  candidates,
  {
    legs = 2,
    targetOdds = 1.8,
    minLegOdds = 1,
    sort = "probability",
    limit = 20,
  } = {},
) {
  const safeLegs = Math.max(2, Math.min(5, Math.trunc(Number(legs) || 2)));
  const safeTarget = Math.max(1, Number(targetOdds) || 1.8);
  const safeMinLegOdds = Math.max(1, Number(minLegOdds) || 1);
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 20)));
  const eligibleCandidates = candidates.filter(
    (candidate) => Number(candidate.odds) >= safeMinLegOdds,
  );

  if (eligibleCandidates.length < safeLegs) {
    return {
      rows: [],
      total: 0,
      eligible: 0,
      settings: {
        legs: safeLegs,
        targetOdds: safeTarget,
        minLegOdds: safeMinLegOdds,
        sort,
        limit: safeLimit,
      },
    };
  }

  const allRows = choose(eligibleCandidates, safeLegs).map(scoreCombination);
  const eligibleRows = allRows
    .filter((row) => row.combinedOdds >= safeTarget)
    .sort(comparator(sort, safeTarget));

  return {
    rows: eligibleRows.slice(0, safeLimit),
    total: allRows.length,
    eligible: eligibleRows.length,
    settings: {
      legs: safeLegs,
      targetOdds: safeTarget,
      minLegOdds: safeMinLegOdds,
      sort,
      limit: safeLimit,
    },
  };
}

function goalPairTickets(legs) {
  const tickets = [];
  function expand(legIndex, selections, combinedOdds, probability) {
    if (legIndex === legs.length) {
      tickets.push({
        id: selections
          .map((selection) => `${selection.matchId}:${selection.label}`)
          .join("__"),
        selections,
        combinedOdds: round(combinedOdds, 2),
        probability: round(probability, 6),
        expectedReturn: round(probability * combinedOdds, 4),
      });
      return;
    }

    const leg = legs[legIndex];
    for (const selection of leg.selections) {
      expand(
        legIndex + 1,
        [
          ...selections,
          {
            matchId: leg.id,
            label: selection.label,
            odds: selection.odds,
          },
        ],
        combinedOdds * Number(selection.odds),
        probability * Number(selection.probability),
      );
    }
  }
  expand(0, [], 1, 1);
  return tickets;
}

function scoreGoalPairCombination(legs) {
  const totalStake = 2 ** legs.length;
  const hitProbability = legs.reduce(
    (total, leg) => total * leg.probability,
    1,
  );
  // 每场两档全排列后的期望返还可用乘法分配律直接求出，避免先为
  // 所有候选组合生成 2^n 张票；只给最终展示的组合展开票面明细。
  const expectedReturn = legs.reduce(
    (total, leg) =>
      total *
      leg.selections.reduce(
        (sum, selection) =>
          sum + Number(selection.probability) * Number(selection.odds),
        0,
      ),
    1,
  );
  const minimumTicketOdds = legs.reduce(
    (product, leg) =>
      product * Math.min(...leg.selections.map((selection) => Number(selection.odds))),
    1,
  );
  const maximumTicketOdds = legs.reduce(
    (product, leg) =>
      product * Math.max(...leg.selections.map((selection) => Number(selection.odds))),
    1,
  );
  const legProbabilities = legs.map((leg) => Number(leg.probability));
  return {
    id: legs.map((leg) => leg.id).join("__"),
    legs,
    ticketCount: totalStake,
    totalStake,
    hitProbability: round(hitProbability, 6),
    averageLegCoverage: round(
      legProbabilities.reduce((total, value) => total + value, 0) /
        legProbabilities.length,
      6,
    ),
    minimumLegCoverage: round(Math.min(...legProbabilities), 6),
    minimumTicketOdds: round(minimumTicketOdds, 2),
    maximumTicketOdds: round(maximumTicketOdds, 2),
    expectedReturn: round(expectedReturn, 3),
    expectedProfit: round(expectedReturn - totalStake, 3),
    // 同 scoreCombination：仅用于排序，选择偏差会让其系统性虚高。
    valueIndex: round(expectedReturn / totalStake, 3),
    marketBaselineRtp: round(
      MARKET_BASELINE_SINGLE_LEG_RTP ** legs.length,
      4,
    ),
  };
}

function goalPairComparator(sort) {
  if (sort === "value") {
    return (left, right) =>
      right.valueIndex - left.valueIndex ||
      right.minimumLegCoverage - left.minimumLegCoverage ||
      right.averageLegCoverage - left.averageLegCoverage;
  }
  return (left, right) =>
    right.hitProbability - left.hitProbability ||
    right.minimumLegCoverage - left.minimumLegCoverage ||
    right.averageLegCoverage - left.averageLegCoverage ||
    right.valueIndex - left.valueIndex;
}

export function generateGoalPairParlays(
  candidates,
  { legs = 2, sort = "probability", limit = 20 } = {},
) {
  const safeLegs = Math.max(2, Math.min(5, Math.trunc(Number(legs) || 2)));
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 20)));
  const eligible = candidates.filter(
    (candidate) =>
      Array.isArray(candidate.selections) &&
      candidate.selections.length === 2 &&
      candidate.selections.every(
        (selection) =>
          Number.isFinite(Number(selection.odds)) &&
          Number(selection.odds) > 1 &&
          Number.isFinite(Number(selection.probability)) &&
          Number(selection.probability) >= 0,
      ),
  );
  if (eligible.length < safeLegs) {
    return {
      rows: [],
      total: 0,
      eligible: 0,
      settings: {
        mode: "goalsPair",
        legs: safeLegs,
        sort,
        limit: safeLimit,
        stakePerCombination: 2 ** safeLegs,
        oddsFilter: false,
      },
    };
  }
  const allRows = choose(eligible, safeLegs).map(scoreGoalPairCombination);
  const sortedRows = allRows.sort(goalPairComparator(sort));
  return {
    rows: sortedRows.slice(0, safeLimit).map((row) => ({
      ...row,
      tickets: goalPairTickets(row.legs),
    })),
    total: allRows.length,
    eligible: allRows.length,
    settings: {
      mode: "goalsPair",
      legs: safeLegs,
      sort,
      limit: safeLimit,
      stakePerCombination: 2 ** safeLegs,
      oddsFilter: false,
    },
  };
}
