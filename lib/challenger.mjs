import { productionGoalFeaturePools } from "./goal-production.mjs";

function validOdds(values, expectedLength) {
  return (
    Array.isArray(values) &&
    values.length === expectedLength &&
    values.every((value) => Number(value) > 1)
  );
}

function normalizedOdds(odds) {
  const implied = odds.map((value) => 1 / Number(value));
  const overround = implied.reduce((sum, value) => sum + value, 0);
  return {
    probabilities: implied.map((value) => value / overround),
    overround,
  };
}

function goalExpectation(probabilities) {
  const values = [0, 1, 2, 3, 4, 5, 6, 7.5];
  return probabilities.reduce(
    (sum, probability, index) =>
      sum + probability * values[index],
    0,
  );
}

function rmsDistance(left, right) {
  return Math.sqrt(
    left.reduce((sum, value, index) => {
      const delta = value - right[index];
      return sum + delta * delta;
    }, 0) / left.length,
  );
}

function threeWayDistance(historyOdds, targetOdds) {
  return Math.max(
    ...historyOdds.map((value, index) =>
      Math.abs(Number(value) / Number(targetOdds[index]) - 1),
    ),
  );
}

function goalDistance(historyOdds, targetOdds) {
  const history = normalizedOdds(historyOdds).probabilities;
  const target = normalizedOdds(targetOdds).probabilities;
  return Math.max(
    ...history.map((value, index) => Math.abs(value - target[index])),
  );
}

function threeWayOdds(market) {
  return market
    ? [Number(market.h), Number(market.d), Number(market.a)]
    : null;
}

function goalOdds(market) {
  return market
    ? [
        market.g0,
        market.g1,
        market.g2,
        market.g3,
        market.g4,
        market.g5,
        market.g6,
        market.g7plus,
      ].map(Number)
    : null;
}

function marketInput(match, market) {
  if (market === "spf") {
    const finalOdds = threeWayOdds(match.had);
    const initialOdds = threeWayOdds(match.had?.history?.initial);
    return {
      finalOdds,
      initialOdds,
      initialAvailable:
        validOdds(initialOdds, 3) &&
        (match.had?.history?.timeline?.length || 0) > 1,
    };
  }
  if (market === "hhad") {
    const finalOdds = threeWayOdds(match.hhad);
    const initialOdds = threeWayOdds(match.hhad?.history?.initial);
    return {
      finalOdds,
      initialOdds,
      initialAvailable:
        validOdds(initialOdds, 3) &&
        (match.hhad?.history?.timeline?.length || 0) > 1,
    };
  }
  const finalOdds = goalOdds(match.goals);
  const initialOdds = goalOdds(match.goals?.history?.initial);
  return {
    finalOdds,
    initialOdds,
    initialAvailable:
      validOdds(initialOdds, 8) &&
      (match.goals?.history?.timeline?.length || 0) > 1,
  };
}

function historicalOutcomeIndex(market, row) {
  if (market === "spf") {
    return ["胜", "平", "负"].indexOf(String(row.spf?.result));
  }
  if (market === "hhad") {
    return ["胜", "平", "负"].indexOf(String(row.hhad?.result));
  }
  const value = String(row.goals);
  if (value === "7+" || Number(value) >= 7) return 7;
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : -1;
}

function historicalMarketOdds(market, row) {
  if (market === "spf") return row.spf?.odds;
  if (market === "hhad") return row.hhad?.odds;
  return row.goalMarket?.odds;
}

function distributionFeatures(rows, tolerances, size) {
  const values = [];
  const directions = [];
  let availableBands = 0;
  for (const tolerance of tolerances) {
    const matches = rows.filter((row) => row.distance <= tolerance);
    const sampleCount = matches.length;
    let probabilities;
    let entropy;
    let margin;
    let missing;
    if (sampleCount) {
      const counts = Array(size).fill(0);
      for (const row of matches) counts[row.outcome] += 1;
      probabilities = counts.map((count) => count / sampleCount);
      entropy =
        -probabilities
          .filter((probability) => probability > 0)
          .reduce(
            (sum, probability) =>
              sum + probability * Math.log(probability),
            0,
          ) / Math.log(size);
      const sorted = [...probabilities].sort((left, right) => left - right);
      margin = sorted.at(-1) - sorted.at(-2);
      const maximum = Math.max(...probabilities);
      const top = probabilities
        .map((probability, index) => ({ probability, index }))
        .filter(({ probability }) => Math.abs(probability - maximum) <= 1e-12);
      if (top.length === 1) directions.push(top[0].index);
      availableBands += 1;
      missing = 0;
    } else {
      probabilities = Array(size).fill(1 / size);
      entropy = 1;
      margin = 0;
      missing = 1;
    }
    values.push(
      ...probabilities,
      sampleCount,
      Math.log1p(sampleCount),
      missing,
      entropy,
      margin,
    );
  }

  let stable = 0;
  let consensusShare = 0;
  if (directions.length) {
    const counts = new Map();
    for (const direction of directions) {
      counts.set(direction, (counts.get(direction) || 0) + 1);
    }
    consensusShare = Math.max(...counts.values()) / directions.length;
    stable =
      directions.length === tolerances.length && counts.size === 1 ? 1 : 0;
  }
  values.push(availableBands, stable, consensusShare);
  return values;
}

