// A cost/overlap audit, not a probability model or a betting instruction.
export function summarizeParlayPortfolio(rows, selected, mode) {
  const fixtures = new Map();
  let groups = 0, ticketCount = 0, recordedGroups = 0;
  rows.forEach((combination, index) => {
    if (!selected.has(index)) return;
    const legs = combination.legs || [];
    if (!legs.length) return;
    const tickets = mode === "goalsPair"
      ? legs.reduce((n, leg) => n * new Set((leg.selections || []).map(s => String(s.label))).size, 1)
      : 1;
    if (!tickets) throw new Error("进球双选组合缺少有效选择，无法核对成本");
    groups += 1;
    ticketCount += tickets;
    if (combination.recorded) recordedGroups += 1;
    for (const leg of legs) {
      const id = String(leg.id);
      if (!fixtures.has(id)) fixtures.set(id, { id, home: leg.home, away: leg.away, league: leg.league, combinations: new Set(), conditions: new Map() });
      const fixture = fixtures.get(id);
      fixture.combinations.add(index);
      const market = mode === "goalsPair" ? "goalsPair" : leg.market;
      const labels = mode === "goalsPair"
        ? [...new Set(leg.selections.map(s => String(s.label)))].sort()
        : [String(leg.predicted)];
      const handicap = market === "hhad" ? Number(leg.handicap) : null;
      const key = JSON.stringify([market, handicap, labels]);
      if (!fixture.conditions.has(key)) fixture.conditions.set(key, { market, handicap, labels, combinations: [], costYuan: 0 });
      const condition = fixture.conditions.get(key);
      if (!condition.combinations.includes(index)) {
        condition.combinations.push(index);
        condition.costYuan += tickets * 2;
      }
    }
  });
  const entries = [...fixtures.values()].map(f => ({ ...f, combinations: [...f.combinations], conditions: [...f.conditions.values()] }))
    .sort((a, b) => b.combinations.length - a.combinations.length || a.id.localeCompare(b.id));
  return { groups, ticketCount, costYuan: ticketCount * 2, recordedGroups, fixtures: entries, repeatedFixtures: entries.filter(f => f.combinations.length > 1).length };
}
