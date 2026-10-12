// 按页面一位小数的概率排名，同值并列并跳过相应名次。
function probabilityRanks(entries) {
  const sorted = entries.filter(entry => Number.isFinite(entry.probability))
    .map(entry => ({ id: String(entry.id), coverage: Number((entry.probability * 100).toFixed(1)) }))
    .sort((a, b) => b.coverage - a.coverage);
  let rank = 0;
  return new Map(sorted.map((entry, index) => {
    if (!index || entry.coverage !== sorted[index - 1].coverage) rank = index + 1;
    return [entry.id, rank];
  }));
}

export function goalCoverageRanks(candidates) {
  return probabilityRanks((candidates || []).filter(c => c.markets?.goalsPair?.eligible)
    .map(c => ({ id: c.id, probability: c.markets.goalsPair.probability })));
}

export function standardProbabilityRanks(candidates, { minLegOdds = 0, currentMarkets = new Map() } = {}) {
  return probabilityRanks((candidates || []).flatMap(candidate => {
    const eligible = [candidate.markets?.had, candidate.markets?.hhad]
      .filter(market => market && Number(market.odds) >= minLegOdds);
    const pick = eligible.find(market => market.market === currentMarkets.get(candidate.id)) || eligible[0];
    return pick ? [{ id: candidate.id, probability: pick.probability }] : [];
  }));
}

export function parlaySelectionSummary(settings, count) {
  const rule = settings.maxMatchUses ? `每场最多${settings.maxMatchUses}组` : "每场使用次数不限制";
  return `目标 ${settings.limit} 组，按原排序依次筛选后生成 ${count} 组；${rule}。${count < settings.limit ? "按当前候选和规则无法凑满，未自动放宽限制。" : ""}`;
}

export function recommendedParlaySelection(
  candidates,
  {
    mode = "standard",
    minLegOdds = 0,
    currentMarkets = new Map(),
  } = {},
) {
  const selected = new Set();
  const markets = new Map(currentMarkets);

  for (const candidate of candidates || []) {
    if (mode === "goalsPair") {
      const goalsPair = candidate.markets?.goalsPair;
      if (
        goalsPair?.eligible &&
        goalsPair?.reliability?.level === "recommended"
      ) {
        selected.add(candidate.id);
        markets.set(candidate.id, "goalsPair");
      }
      continue;
    }

    const recommendedMarkets = [
      candidate.markets?.had,
      candidate.markets?.hhad,
    ].filter(
      (market) =>
        market &&
        Number(market.odds) >= minLegOdds &&
        market.reliability?.level === "recommended",
    );
    if (!recommendedMarkets.length) continue;

    const currentMarket = currentMarkets.get(candidate.id);
    const recommendedMarket =
      recommendedMarkets.find((market) => market.market === currentMarket) ||
      recommendedMarkets[0];
    selected.add(candidate.id);
    markets.set(candidate.id, recommendedMarket.market);
  }

  return { selected, markets };
}
