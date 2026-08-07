import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectTopGoalPair } from "../lib/predictor.mjs";
import {
  loadGoalRows,
  runGoals,
} from "./rolling_backtest.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const OUTPUT_PATH = path.join(ROOT, "data", "goal-pair-selection.json");
const GOAL_TOLERANCE = 0.015;
const WARMUP = 500;

function segment(cases, start, end) {
  return cases.slice(
    Math.floor(cases.length * start),
    Math.floor(cases.length * end),
  );
}

function enrich(item) {
  const pair = selectTopGoalPair(item.modelProbabilities, item.odds);
  return {
    ...item,
    pair,
    hit: pair.indices.includes(item.actualIndex),
  };
}

function metrics(cases, rule = null) {
  const selected = rule
    ? cases.filter(
        (item) =>
          item.pair.probability >= rule.minPairProbability &&
          item.sampleSize >= rule.minSamples,
      )
    : cases;
  const correct = selected.filter((item) => item.hit).length;
  return {
    available: cases.length,
    selected: selected.length,
    coverage: cases.length ? selected.length / cases.length : 0,
    correct,
    accuracy: selected.length ? correct / selected.length : 0,
    averagePairProbability: selected.length
      ? selected.reduce((sum, item) => sum + item.pair.probability, 0) /
        selected.length
      : 0,
  };
}

function passesSegment(candidate, baseline, minimumSelected) {
  return (
    candidate.selected >= minimumSelected &&
    candidate.accuracy >= 0.52 &&
    candidate.accuracy >= baseline.accuracy + 0.02
  );
}

const db = new DatabaseSync(DATABASE_PATH, { readOnly: true });
try {
  const run = runGoals(
    loadGoalRows(db),
    WARMUP,
    GOAL_TOLERANCE,
    1,
    1,
  );
  const cases = run.cases.map(enrich);
  const training = segment(cases, 0, 0.6);
  const calibration = segment(cases, 0.6, 0.8);
  const test = segment(cases, 0.8, 1);
  const baselines = {
    training: metrics(training),
    calibration: metrics(calibration),
    test: metrics(test),
  };
  const candidates = [];
  for (const minPairProbability of [
    0.46, 0.47, 0.48, 0.49, 0.5, 0.51, 0.52, 0.53, 0.54, 0.55,
  ]) {
    for (const minSamples of [1, 50, 100, 200, 500]) {
      const rule = { minPairProbability, minSamples };
      const trainingMetrics = metrics(training, rule);
      if (
        trainingMetrics.selected < 200 ||
        trainingMetrics.coverage < 0.03 ||
        trainingMetrics.coverage > 0.5
      ) {
        continue;
      }
      candidates.push({
        rule,
        training: trainingMetrics,
        calibration: metrics(calibration, rule),
        test: metrics(test, rule),
      });
    }
  }
  candidates.sort(
    (left, right) =>
      right.training.accuracy - left.training.accuracy ||
      right.training.selected - left.training.selected,
  );
  const selected = candidates[0] || null;
  const gate = selected
    ? {
        passed:
          passesSegment(selected.calibration, baselines.calibration, 60) &&
          passesSegment(selected.test, baselines.test, 60),
        calibrationPassed: passesSegment(
          selected.calibration,
          baselines.calibration,
          60,
        ),
        testPassed: passesSegment(selected.test, baselines.test, 60),
      }
    : {
        passed: false,
        calibrationPassed: false,
        testPassed: false,
      };
  gate.reason = !selected
    ? "较早60%数据没有找到可供风险分析的前两名双选分层规则"
    : gate.passed
      ? "历史前两名双选的高覆盖分层在中间20%和最新20%均达到至少52%命中率，并较全量双选提高至少2个百分点；仅作风险提示"
      : "历史前两名双选的高覆盖分层未能在中间20%和最新20%同时保持至少52%命中率及2个百分点提升；仅作风险提示";

  const sourceUpdatedAt = db
    .prepare("SELECT MAX(imported_at) AS value FROM source_files")
    .get()?.value;
  const output = {
    version: 2,
    generatedAt: new Date().toISOString(),
    strategy: "top-two-historical-results",
    data: {
      sourceUpdatedAt,
      evaluated: cases.length,
      split: "较早60%选择 / 中间20%校准 / 最新20%测试",
      discipline:
        "每场仅使用同来源中更早的历史行；规则只在较早60%选择",
    },
    settings: {
      goalTolerance: GOAL_TOLERANCE,
      warmup: WARMUP,
      minimumAccuracy: 0.52,
      minimumLift: 0.02,
      minimumLaterSamples: 60,
    },
    baseline: baselines,
    selected,
    gate,
    candidates: candidates.slice(0, 20),
  };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `${gate.passed ? "通过" : "未通过"}：${gate.reason}`,
  );
  if (selected) {
    console.log(
      `规则：覆盖概率 ≥ ${(selected.rule.minPairProbability * 100).toFixed(0)}%，相似样本 ≥ ${selected.rule.minSamples}`,
    );
    console.log(
      `中间20% ${selected.calibration.correct}/${selected.calibration.selected}，最新20% ${selected.test.correct}/${selected.test.selected}`,
    );
  }
  console.log(`已写入 ${OUTPUT_PATH}`);
} finally {
  db.close();
}
