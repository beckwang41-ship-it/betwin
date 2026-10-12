// Presentation only: count the complete selected pool before API pagination.
export function summarizeSampleOrigins(rows, { league = "", mode = "standalone", effectiveSamples = null } = {}) {
  const counts = new Map();
  let sameLeague = 0;
  for (const row of rows) {
    const name = row.league || "联赛未知";
    counts.set(name, (counts.get(name) || 0) + 1);
    if (league && row.league === league) sameLeague += 1;
  }
  return {
    total: rows.length, sameLeague, otherLeagues: rows.length - sameLeague,
    effectiveSamples: effectiveSamples == null ? null : Number(effectiveSamples), mode,
    leagues: [...counts].map(([league, count]) => ({ league, count, share: count / rows.length }))
      .sort((a, b) => b.count - a.count || a.league.localeCompare(b.league, "zh-CN")),
  };
}
