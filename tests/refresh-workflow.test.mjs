import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf8"),
);

test("普通数据库导入不再运行0球区间研究器", () => {
  assert.equal(pkg.scripts["db:import"].includes("report:goal-zero"), false);
  assert.equal(pkg.scripts["db:import"].includes("tune-zero-goals"), false);
  assert.equal(pkg.scripts["model:tune-zero-goals"], undefined);
});

test("当前比赛更新命令只启用JSON模式", () => {
  assert.equal(
    pkg.scripts["db:update-matches"],
    "python3 scripts/import_sqlite.py --json-only",
  );
});

test("轻量历史更新只导入数据并按需重跑正式规则验证", () => {
  assert.equal(
    pkg.scripts["db:update-history"],
    "node --disable-warning=ExperimentalWarning scripts/update_history.mjs",
  );
  const source = readFileSync(
    path.join(ROOT, "scripts", "update_history.mjs"),
    "utf8",
  );
  assert.match(source, /scripts\/import_sqlite\.py/);
  assert.match(source, /scripts\/tune_reliability\.mjs/);
  assert.doesNotMatch(
    source,
    /scripts\/(tune_parameters|train_challenger|tune_goal_zero_odds|generate_goal_multiple_report)|npm test/,
  );
});

test("一键刷新按顺序重验配置、生成报告并运行测试", () => {
  const script = pkg.scripts["db:refresh"];
  const steps = [
    "npm run db:import",
    "npm run model:tune-weighting",
    "npm run model:tune-smoothing",
    "npm run model:tune-movement",
    "npm run report:strategy-gates",
    "npm run model:tune-reliability",
    "npm run model:tune-goal-pair",
    "npm run report:goal-zero",
    "npm run report:goal-multiples",
    // 调参会重写候选配置，刷新后必须复验「候选无法绕过门禁上线」
    "npm run verify:production-lock",
    "npm test",
  ];
  let previous = -1;
  for (const step of steps) {
    const index = script.indexOf(step);
    assert.ok(index > previous, `${step} 应位于前一步之后`);
    previous = index;
  }
  assert.equal(script.includes("model:train-challenger"), false);
});

test("高级验证统一使用锁定的正式匹配阈值", () => {
  const scripts = [
    "tune_weighting.mjs",
    "tune_movement.mjs",
    "tune_adaptive_thresholds.mjs",
    "tune_segment_thresholds.mjs",
  ];
  for (const filename of scripts) {
    const source = readFileSync(path.join(ROOT, "scripts", filename), "utf8");
    assert.match(source, /FORMAL_PRODUCTION_THRESHOLDS/);
    assert.doesNotMatch(source, /resolveProductionThresholds|THRESHOLD_CONFIG_PATH/);
  }
  const thresholdSource = readFileSync(
    path.join(ROOT, "scripts", "tune_parameters.mjs"),
    "utf8",
  );
  assert.match(thresholdSource, /candidateOnly:\s*true/);
  assert.match(thresholdSource, /runtimeEnabled:\s*false/);
  assert.match(thresholdSource, /productionLocked:\s*true/);

  const frontendSource = readFileSync(
    path.join(ROOT, "public", "app.js"),
    "utf8",
  );
  assert.match(
    frontendSource,
    /state\.adaptiveConfig\.runtimeEnabled && adaptiveCandidatePassed/,
  );
  assert.match(frontendSource, /动态范围候选通过（未上线）/);
});

test("平滑重验只生成候选报告且不能由完整刷新自动上线", () => {
  const source = readFileSync(
    path.join(ROOT, "scripts", "tune_smoothing.mjs"),
    "utf8",
  );
  assert.match(source, /candidateOnly:\s*true/);
  assert.match(source, /runtimeEnabled:\s*false/);
  assert.match(source, /productionStrength:\s*0/);
  assert.doesNotMatch(source, /BETWIN_SMOOTHING_AUTO_APPLY/);

  const approval = JSON.parse(
    readFileSync(
      path.join(ROOT, "data", "smoothing-production.json"),
      "utf8",
    ),
  );
  assert.equal(approval.runtimeEnabled, false);
  assert.equal(approval.approvedArtifact, null);
  for (const market of ["spf", "hhad", "goals"]) {
    assert.equal(approval.markets[market].enabled, false);
    assert.equal(approval.markets[market].strength, 0);
  }
});

