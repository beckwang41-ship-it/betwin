import { findSimilarSpf, spfDistance } from "./predictor.mjs";
import {
  parseScoreMargin,
  settleMargin,
} from "./three-way-coherence.mjs";

export const THREE_WAY_MATCHING_VERSION = "spf-hhad-score-margin-joint-v2";

function withDistance(rows, odds) {
  return rows
    .map((row) => ({
      ...row,
      distance: spfDistance(row.odds, odds),
    }))
    .sort((left, right) => left.distance - right.distance);
}

function coherentJointRow(
  row,
  hadOdds,
  hhadOdds,
  spfTolerance,
  hhadTolerance,
) {
  const score = row?.score ?? row?.spf?.score ?? row?.hhad?.score;
  const margin = parseScoreMargin(score);
  if (margin === null) return null;
  const spfRawDistance = spfDistance(row.spf.odds, hadOdds);
  const hhadRawDistance = spfDistance(row.hhad.odds, hhadOdds);
  const distance = Math.max(spfRawDistance, hhadRawDistance);
  const jointDistance = Math.max(
    spfRawDistance / Math.max(Number(spfTolerance), Number.EPSILON),
    hhadRawDistance / Math.max(Number(hhadTolerance), Number.EPSILON),
  );
  const handicap = Number(row.hhad.handicap);
  const common = {
    score,
    margin,
    jointHandicap: handicap,
    distance,
    jointDistance,
    jointWeight: 1,
    coherentJoint: true,
  };
  return {
    ...row,
    ...common,
    spf: {
      ...row.spf,
      ...common,
      result: settleMargin(margin, 0),
    },
    hhad: {
      ...row.hhad,
      ...common,
      result: settleMargin(margin, handicap),
    },
  };
}

export function selectThreeWaySimilarity(
  match,
  { spfHistory = [], hhadHistory = [], pairedHistory = [] },
  { spfTolerance, hhadTolerance, sameLeague = false },
) {
  const hadOdds = match.had
    ? [match.had.h, match.had.d, match.had.a]
    : null;
  const hhadOdds = match.hhad
    ? [match.hhad.h, match.hhad.d, match.hhad.a]
    : null;
  const handicap = match.hhad ? Number(match.hhad.goalLine) : null;
  const scopedSpfHistory = sameLeague
    ? spfHistory.filter((row) => row.league === match.league)
    : spfHistory;
  const scopedHhadHistory = sameLeague
    ? hhadHistory.filter((row) => row.league === match.league)
    : hhadHistory;
  const scopedPairedHistory = sameLeague
    ? pairedHistory.filter((row) => row.spf.league === match.league)
    : pairedHistory;
  const standaloneSpf = hadOdds
    ? findSimilarSpf(scopedSpfHistory, hadOdds, { tolerance: spfTolerance })
    : [];
  const standaloneHhad = hhadOdds
    ? findSimilarSpf(
        scopedHhadHistory.filter((row) => row.handicap === handicap),
        hhadOdds,
        { tolerance: hhadTolerance },
      )
    : [];

  if (hadOdds && hhadOdds) {
    const joint = scopedPairedHistory
      .filter(
        (row) =>
          row.hhad.handicap === handicap &&
          spfDistance(row.spf.odds, hadOdds) <= spfTolerance &&
          spfDistance(row.hhad.odds, hhadOdds) <= hhadTolerance,
      )
      .map((row) =>
        coherentJointRow(
          row,
          hadOdds,
          hhadOdds,
          spfTolerance,
          hhadTolerance,
        ),
      )
      .filter(Boolean)
      .sort((left, right) => left.jointDistance - right.jointDistance);
    if (joint.length) {
      return {
        spf: {
          similar: joint.map((row) => row.spf),
          mode: "joint",
          jointSamples: joint.length,
        },
        hhad: {
          similar: joint.map((row) => row.hhad),
          mode: "joint",
          jointSamples: joint.length,
        },
        jointRows: joint,
      };
    }
    return {
      spf: {
        similar: [],
        mode: "joint-unavailable",
        jointSamples: 0,
      },
      hhad: {
        similar: [],
        mode: "joint-unavailable",
        jointSamples: 0,
      },
      jointRows: [],
    };
  }

  return {
    spf: hadOdds
      ? { similar: standaloneSpf, mode: "standalone", jointSamples: 0 }
      : null,
    hhad: hhadOdds
      ? { similar: standaloneHhad, mode: "standalone", jointSamples: 0 }
      : null,
    jointRows: [],
  };
}
