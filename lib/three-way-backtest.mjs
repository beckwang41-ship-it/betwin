import { selectThreeWaySimilarity } from "./three-way-matching.mjs";

const historyPoolCache = new WeakMap();

function eventKey(row) {
  return `${row.sourceFile}\u0000${row.sourceRow}`;
}

export function buildThreeWayEvents({
  spfHistory = [],
  hhadHistory = [],
  pairedHistory = [],
}) {
  const events = new Map();
  const ensure = (row) => {
    const key = eventKey(row);
    if (!events.has(key)) {
      events.set(key, {
        sourceFile: row.sourceFile,
        sourceRow: row.sourceRow,
        league: row.league,
        home: row.home,
        away: row.away,
        spf: null,
        hhad: null,
        pair: null,
      });
    }
    return events.get(key);
  };
  for (const row of spfHistory) ensure(row).spf = row;
  for (const row of hhadHistory) ensure(row).hhad = row;
  for (const row of pairedHistory) {
    const event = ensure(row);
    event.spf = event.spf || row.spf;
    event.hhad = event.hhad || row.hhad;
    event.pair = row;
  }
  return [...events.values()].sort(
    (left, right) =>
      left.sourceFile.localeCompare(right.sourceFile) ||
      left.sourceRow - right.sourceRow,
  );
}

function matchFromEvent(event) {
  return {
    had: event.spf
      ? {
          h: event.spf.odds[0],
          d: event.spf.odds[1],
          a: event.spf.odds[2],
        }
      : null,
    hhad: event.hhad
      ? {
          h: event.hhad.odds[0],
          d: event.hhad.odds[1],
          a: event.hhad.odds[2],
          goalLine: event.hhad.handicap,
        }
      : null,
  };
}

function poolsFromEvents(events) {
  if (historyPoolCache.has(events)) return historyPoolCache.get(events);
  const pools = {
    spfHistory: events.flatMap((event) => event.spf || []),
    hhadHistory: events.flatMap((event) => event.hhad || []),
    pairedHistory: events.flatMap((event) => event.pair || []),
  };
  historyPoolCache.set(events, pools);
  return pools;
}

export function threeWaySamplesForThreshold(
  target,
  history,
  market,
  threshold,
  fixedOtherThreshold,
) {
  const selection = selectThreeWaySimilarity(
    matchFromEvent(target),
    poolsFromEvents(history),
    {
      spfTolerance: market === "spf" ? threshold : fixedOtherThreshold,
      hhadTolerance: market === "hhad" ? threshold : fixedOtherThreshold,
    },
  );
  return selection[market]?.similar || [];
}