function productionPoolFeatures(pools, fractions, size) {
  const values = [];
  const directions = [];
  let availableBands = 0;
  for (const fraction of fractions) {
    const pool = pools.find(
      (item) => Math.abs(Number(item.fraction) - Number(fraction)) <= 1e-12,
    );
    const sampleCount = Number(pool?.sampleCount || 0);
    const poolProbabilities = Array.isArray(pool?.probabilities)
      ? pool.probabilities.map(Number)
      : [];
    const available =
      sampleCount > 0 &&
      poolProbabilities.length === size &&
      poolProbabilities.every((value) => Number.isFinite(value) && value >= 0) &&
      poolProbabilities.reduce((sum, value) => sum + value, 0) > 0;
    let probabilities;
    let entropy;
    let margin;
    let missing;
    if (available) {
      probabilities = poolProbabilities;
      entropy =
        -probabilities
          .filter((probability) => probability > 0)
          .reduce(
            (sum, probability) => sum + probability * Math.log(probability),
            0,
          ) / Math.log(size);
      const sorted = [...probabilities].sort((left, right) => left - right);
      margin = sorted.at(-1) - sorted.at(-2);
      const maximum = Math.max(...probabilities);
      const top = probabilities
        .map((probability, index) => ({ probability, index }))
        .filter(({ probability }) => Math.abs(probability - maximum) <= 1e-12);
      if (top.length === 1) directions.push(top[0].index);
      availableBands += 1;
      missing = 0;
    } else {
      probabilities = Array(size).fill(1 / size);
      entropy = 1;
      margin = 0;
      missing = 1;
    }
    values.push(
      ...probabilities,
      sampleCount,
      Math.log1p(sampleCount),
      missing,
      entropy,
      margin,
    );
  }

  let stable = 0;
  let consensusShare = 0;
  if (directions.length) {
    const counts = new Map();
    for (const direction of directions) {
      counts.set(direction, (counts.get(direction) || 0) + 1);
    }
    consensusShare = Math.max(...counts.values()) / directions.length;
    stable = directions.length === fractions.length && counts.size === 1 ? 1 : 0;
  }
  values.push(availableBands, stable, consensusShare);
  return values;
}

function historicalSimilarityFeatures(match, featureSpec, history) {
  const thresholds = featureSpec?.historicalThresholds || {};
  const allowedSources = new Set(featureSpec?.historySources || []);
  const pairedHistory = Array.isArray(history) ? history : history?.paired;
  const goalHistory = Array.isArray(history) ? history : history?.goals;
  const sourceRows = Array.isArray(pairedHistory)
    ? pairedHistory.filter(
        (row) =>
          !allowedSources.size || allowedSources.has(row.spfSourceFile),
      )
    : [];
  const targetOdds = {
    spf: threeWayOdds(match.had),
    hhad: threeWayOdds(match.hhad),
    goals: goalOdds(match.goals),
  };
  const handicap = Number(match.hhad?.goalLine);
  const values = [];

  for (const [market, size] of [
    ["spf", 3],
    ["hhad", 3],
    ["goals", 8],
  ]) {
    if (market === "goals" && featureSpec?.goalProductionMatching) {
      const input = marketInput(match, "goal");
      const target = {
        league: match.league,
        odds: input.finalOdds,
        initialOdds: input.initialAvailable ? input.initialOdds : null,
      };
      const pools = validOdds(input.finalOdds, 8)
        ? productionGoalFeaturePools(
            Array.isArray(goalHistory) ? goalHistory : [],
            target,
          ).pools
        : [];
      values.push(
        ...productionPoolFeatures(
          pools,
          featureSpec.goalPoolFractions || [0.25, 0.5, 0.75, 1],
          8,
        ),
      );
      continue;
    }
    const tolerances = thresholds[market] || [];
    const target = targetOdds[market];
    const rows = [];
    if (validOdds(target, size)) {
      for (const row of sourceRows) {
        if (
          market === "hhad" &&
          Number(row.hhad?.handicap) !== handicap
        ) {
          continue;
        }
        const odds = historicalMarketOdds(market, row);
        const outcome = historicalOutcomeIndex(market, row);
        if (!validOdds(odds, size) || outcome < 0 || outcome >= size) continue;
        rows.push({
          outcome,
          distance:
            market === "goals"
              ? goalDistance(odds, target)
              : threeWayDistance(odds, target),
        });
      }
    }
    values.push(...distributionFeatures(rows, tolerances, size));
  }
  return values;
}

