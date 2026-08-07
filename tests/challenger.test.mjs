import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  challengerFeatures,
  createChallenger,
  predictForest,
} from "../lib/challenger.mjs";
import { createDataStore } from "../lib/database.mjs";

const artifact = JSON.parse(
  readFileSync(
    new URL("../data/challenger-model.json", import.meta.url),
    "utf8",
  ),
);

test("exported random forests reproduce their Python self-test probabilities", () => {
  for (const market of ["spf", "hhad", "goals"]) {
    const actual = predictForest(
      artifact.markets[market].model,
      artifact.selfTest.features,
    );
    const expected = artifact.selfTest.predictions[market];
    assert.equal(actual.length, expected.length);
    for (let index = 0; index < actual.length; index += 1) {
      assert.ok(Math.abs(actual[index] - expected[index]) < 1e-8);
    }
  }
});

test("challenger builds finite multi-market features for current matches", () => {
  const store = createDataStore(
    new URL("../betwin.db", import.meta.url).pathname,
  );
  try {
    const match = store.getMatches()[0];
    const history = store.getVerifiedHistory();
    const features = challengerFeatures(
      match,
      artifact.featureSpec,
      history,
    );
    assert.equal(features.length, artifact.featureSpec.names.length);
    assert.ok(features.every(Number.isFinite));
    const sampleFeatures = artifact.featureSpec.names
      .map((name, index) => ({ name, value: features[index] }))
      .filter(({ name }) => name.endsWith("_sample_count"));
    assert.equal(sampleFeatures.length, 12);
    assert.ok(
      sampleFeatures.every(
        ({ value }) => Number.isInteger(value) && value >= 0,
      ),
    );

    const emptyFeatures = challengerFeatures(
      match,
      artifact.featureSpec,
      [],
    );
    for (const { name } of sampleFeatures) {
      const index = artifact.featureSpec.names.indexOf(name);
      assert.equal(emptyFeatures[index], 0);
    }

    const prediction = createChallenger(artifact).predict(match, history);
    for (const market of ["spf", "hhad", "goals"]) {
      const probabilities = prediction[market].probabilities;
      assert.ok(
        Math.abs(
          probabilities.reduce((sum, value) => sum + value, 0) - 1,
        ) < 1e-10,
      );
    }
  } finally {
    store.close();
  }
});