test("动态范围、距离权重和走势的投注门禁独立报告且不能自动上线", () => {
  const adaptive = readFileSync(
    path.join(ROOT, "scripts", "tune_adaptive_thresholds.mjs"),
    "utf8",
  );
  const movement = readFileSync(
    path.join(ROOT, "scripts", "tune_movement.mjs"),
    "utf8",
  );
  const weighting = readFileSync(
    path.join(ROOT, "scripts", "tune_weighting.mjs"),
    "utf8",
  );
  const report = readFileSync(
    path.join(ROOT, "scripts", "report_strategy_gates.mjs"),
    "utf8",
  );
  assert.match(adaptive, /candidateOnly:\s*true/);
  assert.match(adaptive, /runtimeEnabled:\s*false/);
  assert.match(movement, /candidateOnly:\s*true/);
  assert.match(movement, /runtimeEnabled:\s*false/);
  assert.match(weighting, /candidateOnly:\s*true/);
  assert.match(weighting, /runtimeEnabled:\s*false/);
  assert.match(report, /reportOnly:\s*true/);
  assert.match(report, /affectsProduction:\s*false/);
  assert.match(report, /bettingPromotionEligible/);
  assert.match(report, /weighting-config\.json/);

  for (const name of ["adaptive", "weighting", "movement"]) {
    const approval = JSON.parse(
      readFileSync(
        path.join(ROOT, "data", `${name}-production.json`),
        "utf8",
      ),
    );
    assert.equal(approval.runtimeEnabled, false);
    assert.equal(approval.approvedArtifact, null);
  }

  const legacyAdaptive = readFileSync(
    path.join(ROOT, "scripts", "test_adaptive_roi.mjs"),
    "utf8",
  );
  const legacyMovement = readFileSync(
    path.join(ROOT, "scripts", "test_movement_residual.mjs"),
    "utf8",
  );
  assert.match(legacyAdaptive, /BETWIN_ALLOW_LEGACY_DIAGNOSTIC/);
  assert.match(legacyMovement, /BETWIN_ALLOW_LEGACY_DIAGNOSTIC/);
});

test("三个批准模块都必须向外暴露 runtimeEnabled 供前端与测试核对", () => {
  const source = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  for (const name of ["adaptive", "weighting", "movement"]) {
    // 只暴露 status 不够：status 有 disabled / candidate-stale 等多种未启用取值，
    // 必须有一个布尔字段能被直接断言为 false。
    assert.match(
      source,
      new RegExp(
        `productionPolicy\\.${name}Approval = \\{\\s*\\n\\s*runtimeEnabled:`,
      ),
      `${name}Approval 必须把 runtimeEnabled 放在首位暴露`,
    );
  }
});

test("界面文案不得把未验证盈利的信号包装成投注建议", () => {
  // 命中率更高 ≠ 投注能赚钱。ROI 实测为负的信号只能叫「参考」，
  // 不能用「建议预测」这类行动指令，也不能靠高亮暗示推荐。
  const reliability = readFileSync(
    path.join(ROOT, "lib", "reliability.mjs"),
    "utf8",
  );
  assert.doesNotMatch(reliability, /label:\s*"建议预测"/);
  assert.match(reliability, /label:\s*"重点参考"/);
  assert.match(reliability, /未验证投注收益/);

  const app = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  // 回报指数不得再作为「正期望」高亮依据
  assert.doesNotMatch(app, /const positive = combination\.valueIndex >= 1/);
  assert.doesNotMatch(app, /理论正期望/);
  assert.doesNotMatch(app, /平均期望净正/);

  const html = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.doesNotMatch(html, /理论正期望/);
  assert.match(html, /不代表值得投注/);
});

test("可靠性训练绑定正式防零概率版本", () => {
  const source = readFileSync(
    path.join(ROOT, "scripts", "tune_reliability.mjs"),
    "utf8",
  );
  const shared = readFileSync(
    path.join(ROOT, "lib", "reliability-tuning.mjs"),
    "utf8",
  );
  assert.match(source, /FORMAL_PRODUCTION_PROBABILITY_POLICY/);
  assert.match(source, /buildThreeWayReliabilityObservations/);
  assert.match(shared, /applyZeroCellFloor\(counts\)/);
  assert.match(shared, /selectThreeWaySimilarity/);
});

test("重点参考ROI报告复用正式可靠性观察并执行区块Bootstrap", () => {
  assert.equal(
    pkg.scripts["report:reliability-roi"],
    "node --disable-warning=ExperimentalWarning scripts/report_reliability_roi.mjs",
  );
  const source = readFileSync(
    path.join(ROOT, "scripts", "report_reliability_roi.mjs"),
    "utf8",
  );
  assert.match(source, /buildThreeWayReliabilityObservations/);
  assert.match(source, /blockBootstrapStrategyComparison\(cases\)/);
  assert.match(source, /ROI报告与可靠性配置口径不一致/);
  assert.doesNotMatch(source, /harmonicBreakeven|命中率\s*-\s*保本线/);
});