export function challengerFeatures(match, featureSpec, history = []) {
  const values = [];
  const probabilities = {};
  for (const [market, size] of [
    ["spf", 3],
    ["hhad", 3],
    ["goal", 8],
  ]) {
    const source = marketInput(match, market);
    if (!validOdds(source.finalOdds, size)) {
      throw new Error(`挑战模型缺少${market}终赔`);
    }
    const initialOdds = source.initialAvailable
      ? source.initialOdds
      : source.finalOdds;
    const final = normalizedOdds(source.finalOdds);
    const initial = normalizedOdds(initialOdds);
    probabilities[market] = {
      final: final.probabilities,
      initial: initial.probabilities,
    };
    values.push(...final.probabilities);
    values.push(...initial.probabilities);
    values.push(
      ...final.probabilities.map(
        (value, index) => value - initial.probabilities[index],
      ),
    );
    values.push(...source.finalOdds.map((value) => Math.log(value)));
    values.push(...initialOdds.map((value) => Math.log(value)));
    values.push(
      final.overround,
      initial.overround,
      source.initialAvailable ? 0 : 1,
    );
  }

  const handicap = Number(match.hhad?.goalLine);
  const spfFinal = probabilities.spf.final;
  const hhadFinal = probabilities.hhad.final;
  values.push(
    Number.isFinite(handicap) ? handicap : 0,
    goalExpectation(probabilities.goal.final),
    goalExpectation(probabilities.goal.initial),
    spfFinal[0] - hhadFinal[0],
    spfFinal[1] - hhadFinal[1],
    spfFinal[2] - hhadFinal[2],
  );
  const leagues = featureSpec?.leagues || [];
  values.push(...leagues.map((league) => (league === match.league ? 1 : 0)));
  values.push(leagues.includes(match.league) ? 0 : 1);
  values.push(...historicalSimilarityFeatures(match, featureSpec, history));

  if (values.length !== featureSpec?.names?.length) {
    throw new Error(
      `挑战模型特征数量不一致：生成${values.length}，模型要求${featureSpec?.names?.length || 0}`,
    );
  }
  if (!values.every(Number.isFinite)) {
    throw new Error("挑战模型特征包含无效数字");
  }
  return values;
}

function temperatureScale(probabilities, temperature) {
  const safeTemperature = Math.max(0.01, Number(temperature) || 1);
  const powered = probabilities.map(
    (value) => Math.max(1e-12, value) ** (1 / safeTemperature),
  );
  const total = powered.reduce((sum, value) => sum + value, 0);
  return powered.map((value) => value / total);
}

export function predictForest(model, features) {
  if (!model?.trees?.length) return [];
  const probabilities = model.labels.map(() => 0);
  for (const tree of model.trees) {
    let node = 0;
    while (tree.feature[node] >= 0) {
      node =
        features[tree.feature[node]] <= tree.threshold[node]
          ? tree.left[node]
          : tree.right[node];
    }
    const leaf = tree.value[node] || [];
    for (let index = 0; index < model.classes.length; index += 1) {
      const outputIndex = Number(model.classes[index]);
      probabilities[outputIndex] += Number(leaf[index] || 0);
    }
  }
  const averaged = probabilities.map(
    (value) => value / model.trees.length,
  );
  return temperatureScale(averaged, model.temperature);
}

export function createChallenger(modelArtifact) {
  return {
    predict(match, history = []) {
      const features = challengerFeatures(
        match,
        modelArtifact.featureSpec,
        history,
      );
      return Object.fromEntries(
        ["spf", "hhad", "goals"].map((market) => {
          const artifact = modelArtifact.markets?.[market];
          return [
            market,
            artifact?.model
              ? {
                  probabilities: predictForest(artifact.model, features),
                  labels: artifact.model.labels,
                  selectedCandidate: artifact.selectedCandidate,
                }
              : null,
          ];
        }),
      );
    },
  };
}
