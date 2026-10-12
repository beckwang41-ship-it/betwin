export function goalPairValidation(prediction, { policy: config, sameLeague = false, usesRecommendedThreshold = true, smoothingEnabled = false }) {
  const rule = config?.selected?.rule;
  const status = !config?.generatedAt || Number(config.version) < 2 ? "unvalidated"
    : config.stale ? "stale"
      : sameLeague || !usesRecommendedThreshold || smoothingEnabled ? "unsupported-scope"
        : !prediction?.goalPair?.available ? "insufficient"
          : !config.validated || !rule ? "not-passed"
            : prediction.stats.total < Number(rule.minSamples) ? "insufficient"
              : prediction.goalPair.probability >= Number(rule.minPairProbability) ? "passed" : "not-selected";
  return { status, kind: "goal-pair", generatedAt: config?.generatedAt || null,
    reason: config?.gate?.reason || null, test: config?.selected?.test || null };
}

export function summarizeHistoricalSupport(points, selectedThreshold = null) {
  const rawPoints = Array.isArray(points) ? points : [];
  const hasSelectedThreshold =
    selectedThreshold !== null &&
    selectedThreshold !== undefined &&
    Number.isFinite(Number(selectedThreshold));
  const selectedPoint = hasSelectedThreshold
    ? rawPoints.reduce((closest, point) =>
        !closest ||
        Math.abs(Number(point.threshold) - Number(selectedThreshold)) <
          Math.abs(Number(closest.threshold) - Number(selectedThreshold))
          ? point
          : closest,
      null)
    : null;
  const selectedDirection =
    selectedPoint?.historicalPredicted || selectedPoint?.predicted || null;
  const safePoints = selectedDirection
    ? rawPoints.map((point) => {
        const index = Array.isArray(point.labels)
          ? point.labels.indexOf(selectedDirection)
          : -1;
        return {
          ...point,
          supportsFinal:
            !point.historicalIsTie &&
            point.historicalPredicted === selectedDirection,
          supportProbability:
            index >= 0
              ? Number(point.historicalProbabilities?.[index] || 0)
              : Number(point.supportProbability || 0),
        };
      })
    : rawPoints;
  const usable = safePoints.filter(
    (point) =>
      point.available &&
      !point.historicalIsTie &&
      typeof point.historicalPredicted === "string" &&
      point.historicalPredicted.length > 0,
  );
  const supportCount = usable.filter((point) => point.supportsFinal).length;
  const complete = safePoints.length > 0 && usable.length === safePoints.length;
  const status = !complete
    ? "insufficient"
    : supportCount === safePoints.length
      ? "supported"
      : supportCount === 0
        ? "opposed"
        : "mixed";
  return {
    status,
    stable: status === "supported",
    supportCount,
    availableCount: usable.length,
    totalPoints: safePoints.length,
    supportRate: safePoints.length ? supportCount / safePoints.length : 0,
    selectedThreshold:
      selectedPoint?.threshold ?? selectedThreshold ?? null,
    direction: selectedDirection,
    points: safePoints,
  };
}

function observedReliability(prediction, stability, threshold) {
  const finalProbabilities = prediction?.final || [];
  const labels = prediction?.labels || [];
  const predictedIndex = labels.indexOf(prediction?.predicted);
  const historicalProbabilities =
    prediction?.weightedEmpirical?.length
      ? prediction.weightedEmpirical
      : prediction?.empirical || [];
  const marketSorted = [...finalProbabilities].sort((left, right) => right - left);
  const selectedPoint = (stability?.points || []).find(
    (point) => Math.abs(Number(point.threshold) - Number(threshold)) < 1e-9,
  );
  const historicalSupportProbability =
    selectedPoint?.supportProbability ??
    (predictedIndex >= 0 ? Number(historicalProbabilities[predictedIndex] || 0) : 0);
  const historicalCompetitor = historicalProbabilities.reduce(
    (highest, value, index) =>
      index === predictedIndex ? highest : Math.max(highest, Number(value || 0)),
    0,
  );
  const points = stability?.points || [];
  const supportCount = Number(
    stability?.supportCount ?? points.filter((point) => point.supportsFinal).length,
  );
  const supportTotal = Number(stability?.totalPoints ?? points.length);
  return {
    samples: Number(prediction?.stats?.total || 0),
    topProbability: historicalSupportProbability,
    margin: historicalSupportProbability - historicalCompetitor,
    marketTopProbability: marketSorted[0] || 0,
    marketMargin:
      marketSorted.length > 1 ? marketSorted[0] - marketSorted[1] : 0,
    historicalSupportProbability,
    historicalSupportMargin:
      historicalSupportProbability - historicalCompetitor,
    historicalSupportCount: supportCount,
    historicalSupportTotal: supportTotal,
    stable: stability?.status === "supported",
    consensus: supportTotal ? supportCount / supportTotal : 0,
  };
}

function supportReason(observed) {
  if (!observed.historicalSupportTotal) return "没有可比较的历史范围";
  return `四档相似范围有 ${observed.historicalSupportCount}/${observed.historicalSupportTotal} 档支持当前历史预测方向`;
}

export function evaluateReliability({
  prediction,
  stability,
  policy,
  threshold,
  sameLeague = false,
}) {
  const observed = observedReliability(prediction, stability, threshold);
  const test = policy?.test || null;
  const base = {
    policyAvailable: Boolean(policy),
    policyEnabled: Boolean(policy?.enabled),
    rule: policy?.rule || null,
    observed,
    test,
    // 最新 20% 段「筛出场次命中 − 去水市场概率」的区块 Bootstrap 区间，前端展示用。
    marketSignificance: policy?.testMarketSignificance?.marketEdge || null,
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
    // 市场门禁失败是最关键的信息：先说结论，再说本场历史支持度。
    const gateReason = policy?.gate?.testPassed && policy?.gate?.marketEdgePassed === false
      ? "尚未通过相对市场隐含概率的增量验证，本玩法只作历史观察"
      : policy?.gate?.reason || "本玩法尚未通过选择性预测验证";
    return {
      ...base,
      level: "cautious",
      label: "谨慎参考",
      reason: `${gateReason}；${supportReason(observed)}`,
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
      // 用「重点参考」而不是「建议预测」：这条规则只验证过命中率更高，
      // 从未验证过投注能盈利（report:reliability-roi 实测 ROI 为负）。
      // "建议"是行动指令，会让人误以为已经验证过值得投注。
      label: "重点参考",
      reason: `命中已验证筛选规则；最新测试 ${test.selected} 场命中率 ${(test.selectedAccuracy * 100).toFixed(1)}%，覆盖 ${(test.coverage * 100).toFixed(1)}%（仅命中率口径，未验证投注收益）`,
    };
  }
  const missing = [];
  if (observed.topProbability < Number(policy.rule.minTopProbability)) {
    missing.push("当前历史预测方向的占比不足");
  }
  if (observed.margin < Number(policy.rule.minMargin)) {
    missing.push("当前历史分布的领先幅度不足");
  }
  if (observed.consensus < Number(policy.rule.minConsensus)) {
    missing.push("不同相似范围的历史方向不够一致");
  }
  if (policy.rule.requireStable && !observed.stable) {
    missing.push("并非四档相似范围都支持当前历史预测方向");
  }
  return {
    ...base,
    level: "cautious",
    label: "谨慎参考",
    reason: missing.join("；") || "没有命中已验证筛选规则",
  };
}
