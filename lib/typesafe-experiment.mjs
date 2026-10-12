import { prepareContextRows } from "./context-experiment.mjs";
import { pilotFeatures, pilotSelect } from "./context-pilot.mjs";
import { typesafeHash, typesafeState, judgmentKey, TYPESAFE_CONTEXT_HASH } from "./typesafe-context.mjs";
import { blockBootstrapFixtureMean } from "./significance.mjs";

export const TYPESAFE_EXPERIMENT = Object.freeze({
  version: "context-typesafe-e-v3-target-priority", minimumTraining: 20, epochs: 100, learningRate: 0.1, l2: 0.5,
  trainingRequestsPerRun: 24, contextProtocol: TYPESAFE_CONTEXT_HASH,
  productionChanged: false, crossMarketCoherence: "independent-experimental-corrections",
});
export function typesafeRows(records) {
  const prepared = prepareContextRows(records), originals = new Map(records.map(r => [r.id, r]));
  return [...prepared.groups.values()].flat().map(row => {
    const form = JSON.parse(originals.get(row.id).settings_json).recentForm;
    const state = typesafeState(form, row);
    return { ...row, state, stateKey: judgmentKey(state) };
  });
}
export function experimentalVector(row, includeTypesafe) {
  const f = pilotFeatures(row.features, row.market);
  const values = [...Object.values(f.state), ...Object.values(f.history)];
  if (includeTypesafe) {
    if (!row.judgment?.features || row.judgment.protocol !== TYPESAFE_CONTEXT_HASH) throw new Error("缺少同版本TypeSafe特征");
    values.push(...Object.values(row.judgment.features));
  }
  if (values.some(v => !Number.isFinite(v))) throw new Error("E组特征无效");
  return values;
}
function probabilities(row, model, includeTypesafe) {
  const x = experimentalVector(row, includeTypesafe);
  const z = row.p.map((p, k) => Math.log(Math.max(1e-8, p)) + model[k].reduce((s, w, j) => s + w * x[j], 0));
  const max = Math.max(...z), ex = z.map(v => Math.exp(v - max)), sum = ex.reduce((s, v) => s + v, 0);
  return ex.map(v => v / sum);
}
function fit(rows, includeTypesafe) {
  const weights = rows[0].p.map(() => experimentalVector(rows[0], includeTypesafe).map(() => 0));
  for (let epoch = 0; epoch < TYPESAFE_EXPERIMENT.epochs; epoch++) {
    const gradient = weights.map(ws => ws.map(w => w * TYPESAFE_EXPERIMENT.l2));
    for (const row of rows) {
      const x = experimentalVector(row, includeTypesafe), p = probabilities(row, weights, includeTypesafe);
      for (let k = 0; k < p.length; k++) for (let j = 0; j < x.length; j++) gradient[k][j] += (p[k] - Number(row.y === k)) * x[j] / rows.length;
    }
    for (let k = 0; k < weights.length; k++) for (let j = 0; j < weights[k].length; j++) weights[k][j] -= TYPESAFE_EXPERIMENT.learningRate * gradient[k][j];
  }
  return weights;
}
export function predictTypesafeExperiment(rows, targets, { forecastAt = new Date().toISOString() } = {}) {
  const now = Date.parse(forecastAt), excluded = new Set(targets.map(t => String(t.matchId)));
  if (!Number.isFinite(now)) throw new Error("E组预测时间无效");
  const models = new Map(), forecasts = [], unavailable = [];
  for (const target of targets) {
    pilotSelect(target.p, target.market);
    if (!Number.isFinite(target.capture) || target.capture > now) throw new Error("E组基线时间无效");
    if (!target.judgment?.available) { unavailable.push({ matchId: target.matchId, market: target.market, reason: target.judgment?.reason || "TypeSafe特征不可用" }); continue; }
    const training = rows.filter(r => r.market === target.market && r.algorithmVersion === target.algorithmVersion &&
      r.status === "settled" && r.capture < target.capture && r.settled < target.capture && r.settled < now &&
      !excluded.has(String(r.matchId)) && r.judgment?.available);
    if (training.length < TYPESAFE_EXPERIMENT.minimumTraining) {
      unavailable.push({ matchId: target.matchId, market: target.market, reason: `E组有效训练${training.length}/${TYPESAFE_EXPERIMENT.minimumTraining}场，保留原预测` }); continue;
    }
    const id = typesafeHash({ market: target.market, version: target.algorithmVersion, protocol: TYPESAFE_EXPERIMENT,
      rows: training.map(r => [r.id, r.contextHash, r.p, r.y, r.judgment.key]) });
    if (!models.has(id)) models.set(id, { id, market: target.market, training: training.length,
      trainingRows: training.map(r => ({ id: r.id, matchId: r.matchId, capture: r.capture, settled: r.settled, p: r.p, y: r.y,
        stateKey: r.judgment.key, dVector: experimentalVector(r, false), eVector: experimentalVector(r, true) })),
      coefficients: { Dcontrol: fit(training, false), E: fit(training, true) } });
    const model = models.get(id);
    forecasts.push({ ...target, forecastAt, fitId: id, training: training.length,
      status: "experimental-not-production", productionChanged: false,
      predictions: { ...target.predictions, A: pilotSelect(target.p, target.market),
        Dcontrol: pilotSelect(probabilities(target, model.coefficients.Dcontrol, false), target.market),
        E: pilotSelect(probabilities(target, model.coefficients.E, true), target.market) } });
  }
  return { forecasts, unavailable, models: [...models.values()] };
}

