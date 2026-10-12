export const VALIDATION_LABELS = {
  unvalidated: "尚未验证", stale: "验证已过期", insufficient: "样本不足",
  "not-passed": "验证未通过", "not-selected": "本场未通过筛选",
  "unsupported-scope": "当前范围未验证", passed: "历史验证通过",
};

export function validationState(prediction, config, market) {
  if (prediction?.reliability?.validation) return prediction.reliability.validation;
  const selection = config?.selection;
  if (!selection?.generatedAt) return { status: "unvalidated" };
  if (config.selectionStale || selection.stale) return { status: "stale" };
  if (prediction?.reliability?.level === "skip") return { status: "insufficient" };
  if (!selection.markets?.[market]?.enabled) return { status: "not-passed" };
  return { status: prediction?.reliability?.level === "recommended" ? "passed" : "not-selected" };
}

export function verdictSummary(items) {
  const passed = items.filter(item => item.validation.status === "passed");
  const statuses = [...new Set(items.filter(item => item.validation.status !== "passed")
    .map(item => VALIDATION_LABELS[item.validation.status] || "尚未验证"))];
  return {
    passed,
    title: passed.length ? `${passed.map(item => item.name).join("、")}通过历史验证，可重点参考`
      : "本场只作历史观察，不构成推荐",
    text: passed.length
      ? "通过相应玩法的历史验证，不代表本场必然命中或能稳定盈利。" + (statuses.length ? `其余玩法：${statuses.join("、")}。` : "")
      : `${statuses.join("、") || "尚未验证"}；当前没有满足完整验证及本场筛选条件的玩法，不能据此断定模型与市场持平或没有提升。`,
  };
}

export function marketEvidence(significance) {
  const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value));
  if (!finite(significance?.lower) || !finite(significance?.upper)) return { status: "unknown", label: "缺少区间，无法判断增量" };
  if (Number(significance.lower) > 0) return { status: "positive", label: "命中率显著高于市场隐含概率" };
  if (Number(significance.upper) < 0) return { status: "negative", label: "命中率显著低于市场隐含概率" };
  return { status: "inconclusive", label: "未发现显著差异，不代表相等" };
}
