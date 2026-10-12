import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { VALIDATION_LABELS, validationState, verdictSummary, marketEvidence } from "../public/reliability-presentation.js";
import { goalPairValidation } from "../lib/reliability.mjs";

test("双选独立校验报告、范围和本场筛选，平滑后的双选不能沿用旧验证", () => {
  const prediction = { goalPair: { available: true, probability: 0.55 }, stats: { total: 120 },
    reliability: { level: "recommended" } };
  const policy = { version: 2, generatedAt: "2026-10-05", validated: true, stale: false,
    selected: { rule: { minSamples: 100, minPairProbability: 0.5 } } };
  assert.equal(goalPairValidation(prediction, { policy }).status, "passed");
  for (const [change, status] of [[{ generatedAt: null }, "unvalidated"], [{ stale: true }, "stale"],
    [{ validated: false }, "not-passed"], [{ selected: { rule: { minSamples: 150, minPairProbability: 0.5 } } }, "insufficient"]]) {
    assert.equal(goalPairValidation(prediction, { policy: { ...policy, ...change } }).status, status);
  }
  for (const scope of [{ sameLeague: true }, { usesRecommendedThreshold: false }, { smoothingEnabled: true }]) {
    assert.equal(goalPairValidation(prediction, { policy, ...scope }).status, "unsupported-scope");
  }
  prediction.goalPair.probability = 0.4;
  assert.equal(goalPairValidation(prediction, { policy }).status, "not-selected");
});

test("明确区分未验证、过期、样本不足与本场未选中，不据此宣称没有提升", () => {
  for (const status of ["unvalidated", "stale", "insufficient", "not-passed", "not-selected", "unsupported-scope"]) {
    const prediction = { reliability: { validation: { status }, reason: "任意新文案" } };
    assert.equal(validationState(prediction, {}, "spf").status, status);
    const summary = verdictSummary([{ name: "胜平负", validation: { status } }]);
    assert.equal(summary.passed.length, 0);
    assert.ok(summary.text.includes(VALIDATION_LABELS[status]));
    assert.doesNotMatch(summary.text, /持平，没有更准|历史筛选并不比赔率更准|没有额外信息/);
  }
});

test("市场区间缺失、跨零、负向和正向证据不能混为一谈", () => {
  assert.equal(marketEvidence({ lower: null, upper: null }).status, "unknown");
  assert.equal(marketEvidence({ lower: -0.1, upper: 0.1 }).status, "inconclusive");
  assert.equal(marketEvidence({ lower: -0.1, upper: -0.01 }).status, "negative");
  assert.equal(marketEvidence({ lower: 0.01, upper: 0.1 }).status, "positive");
});

test("真实结论栏只读取双选自己的验证，不继承单选通过状态", () => {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { textContent: "2 / 3球" }); return nodes.get(id); };
  const context = vm.createContext({ $, state: {}, VALIDATION_LABELS, validationState, verdictSummary, escapeHtml: String });
  vm.runInContext(source.slice(source.indexOf("function renderVerdictStrip("), source.indexOf("function renderDecisionReliability(")), context);
  const goals = { available: true, reliability: { level: "recommended", validation: { status: "passed" } },
    goalPair: { validation: { status: "stale" } } };
  context.renderVerdictStrip(null, null, goals);
  assert.equal($("#match-verdict-strip").className, "match-verdict-strip observe reveal");
  assert.match($("#verdict-strip-markets").innerHTML, /验证已过期/);
  goals.reliability.level = "cautious";
  goals.goalPair.validation.status = "passed";
  context.renderVerdictStrip(null, null, goals);
  assert.match($("#verdict-strip-title").textContent, /总进球双选通过历史验证/);
  assert.doesNotMatch($("#verdict-strip-text").textContent, /比赔率更准/);
});
