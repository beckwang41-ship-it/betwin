function observedReliability(prediction, stability) {
  const probabilities =
    prediction?.empirical?.length
      ? prediction.empirical
      : prediction?.final || [];
  const sorted = [...probabilities].sort((left, right) => right - left);
  const usableDirections = (stability?.points || [])
    .filter((point) => point.available && !point.isTie && point.predicted)
    .map((point) => point.predicted);
  const directionCounts = usableDirections.reduce((counts, direction) => {
    counts[direction] = (counts[direction] || 0) + 1;
    return counts;
  }, {});
  return {
    samples: Number(prediction?.stats?.total || 0),
    topProbability: sorted[0] || 0,
    margin: sorted.length > 1 ? sorted[0] - sorted[1] : 0,
    stable: stability?.status === "stable",
    consensus: usableDirections.length
      ? Math.max(...Object.values(directionCounts)) / usableDirections.length
      : 0,
  };
}

export function evaluateReliability({
  prediction,
  stability,
  policy,
  threshold,
  sameLeague = false,
}) {
  const observed = observedReliability(prediction, stability);
  const test = policy?.test || null;
  const base = {
    policyAvailable: Boolean(policy),
    policyEnabled: Boolean(policy?.enabled),
    rule: policy?.rule || null,
    observed,
    test,
    gate: policy?.gate || null,
  };
  if (!prediction?.available || !observed.samples) {
    return {
      ...base,
      level: "skip",
      label: "建议跳过",
      reason: "当前阈值没有相似历史比赛，无法形成历史概率",
    };
  }
  if (prediction.isTie) {
    return {
      ...base,
      level: "skip",
      label: "建议跳过",
      reason: "最高概率存在并列，方向不明确",
    };
  }
  if (!policy?.enabled) {
    return {
      ...base,
      level: "cautious",
      label: "谨慎参考",
      reason: policy?.gate?.reason || "本玩法尚未通过选择性预测验证",
    };
  }
  const settingsValidated =
    !sameLeague &&
    Math.abs(Number(threshold) - Number(policy.rule.threshold)) < 1e-9;
  if (!settingsValidated) {
    return {
      ...base,
      level: "cautious",
      label: "谨慎参考",
      reason: sameLeague
        ? "“只看同联赛”改变了已验证样本口径，可靠性等级自动回退"
        : "当前赔率阈值不是选择规则验证时使用的阈值，可靠性等级自动回退",
    };
  }
  if (observed.samples < Number(policy.rule.minSamples)) {
    return {
      ...base,
      level: "skip",
      label: "建议跳过",
      reason: `相似样本少于已验证规则要求的 ${policy.rule.minSamples} 场`,
    };
  }
  const matchesRule =
    observed.topProbability >= Number(policy.rule.minTopProbability) &&
    observed.margin >= Number(policy.rule.minMargin) &&
    observed.consensus >= Number(policy.rule.minConsensus) &&
    (!policy.rule.requireStable || observed.stable);
  if (matchesRule) {
    return {
      ...base,
      level: "recommended",
      label: "建议预测",
      reason: `命中已验证筛选规则；最新测试 ${test.selected} 场命中率 ${(test.selectedAccuracy * 100).toFixed(1)}%，覆盖 ${(test.coverage * 100).toFixed(1)}%`,
    };
  }
  const missing = [];
  if (observed.topProbability < Number(policy.rule.minTopProbability)) {
    missing.push("最高概率不够集中");
  }
  if (observed.margin < Number(policy.rule.minMargin)) {
    missing.push("第一名领先不足");
  }
  if (observed.consensus < Number(policy.rule.minConsensus)) {
    missing.push("不同阈值方向一致性不足");
  }
  if (policy.rule.requireStable && !observed.stable) {
    missing.push("四档阈值方向不稳定");
  }
  return {
    ...base,
    level: "cautious",
    label: "谨慎参考",
    reason: missing.join("；") || "没有命中已验证筛选规则",
  };
}
