import { normalizeTeamName } from "./fixture-name.mjs";

function editDistance(leftValue, rightValue) {
  const left = [...String(leftValue || "")];
  const right = [...String(rightValue || "")];
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

export function teamNameSimilarity(left, right) {
  const normalizedLeft = normalizeTeamName(left);
  const normalizedRight = normalizeTeamName(right);
  const size = Math.max([...normalizedLeft].length, [...normalizedRight].length);
  return size ? 1 - editDistance(normalizedLeft, normalizedRight) / size : 1;
}

export function diagnosePendingTeamNames(
  pendingFixtures,
  historicalTeams,
  { candidateLimit = 3 } = {},
) {
  const history = historicalTeams.map((row) => ({
    name: String(row.name || ""),
    league: String(row.league || ""),
    normalized: normalizeTeamName(row.name),
  }));
  const known = new Set(history.map((row) => row.normalized));
  const pending = new Map();
  for (const fixture of pendingFixtures) {
    for (const side of ["home", "away"]) {
      const name = String(fixture[side] || "");
      const normalized = normalizeTeamName(name);
      if (!name || known.has(normalized)) continue;
      const current = pending.get(normalized) || {
        name,
        normalized,
        leagues: new Set(),
        matchIds: new Set(),
      };
      current.leagues.add(String(fixture.league || ""));
      current.matchIds.add(String(fixture.matchId || ""));
      pending.set(normalized, current);
    }
  }

  return [...pending.values()]
    .map((row) => {
      const candidates = history
        .map((candidate) => ({
          name: candidate.name,
          league: candidate.league,
          sameLeague: row.leagues.has(candidate.league),
          similarity: teamNameSimilarity(row.name, candidate.name),
        }))
        .sort(
          (left, right) =>
            Number(right.sameLeague) - Number(left.sameLeague) ||
            right.similarity - left.similarity ||
            left.name.localeCompare(right.name, "zh-CN"),
        )
        .filter(
          (candidate, index, values) =>
            values.findIndex((value) => value.name === candidate.name) === index,
        )
        .slice(0, candidateLimit);
      return {
        name: row.name,
        normalized: row.normalized,
        leagues: [...row.leagues].filter(Boolean),
        pendingMatches: row.matchIds.size,
        candidates,
      };
    })
    .sort(
      (left, right) =>
        right.pendingMatches - left.pendingMatches ||
        left.name.localeCompare(right.name, "zh-CN"),
    );
}
