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

function scoreCombination(legs) {
  const combinedOdds = legs.reduce((total, leg) => total * leg.odds, 1);
  const hitProbability = legs.reduce(
    (total, leg) => total * leg.probability,
    1,
  );
  return {
    id: legs.map((leg) => leg.id).join("__"),
    legs,
    combinedOdds: round(combinedOdds, 2),
    hitProbability: round(hitProbability, 6),
    valueIndex: round(combinedOdds * hitProbability, 3),
  };
}

function comparator(sort, targetOdds) {
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
    sort = "value",
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
  for (const left of legs[0].selections) {
    for (const right of legs[1].selections) {
      const combinedOdds = round(left.odds * right.odds, 2);
      const probability = round(left.probability * right.probability, 6);
      tickets.push({
        id: `${legs[0].id}:${left.label}__${legs[1].id}:${right.label}`,
        selections: [
          { matchId: legs[0].id, label: left.label, odds: left.odds },
          { matchId: legs[1].id, label: right.label, odds: right.odds },
        ],
        combinedOdds,
        probability,
        expectedReturn: round(probability * combinedOdds, 4),
      });
    }
  }
  return tickets;
}

function scoreGoalPairCombination(legs) {
  const tickets = goalPairTickets(legs);
  const totalStake = tickets.length;
  const hitProbability = legs.reduce(
    (total, leg) => total * leg.probability,
    1,
  );
  const expectedReturn = tickets.reduce(
    (total, ticket) => total + ticket.expectedReturn,
    0,
  );
  const ticketOdds = tickets.map((ticket) => ticket.combinedOdds);
  const legProbabilities = legs.map((leg) => Number(leg.probability));
  return {
    id: legs.map((leg) => leg.id).join("__"),
    legs,
    tickets,
    ticketCount: tickets.length,
    totalStake,
    hitProbability: round(hitProbability, 6),
    averageLegCoverage: round(
      legProbabilities.reduce((total, value) => total + value, 0) /
        legProbabilities.length,
      6,
    ),
    minimumLegCoverage: round(Math.min(...legProbabilities), 6),
    minimumTicketOdds: Math.min(...ticketOdds),
    maximumTicketOdds: Math.max(...ticketOdds),
    expectedReturn: round(expectedReturn, 3),
    expectedProfit: round(expectedReturn - totalStake, 3),
    valueIndex: round(expectedReturn / totalStake, 3),
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
    right.minimumLegCoverage - left.minimumLegCoverage ||
    right.averageLegCoverage - left.averageLegCoverage ||
    right.valueIndex - left.valueIndex;
}

export function generateGoalPairParlays(
  candidates,
  { sort = "probability", limit = 20 } = {},
) {
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
  const allRows = choose(eligible, 2).map(scoreGoalPairCombination);
  const sortedRows = allRows.sort(goalPairComparator(sort));
  return {
    rows: sortedRows.slice(0, safeLimit),
    total: allRows.length,
    eligible: allRows.length,
    settings: {
      mode: "goalsPair",
      legs: 2,
      sort,
      limit: safeLimit,
      stakePerCombination: 4,
      oddsFilter: false,
    },
  };
}
