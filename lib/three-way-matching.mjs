import { findSimilarSpf, spfDistance } from "./predictor.mjs";

export const THREE_WAY_MATCHING_VERSION = "spf-hhad-joint-v1";

function withDistance(rows, odds) {
  return rows
    .map((row) => ({
      ...row,
      distance: spfDistance(row.odds, odds),
    }))
    .sort((left, right) => left.distance - right.distance);
}

export function selectThreeWaySimilarity(
  match,
  { spfHistory = [], hhadHistory = [], pairedHistory = [] },
  { spfTolerance, hhadTolerance },
) {
  const hadOdds = match.had
    ? [match.had.h, match.had.d, match.had.a]
    : null;
  const hhadOdds = match.hhad
    ? [match.hhad.h, match.hhad.d, match.hhad.a]
    : null;
  const handicap = match.hhad ? Number(match.hhad.goalLine) : null;
  const standaloneSpf = hadOdds
    ? findSimilarSpf(spfHistory, hadOdds, { tolerance: spfTolerance })
    : [];
  const standaloneHhad = hhadOdds
    ? findSimilarSpf(
        hhadHistory.filter((row) => row.handicap === handicap),
        hhadOdds,
        { tolerance: hhadTolerance },
      )
    : [];

  if (hadOdds && hhadOdds) {
    const joint = pairedHistory.filter(
      (row) =>
        row.hhad.handicap === handicap &&
        spfDistance(row.spf.odds, hadOdds) <= spfTolerance &&
        spfDistance(row.hhad.odds, hhadOdds) <= hhadTolerance,
    );
    if (joint.length) {
      return {
        spf: {
          similar: withDistance(
            joint.map((row) => row.spf),
            hadOdds,
          ),
          mode: "joint",
          jointSamples: joint.length,
        },
        hhad: {
          similar: withDistance(
            joint.map((row) => row.hhad),
            hhadOdds,
          ),
          mode: "joint",
          jointSamples: joint.length,
        },
      };
    }
    return {
      spf: {
        similar: standaloneSpf,
        mode: "standalone-fallback",
        jointSamples: 0,
      },
      hhad: {
        similar: standaloneHhad,
        mode: "standalone-fallback",
        jointSamples: 0,
      },
    };
  }

  return {
    spf: hadOdds
      ? { similar: standaloneSpf, mode: "standalone", jointSamples: 0 }
      : null,
    hhad: hhadOdds
      ? { similar: standaloneHhad, mode: "standalone", jointSamples: 0 }
      : null,
  };
}