const top = p => p.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v || a.i - b.i).map(r => r.i);
function metrics(cases, arm, market) {
  if (!cases.length) return null;
  let hits = 0, pairHits = 0, logLoss = 0, brier = 0;
  for (const c of cases) {
    const p = c.predictions[arm].probabilities, order = top(p);
    hits += Number(order[0] === c.y); pairHits += Number(order.slice(0, 2).includes(c.y));
    logLoss -= Math.log(Math.max(1e-8, p[c.y])); brier += p.reduce((s, v, i) => s + (v - Number(i === c.y)) ** 2, 0);
  }
  return { samples: cases.length, hits, accuracy: hits / cases.length, logLoss: logLoss / cases.length, brier: brier / cases.length,
    ...(market === "goals" ? { pairHits, pairHitRate: pairHits / cases.length } : {}) };
}
export function evaluateTypesafeForecasts(forecasts, records, manifest) {
  const settled = new Map(typesafeRows(records).filter(r => r.status === "settled").map(r => [`${r.market}|${r.algorithmVersion}|${r.matchId}`, r]));
  const known = new Set(manifest.knownSettledMatchIds.map(String)), groups = new Map(), seen = new Set();
  for (const p of [...forecasts].sort((a, b) => Date.parse(a.forecastAt) - Date.parse(b.forecastAt))) {
    const key = `${p.market}|${p.algorithmVersion}|${p.matchId}`, r = settled.get(key), time = Date.parse(p.forecastAt);
    if (p.protocolFingerprint !== manifest.fingerprint || !r || seen.has(key) || known.has(String(p.matchId)) ||
      !Number.isFinite(time) || time < Date.parse(manifest.activatedAt) || time >= r.settled) continue;
    if (!["A", "D", "Dcontrol", "E"].every(a => p.predictions?.[a])) continue;
    for (const a of ["A", "D", "Dcontrol", "E"]) pilotSelect(p.predictions[a].probabilities, p.market);
    seen.add(key);
    const groupKey = `${p.market}|${p.algorithmVersion}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ ...p, y: r.y });
  }
  return [...groups].map(([groupKey, cases]) => {
    const market = cases[0].market;
    const paired = Object.fromEntries(["A", "D", "Dcontrol"].map(base => [base, Object.fromEntries(
      ["accuracy", "logLoss", "brier", ...(market === "goals" ? ["pairHit"] : [])].map(metric => {
        const values = cases.map(c => {
          const p = c.predictions.E.probabilities, b = c.predictions[base].probabilities;
          const value = metric === "accuracy" ? Number(top(p)[0] === c.y) - Number(top(b)[0] === c.y)
            : metric === "pairHit" ? Number(top(p).slice(0, 2).includes(c.y)) - Number(top(b).slice(0, 2).includes(c.y))
              : metric === "logLoss" ? Math.log(Math.max(1e-8, p[c.y])) - Math.log(Math.max(1e-8, b[c.y]))
                : b.reduce((s, v, i) => s + (v - Number(i === c.y)) ** 2 - (p[i] - Number(i === c.y)) ** 2, 0);
          return { fixtureId: c.matchId, sourceFile: "typesafe-frozen", order: Date.parse(c.forecastAt), value };
        });
        return [metric, blockBootstrapFixtureMean(values, { iterations: 1000, blockSize: 10 })];
      })
    )]));
    return { groupKey, market, evaluated: cases.length, metrics: Object.fromEntries(["A", "D", "Dcontrol", "E"].map(a => [a, metrics(cases, a, market)])),
      pairedImprovement: paired, status: "research-only", cases };
  });
}
