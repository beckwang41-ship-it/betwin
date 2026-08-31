import test from "node:test";
import assert from "node:assert/strict";
import {
  modelConfigIsCurrent,
  resolveProductionThresholds,
} from "../lib/production-thresholds.mjs";

const state = {
  verifiedMatches: 100,
  sourceUpdatedAt: "2026-08-17T00:00:00Z",
  matchingVersion: "joint-v1",
};
const defaults = { spf: 0.07, hhad: 0.07, goals: 0.015 };

function config(overrides = {}) {
  return {
    data: {
      verifiedMatches: 100,
      sourceUpdatedAt: "2026-08-17T00:00:00Z",
    },
    methodology: { matchingVersion: "joint-v1" },
    markets: {
      spf: { threshold: 0.1 },
      hhad: { threshold: 0.1 },
      goals: { threshold: 0.02 },
    },
    ...overrides,
  };
}

test("current model config supplies production thresholds", () => {
  const value = config();
  assert.equal(modelConfigIsCurrent(value, state), true);
  assert.deepEqual(
    resolveProductionThresholds(value, state, defaults),
    { stale: false, values: { spf: 0.1, hhad: 0.1, goals: 0.02 } },
  );
});

test("stale model config falls back to the same defaults used by the server", () => {
  const value = config({
    data: { ...config().data, verifiedMatches: 99 },
  });
  assert.equal(modelConfigIsCurrent(value, state), false);
  assert.deepEqual(
    resolveProductionThresholds(value, state, defaults),
    { stale: true, values: defaults },
  );
});
