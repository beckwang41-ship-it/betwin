const MARKETS = ["spf", "hhad", "goals"];

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function artifactMatches(candidate, artifact) {
  return Boolean(
    artifact &&
      artifact.generatedAt === candidate.generatedAt &&
      artifact.verifiedMatches === candidate.data?.verifiedMatches &&
      artifact.sourceUpdatedAt === candidate.data?.sourceUpdatedAt &&
      artifact.matchingVersion === candidate.data?.matchingVersion &&
      artifact.goalMatchingVersion === candidate.data?.goalMatchingVersion,
  );
}

function disabledMarket(candidateMarket, reason) {
  const referenceStrength = number(candidateMarket?.candidateStrength);
  return {
    ...(candidateMarket?.production || {}),
    enabled: false,
    strength: 0,
    referenceStrength,
    validated: false,
    reason,
  };
}

export function resolveSmoothingProduction(
  candidate = {},
  approval = {},
  { candidateStale = false } = {},
) {
  const approvalRequested = approval.runtimeEnabled === true;
  const approvalCurrent =
    approvalRequested &&
    !candidateStale &&
    candidate.candidateOnly === true &&
    artifactMatches(candidate, approval.approvedArtifact);
  const baseReason = candidateStale
    ? "平滑候选报告已过期，生产继续使用原始历史占比"
    : !approvalRequested
      ? "平滑调参只生成候选报告，尚未人工批准上线"
      : !approvalCurrent
        ? "平滑人工批准与当前候选版本或数据水位不一致，生产继续关闭"
        : "当前人工批准未包含此玩法，生产继续使用原始历史占比";

  const markets = Object.fromEntries(
    MARKETS.map((market) => {
      const candidateMarket = candidate.markets?.[market] || {};
      const marketApproval = approval.markets?.[market] || {};
      const candidateStrength = number(candidateMarket.candidateStrength);
      const approvedStrength = number(marketApproval.strength);
      const enabled = Boolean(
        approvalCurrent &&
          marketApproval.enabled === true &&
          candidateMarket.gate?.passed === true &&
          approvedStrength > 0 &&
          Math.abs(approvedStrength - candidateStrength) < 1e-12,
      );
      const reason = enabled
        ? `已人工批准当前候选强度 ${approvedStrength}`
        : approvalCurrent && marketApproval.enabled === true
          ? candidateMarket.gate?.passed !== true
            ? "当前候选未通过离线门禁，人工批准不能启用"
            : "人工批准强度与当前候选强度不一致，生产继续关闭"
          : baseReason;
      return [
        market,
        enabled
          ? {
              ...(candidateMarket.production || {}),
              enabled: true,
              strength: approvedStrength,
              referenceStrength: candidateStrength,
              validated: true,
              reason,
            }
          : disabledMarket(candidateMarket, reason),
      ];
    }),
  );
  const enabledMarkets = MARKETS.filter((market) => markets[market].enabled);
  return {
    runtimeEnabled: enabledMarkets.length > 0,
    approvalRequested,
    approvalCurrent,
    status: enabledMarkets.length
      ? "approved"
      : candidateStale
        ? "candidate-stale"
        : approvalRequested
          ? "approval-mismatch"
          : "disabled",
    reason: enabledMarkets.length
      ? `已人工批准 ${enabledMarkets.join("、")} 平滑候选`
      : baseReason,
    approvedAt: approval.approvedAt || null,
    approvedArtifact: approval.approvedArtifact || null,
    enabledMarkets,
    markets,
  };
}
