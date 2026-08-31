// 通用「候选 → 生产」人工批准闸门。
//
// 设计前提（与 lib/smoothing-production.mjs 同源，但泛化为可注入）：
//   1. 调参脚本写出的候选配置文件**永远不能**控制生产。即使有人手工把
//      候选文件的 runtimeEnabled 改成 true，本模块也完全忽略该字段。
//   2. 生产启用必须同时满足五个条件：概率门禁通过、投注 ROI 门禁通过、
//      数据水位与版本一致、批准参数与候选参数逐位一致、独立批准文件明确开启。
//   3. 概率门禁与 ROI 门禁保持独立判据（概率更准 ≠ 投注更赚钱），
//      本模块只在「上线」这一步要求两者同时成立，不去污染任何一方的定义。

import { createHash } from "node:crypto";

const DEFAULT_MARKETS = ["spf", "hhad", "goals"];

function canonical(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Number(value.toFixed(12)) : null;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function sameParams(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function candidateContentDigest(candidate = {}) {
  const evidence = canonical({
    methodology: candidate.methodology ?? null,
    searchSpace: candidate.searchSpace ?? null,
    markets: candidate.markets ?? null,
  });
  return createHash("sha256")
    .update(JSON.stringify(evidence))
    .digest("hex");
}

// 批准文件必须记录批准时的候选指纹。任何一项不符即视为过期批准。
export function candidateArtifact(candidate = {}) {
  return canonical({
    generatedAt: candidate.generatedAt ?? null,
    verifiedMatches: candidate.data?.verifiedMatches ?? null,
    sourceUpdatedAt: candidate.data?.sourceUpdatedAt ?? null,
    matchingVersion:
      candidate.methodology?.matchingVersion ??
      candidate.data?.matchingVersion ??
      null,
    goalMatchingVersion:
      candidate.methodology?.goalMatchingVersion ??
      candidate.data?.goalMatchingVersion ??
      null,
    // 不只核对时间和数据水位，也锁定实际门禁证据与候选参数。
    // 同一 generatedAt 下手工改 gate/strategy/selected 也会让批准失效。
    contentDigest: candidateContentDigest(candidate),
  });
}

function artifactMatches(candidate, approvedArtifact) {
  if (!approvedArtifact) return false;
  return sameParams(candidateArtifact(candidate), approvedArtifact);
}

// 从候选玩法节点上取出投注 ROI 门禁结论。
// 找不到 strategy 视为「未跑过 ROI 检验」，一律不许上线。
function strategyVerdict(marketCandidate = {}) {
  const strategy =
    marketCandidate.strategy || marketCandidate.selected?.strategy || null;
  if (!strategy) {
    return { present: false, passed: false, status: "not-run" };
  }
  return {
    present: true,
    passed: strategy.passed === true,
    status: strategy.status || "unknown",
    roiDelta: strategy.roiDelta ?? null,
  };
}

/**
 * 解析某个调参模块的生产启用状态。
 *
 * @param candidate  调参脚本产出的候选配置（只读，其 runtimeEnabled 被忽略）
 * @param approval   独立人工批准文件内容
 * @param options.markets        玩法列表
 * @param options.candidateStale 候选是否已过期（数据水位/版本不符）
 * @param options.moduleLabel    用于生成中文原因文案
 * @param options.paramsOf       (marketCandidate) => 需要逐位比对的生产参数
 * @param options.approvedParamsOf (marketApproval) => 批准文件里记录的同类参数
 * @param options.probationGateOf  (marketCandidate) => 概率门禁是否通过
 */
export function resolveProductionApproval(
  candidate = {},
  approval = {},
  {
    markets = DEFAULT_MARKETS,
    candidateStale = false,
    moduleLabel = "该模块",
    paramsOf = () => null,
    approvedParamsOf = () => null,
    probabilityGateOf = (marketCandidate) =>
      marketCandidate?.gate?.passed === true,
  } = {},
) {
  const approvalRequested = approval.runtimeEnabled === true;
  const approvalCurrent =
    approvalRequested &&
    !candidateStale &&
    artifactMatches(candidate, approval.approvedArtifact);

  const baseReason = candidateStale
    ? `${moduleLabel}候选报告已过期，生产继续使用锁定的正式规则`
    : !approvalRequested
      ? `${moduleLabel}调参只生成候选报告，尚未人工批准上线`
      : !approvalCurrent
        ? `${moduleLabel}人工批准与当前候选版本或数据水位不一致，生产继续关闭`
        : `当前人工批准未包含此玩法，${moduleLabel}生产继续关闭`;

  const resolved = Object.fromEntries(
    markets.map((market) => {
      const marketCandidate = candidate.markets?.[market] || {};
      const marketApproval = approval.markets?.[market] || {};
      const probabilityPassed = probabilityGateOf(marketCandidate) === true;
      const strategy = strategyVerdict(marketCandidate);
      const paramsMatch = sameParams(
        paramsOf(marketCandidate),
        approvedParamsOf(marketApproval),
      );
      const requested = marketApproval.enabled === true;
      const enabled = Boolean(
        approvalCurrent &&
          requested &&
          probabilityPassed &&
          strategy.passed &&
          paramsMatch,
      );
      const reason = enabled
        ? `已人工批准：概率门禁与投注ROI门禁均通过（${moduleLabel}）`
        : !approvalCurrent || !requested
          ? baseReason
          : !probabilityPassed
            ? `${moduleLabel}候选未通过概率门禁，人工批准不能启用`
            : !strategy.passed
              ? strategy.present
                ? `${moduleLabel}候选未通过投注ROI门禁（${strategy.status}），人工批准不能启用`
                : `${moduleLabel}候选尚未运行投注ROI门禁，人工批准不能启用`
              : `${moduleLabel}人工批准参数与当前候选参数不一致，生产继续关闭`;
      return [
        market,
        {
          enabled,
          reason,
          probabilityPassed,
          strategyPassed: strategy.passed,
          strategyStatus: strategy.status,
          strategyRoiDelta: strategy.roiDelta,
          paramsMatch,
          approvalRequested: requested,
        },
      ];
    }),
  );

  const enabledMarkets = markets.filter((market) => resolved[market].enabled);
  const requestedMarkets = markets.filter(
    (market) => approval.markets?.[market]?.enabled === true,
  );
  const currentButBlockedReason = requestedMarkets.length
    ? `${moduleLabel}人工批准已读取，但没有玩法同时通过概率门禁、投注ROI门禁和参数核对`
    : `当前人工批准未包含任何玩法，${moduleLabel}生产继续关闭`;
  return {
    // 注意：这里返回的 runtimeEnabled 才是生产唯一依据，
    // 候选文件自身的 runtimeEnabled 无论是什么值都不参与计算。
    runtimeEnabled: enabledMarkets.length > 0,
    approvalRequested,
    approvalCurrent,
    status: enabledMarkets.length
      ? "approved"
      : candidateStale
        ? "candidate-stale"
        : !approvalRequested
          ? "disabled"
          : !approvalCurrent
            ? "approval-mismatch"
            : "gates-blocked",
    reason: enabledMarkets.length
      ? `已人工批准 ${enabledMarkets.join("、")} 的${moduleLabel}候选`
      : approvalCurrent
        ? currentButBlockedReason
        : baseReason,
    approvedAt: approval.approvedAt || null,
    approvedArtifact: approval.approvedArtifact || null,
    enabledMarkets,
    markets: resolved,
  };
}
