import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createDataStore } from "../lib/database.mjs";
import { buildGoalMultipleDistribution, selectGoalMultiplePrediction } from "../public/goal-multiples.js";
import { SMOOTHING_VALIDATION_VERSION } from "../lib/smoothing-production.mjs";
import { HISTORY_TIMELINE_VERSION } from "../lib/history-timeline.mjs";
import { currentAlgorithmVersions } from "../lib/runtime-configuration.mjs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function backupDatabase(source, target) {
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import sqlite3, sys",
        "source = sqlite3.connect(sys.argv[1])",
        "target = sqlite3.connect(sys.argv[2])",
        "source.backup(target)",
        "target.close()",
        "source.close()",
      ].join("; "),
      source,
      target,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || "SQLite backup failed");
}

function prepareMarketVariants(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN");
    db.prepare(
      "UPDATE current_matches SET active = 1 WHERE match_id IN (2040718, 2040724, 2040725, 2040726, 2040738, 2040741, 2040742)",
    ).run();
    db.prepare(
      "DELETE FROM goal_odds_snapshots WHERE match_id IN (2040718, 2040724, 2040726)",
    ).run();
    db.prepare(
      "DELETE FROM spf_odds_snapshots WHERE match_id = 2040724 AND market = 'hhad'",
    ).run();
    db.prepare(
      "DELETE FROM spf_odds_snapshots WHERE match_id = 2040725",
    ).run();
    db.prepare("DELETE FROM shadow_spf_predictions").run();
    db.prepare("DELETE FROM shadow_model_state").run();
    const parlay = db.prepare(
      "SELECT actual_results_json FROM parlay_ledger WHERE id = 14",
    ).get();
    if (parlay) {
      const partialResults = JSON.parse(parlay.actual_results_json || "[]")
        .filter((result) => String(result.matchId) !== "2040724");
      db.prepare(
        "UPDATE parlay_ledger SET actual_results_json = ? WHERE id = 14",
      ).run(JSON.stringify(partialResults));
    }
    db.prepare(`
      INSERT INTO current_matches (
        match_id, display_name, league, home_team, away_team, imported_at, active
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(
      9990001,
      "测试联赛: 联合零样本主队 vs 联合零样本客队",
      "测试联赛",
      "联合零样本主队",
      "联合零样本客队",
      "2026-08-07T00:00:00Z",
    );
    const insertOdds = db.prepare(`
      INSERT INTO spf_odds_snapshots (
        match_id, market, goal_line, captured_at,
        home_odds, draw_odds, away_odds, source_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOdds.run(
      9990001,
      "had",
      "",
      "2026-08-07T00:00:00Z",
      99,
      98,
      97,
      "realtime_matches_had_hhad_history.json",
    );
    insertOdds.run(
      9990001,
      "hhad",
      "-9",
      "2026-08-07T00:00:00Z",
      99,
      98,
      97,
      "realtime_matches_had_hhad_history.json",
    );
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

async function waitForServer(port, child, log) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`测试服务提前退出：${log()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/matches`);
      if (response.ok) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待测试服务超时：${log()}`);
}

async function predict(port, matchId, options = {}) {
  const params = new URLSearchParams({ matchId, ...options });
  const response = await fetch(
    `http://127.0.0.1:${port}/api/predict?${params}`,
  );
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

function pendingLedgerState(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT id, captured_at, predicted, selected_probability,
             selected_odds, reliability_level, settings_json
      FROM prediction_ledger
      WHERE status = 'pending' AND valid = 1
      ORDER BY id
    `).all();
  } finally {
    db.close();
  }
}

function shadowLedgerState(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT match_id, model_version, status,
             baseline_samples, candidate_samples
      FROM shadow_spf_predictions
      ORDER BY match_id, model_version
    `).all();
  } finally {
    db.close();
  }
}

function selectedStabilitySamples(payload, market) {
  const selected = payload.settings.effectiveThresholds[market];
  return payload.stability[market].points.find(
    (point) => Math.abs(point.threshold - selected) < 1e-9,
  )?.samples;
}

test("隔离批准平滑时正式概率与账本版本一致，同联赛不沿用全部联赛批准", { timeout: 60_000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-smoothing-api-"));
  let child;
  try {
    const databasePath = path.join(directory, "test.db");
    backupDatabase(path.join(ROOT, "betwin.db"), databasePath);
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE current_matches SET active = CASE WHEN match_id = 2040718 THEN 1 ELSE 0 END").run();
    db.close();
    const store = createDataStore(databasePath);
    const candidate = JSON.parse(readFileSync(path.join(ROOT, "data/smoothing-config.json"), "utf8"));
    Object.assign(candidate.data, {
      verifiedMatches: store.getCounts().verifiedHistory,
      sourceUpdatedAt: store.getHistoricalSourceUpdatedAt(),
      timelineVersion: HISTORY_TIMELINE_VERSION, validationVersion: SMOOTHING_VALIDATION_VERSION,
    });
    store.close();
    // 仅在临时测试目录模拟批准，以检验开启路径；不代表真实候选通过。
    candidate.markets.hhad.candidateStrength = 20;
    candidate.markets.hhad.gate.passed = true;
    const approval = { runtimeEnabled: true, approvedAt: "2026-10-01T00:00:00Z",
      approvedArtifact: { generatedAt: candidate.generatedAt, ...candidate.data },
      markets: { hhad: { enabled: true, strength: 20 } } };
    const candidatePath = path.join(directory, "candidate.json"), approvalPath = path.join(directory, "approval.json");
    const reliabilityPath = path.join(directory, "reliability.json");
    const reliability = JSON.parse(readFileSync(path.join(ROOT, "data/reliability-config.json"), "utf8"));
    writeFileSync(reliabilityPath, JSON.stringify(reliability));
    writeFileSync(candidatePath, JSON.stringify(candidate)); writeFileSync(approvalPath, JSON.stringify(approval));
    const port = await reservePort(); let logs = "";
    child = spawn(process.execPath, ["server.mjs"], { cwd: ROOT,
      env: { ...process.env, PORT: String(port), BETWIN_DATABASE_PATH: databasePath,
        BETWIN_SMOOTHING_CONFIG_PATH: candidatePath, BETWIN_SMOOTHING_PRODUCTION_PATH: approvalPath,
        BETWIN_RELIABILITY_CONFIG_PATH: reliabilityPath },
      stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", c => { logs += c; }); child.stderr.on("data", c => { logs += c; });
    await waitForServer(port, child, () => logs);
    const metadata = await (await fetch(`http://127.0.0.1:${port}/api/matches`)).json();
    assert.equal(metadata.productionPolicy.smoothing.hhad.enabled, true);
    const prediction = await predict(port, "2040718");
    assert.equal(prediction.hhad.smoothing.applied, true);
    assert.equal(prediction.spf.smoothing.applied, false);
    const local = await predict(port, "2040718", { sameLeague: "true" });
    assert.equal(local.hhad.smoothing.applied, false);
    const manual = await predict(port, "2040718", { hhadTolerance: "0.05" });
    assert.equal(manual.hhad.smoothing.applied, false);
    const ledger = await (await fetch(`http://127.0.0.1:${port}/api/ledger?settle=false`)).json();
    assert.match(ledger.currentPolicyVersions.find(v => v.includes(":hhad:") && v.includes(":all-leagues")), /:smoothing-/);
    assert.doesNotMatch(ledger.currentPolicyVersions.find(v => v.includes(":hhad:") && v.includes(":same-league")), /:smoothing-/);
    assert.doesNotMatch(ledger.currentPolicyVersions.find(v => v.includes(":spf:") && v.includes(":all-leagues")), /:smoothing-/);
    assert.ok(ledger.currentSnapshotPolicyVersions.some(v => v.includes(":hhad:smoothing-")));
    assert.ok(ledger.currentSnapshotPolicyVersions.filter(v => v.includes(":goalsPair:")).every(v => !v.includes(":smoothing-")));
    const service = await (await fetch(`http://127.0.0.1:${port}/api/runtime`)).json();
    assert.equal(currentAlgorithmVersions(service.currentAlgorithmSpec).hhad,
      ledger.currentPolicyVersions.find(v => v.includes(":hhad:") && v.includes(":all-leagues")));
    assert.equal(prediction.runtime.revision, service.runtime.revision);
    assert.equal(prediction.hhad.reliability.validation.status, "stale");

    // 同一个进程中撤销批准，下一次请求必须关闭平滑并同步版本。
    writeFileSync(approvalPath, JSON.stringify({ ...approval, runtimeEnabled: false }));
    const disabled = await predict(port, "2040718");
    assert.equal(disabled.hhad.smoothing.applied, false);
    assert.notEqual(disabled.runtime.revision, service.runtime.revision);
    assert.doesNotMatch(currentAlgorithmVersions(disabled.currentAlgorithmSpec).hhad, /:smoothing-/);
    assert.deepEqual((await predict(port, "2040718")).runtime, disabled.runtime);
    writeFileSync(reliabilityPath, JSON.stringify({ ...reliability, generatedAt: "2026-10-05T00:00:00Z" }));
    const refreshedValidation = await predict(port, "2040718");
    assert.equal(refreshedValidation.configuration.challengerConfig.selection.generatedAt, "2026-10-05T00:00:00Z");
    assert.notEqual(refreshedValidation.runtime.revision, disabled.runtime.revision);
    writeFileSync(approvalPath, JSON.stringify(approval));
    assert.equal((await predict(port, "2040718")).hhad.smoothing.applied, true);

    // 只改变数据库历史水位、不碰配置文件，也要让旧批准失效。
    const updated = new DatabaseSync(databasePath);
    updated.prepare("UPDATE source_files SET imported_at = ? WHERE file_type = 'xlsx'").run("2099-01-01T00:00:00Z");
    updated.close();
    const stale = await predict(port, "2040718");
    assert.equal(stale.hhad.smoothing.applied, false);
    assert.equal(stale.hhad.reliability.validation.status, "stale");
    assert.notEqual(stale.runtime.revision, disabled.runtime.revision);
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM"); await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "预测接口用同一批联合样本分别统计两个玩法的原始赛果",
  { timeout: 60_000 },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "betwin-api-"));
    const databasePath = path.join(directory, "betwin-test.db");
    backupDatabase(path.join(ROOT, "betwin.db"), databasePath);
    prepareMarketVariants(databasePath);
    const port = await reservePort();
    let logs = "";
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        BETWIN_DATABASE_PATH: databasePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      logs += chunk;
    });
    child.stderr.on("data", (chunk) => {
      logs += chunk;
    });

    try {
      await waitForServer(port, child, () => logs);

      const matchesResponse = await fetch(
        `http://127.0.0.1:${port}/api/matches`,
      );
      const matchesPayload = await matchesResponse.json();
      assert.equal(matchesResponse.status, 200);
      assert.equal(matchesPayload.dataStatus.oddsCollectedAt, null);
      assert.match(matchesPayload.dataStatus.historyOrder, /首次入库批次/);
      assert.ok(matchesPayload.dataStatus.currentImportedAt);
      assert.ok(matchesPayload.dataStatus.historicalUpdatedAt);
      assert.equal(
        matchesPayload.productionPolicy.probabilityPolicy,
        "historical-similarity-v3-zero-floor-m1.5",
      );
      assert.deepEqual(matchesPayload.productionPolicy.zeroCellFloor, {
        enabled: true,
        priorMass: 1.5,
        version: "zero-floor-m1.5",
      });
      assert.equal(
        matchesPayload.productionPolicy.threeWayProbability.candidateOnly,
        true,
      );
      assert.equal(
        matchesPayload.productionPolicy.threeWayProbability.runtimeEnabled,
        false,
      );
      assert.equal(
        matchesPayload.productionPolicy.threeWayProbability.productionLock,
        "historical-similarity-v3-zero-floor-m1.5",
      );
      assert.equal(
        typeof matchesPayload.productionPolicy.threeWayProbability.scopes.all
          .hhad.enabled,
        "boolean",
      );
      assert.equal(
        typeof matchesPayload.productionPolicy.threeWayProbability.scopes.all
          .spf.enabled,
        "boolean",
      );
      assert.equal(matchesPayload.productionPolicy.empiricalOnly, true);
      assert.equal(matchesPayload.productionPolicy.thresholds.spf, 0.07);
      assert.equal(matchesPayload.productionPolicy.thresholds.hhad, 0.07);
      assert.equal(matchesPayload.modelConfig.candidateOnly, true);
      assert.equal(matchesPayload.modelConfig.runtimeEnabled, false);
      assert.equal(matchesPayload.modelConfig.productionLocked, true);
      assert.equal(matchesPayload.modelConfig.markets.spf.threshold, 0.07);
      assert.equal(matchesPayload.modelConfig.markets.hhad.threshold, 0.07);
      assert.equal(matchesPayload.modelConfig.markets.goals.threshold, 0.015);
      assert.equal(matchesPayload.modelConfig.markets.spf.changed, false);
      assert.equal(matchesPayload.modelConfig.markets.hhad.changed, false);
      assert.deepEqual(matchesPayload.productionPolicy.historicalCalibration, {
        enabled: false,
        maxWeight: 0,
        scale: 800,
        requireSamples: true,
      });
      assert.equal(matchesPayload.weightingConfig.version, 3);
      assert.equal(typeof matchesPayload.weightingConfig.stale, "boolean");
      assert.equal(
        matchesPayload.weightingConfig.methodology.matchingVersion,
        "spf-hhad-joint-v1",
      );
      for (const market of ["spf", "hhad", "goals"]) {
        assert.equal(
          matchesPayload.productionPolicy.weighting[market].enabled,
          false,
        );
      }
      // 未批准时可能是 disabled（候选新鲜）或 candidate-stale（候选落后于
      // 数据库水位）。两者都必须保持生产关闭，这里不锁定具体哪一种，
      // 否则单独重跑某个调参脚本就会让本测试失败。
      assert.ok(
        ["disabled", "candidate-stale"].includes(
          matchesPayload.productionPolicy.weightingApproval.status,
        ),
        `weightingApproval.status 应为未启用状态，实际 ${matchesPayload.productionPolicy.weightingApproval.status}`,
      );
      assert.equal(
        matchesPayload.productionPolicy.weightingApproval.runtimeEnabled,
        false,
      );
      assert.deepEqual(
        matchesPayload.productionPolicy.weightingApproval.enabledMarkets,
        [],
      );
      assert.equal(matchesPayload.movementConfig.version, 3);
      assert.equal(typeof matchesPayload.movementConfig.stale, "boolean");
      assert.equal(
        matchesPayload.movementConfig.methodology.matchingVersion,
        "spf-hhad-joint-v1",
      );
      assert.equal(matchesPayload.productionPolicy.movement.spf.enabled, false);
      assert.equal(matchesPayload.productionPolicy.movement.hhad.enabled, false);
      assert.equal(matchesPayload.productionPolicy.movement.goals.enabled, false);
      assert.equal(matchesPayload.smoothingConfig.candidateOnly, true);
      // 未批准为 disabled；候选落后于数据水位为 candidate-stale；
      // 人工批准且与当前候选一致为 approved（目前只批准了让球）。
      const smoothingApproval = matchesPayload.smoothingConfig.approval;
      assert.ok(
        ["disabled", "candidate-stale", "approved"].includes(
          smoothingApproval.status,
        ),
        `未预期的批准状态：${smoothingApproval.status}`,
      );
      assert.equal(
        matchesPayload.smoothingConfig.runtimeEnabled,
        smoothingApproval.enabledMarkets.length > 0,
      );
      for (const market of ["spf", "hhad", "goals"]) {
        const policy = matchesPayload.productionPolicy.smoothing[market];
        const approved = smoothingApproval.enabledMarkets.includes(market);
        assert.equal(policy.enabled, approved);
        if (!approved) assert.equal(policy.strength, 0);
        else {
          const candidate = matchesPayload.smoothingConfig.markets[market];
          assert.equal(candidate.gate.passed, true);
          assert.equal(policy.strength, candidate.candidateStrength);
        }
      }
      // 胜平负和总进球未通过门禁，不得被批准。
      assert.ok(!smoothingApproval.enabledMarkets.includes("spf"));
      assert.ok(!smoothingApproval.enabledMarkets.includes("goals"));

      const ledgerBeforeRead = pendingLedgerState(databasePath);
      const shadowBeforeRead = shadowLedgerState(databasePath);
      const jointWithoutGoals = await predict(port, "2040718");
      assert.equal(jointWithoutGoals.recentForm.affectsProduction, false);
      assert.equal(typeof jointWithoutGoals.recentForm.available, "boolean");
      assert.equal(jointWithoutGoals.ledgerSnapshotInserted, 0);
      assert.equal(jointWithoutGoals.shadowSnapshotInserted, 0);
      assert.deepEqual(pendingLedgerState(databasePath), ledgerBeforeRead);
      assert.deepEqual(shadowLedgerState(databasePath), shadowBeforeRead);

      const wrongPredictMethod = await fetch(
        `http://127.0.0.1:${port}/api/predict?matchId=2040718`,
        { method: "POST" },
      );
      assert.equal(wrongPredictMethod.status, 405);
      const wrongSnapshotMethod = await fetch(
        `http://127.0.0.1:${port}/api/predict/snapshot?matchId=2040718`,
      );
      assert.equal(wrongSnapshotMethod.status, 405);
      const explicitSnapshot = await fetch(
        `http://127.0.0.1:${port}/api/predict/snapshot?matchId=2040718`,
        { method: "POST" },
      );
      assert.equal(explicitSnapshot.status, 200);
      const explicitSnapshotPayload = await explicitSnapshot.json();
      assert.equal(
        typeof explicitSnapshotPayload.ledgerSnapshotInserted,
        "number",
      );
      assert.equal(
        typeof explicitSnapshotPayload.shadowSnapshotInserted,
        "number",
      );
      assert.equal(explicitSnapshotPayload.shadowSnapshotInserted, 0);
      const shadowRows = shadowLedgerState(databasePath);
      const shadowRow = shadowRows.find(
        (row) => String(row.match_id) === "2040718",
      );
      assert.equal(shadowRow, undefined);
      const shadowResponse = await fetch(
        `http://127.0.0.1:${port}/api/shadow/spf`,
      );
      const shadowPayload = await shadowResponse.json();
      assert.equal(shadowResponse.status, 200);
      assert.equal(shadowPayload.reportOnly, true);
      assert.equal(shadowPayload.affectsProduction, false);
      assert.equal(shadowPayload.reviewGate.productionChanged, false);
      assert.equal(shadowPayload.activation.backfillExistingMatches, false);
      assert.ok(shadowPayload.activation.initialMatchesExcluded > 0);

      assert.ok(jointWithoutGoals.spf);
      assert.ok(jointWithoutGoals.hhad);
      assert.equal(jointWithoutGoals.goals, null);
      assert.deepEqual(jointWithoutGoals.topScores, []);
      assert.equal(jointWithoutGoals.spf.matchingMode, "joint");
      assert.equal(jointWithoutGoals.hhad.matchingMode, "joint");
      assert.equal(jointWithoutGoals.sampleOrigins.spf.mode, "joint");
      assert.equal(jointWithoutGoals.sampleOrigins.spf.total, jointWithoutGoals.similarSpf.total);
      assert.equal(jointWithoutGoals.sampleOrigins.hhad.total, jointWithoutGoals.similarHhad.total);
      assert.equal(jointWithoutGoals.sampleOrigins.goals, null);
      assert.equal(jointWithoutGoals.sampleOrigins.spf.leagues.reduce((sum, item) => sum + item.count, 0), jointWithoutGoals.spf.stats.total);
      assert.equal(jointWithoutGoals.spf.jointCounting.available, true);
      assert.equal(jointWithoutGoals.hhad.jointCounting.available, true);
      assert.equal(
        jointWithoutGoals.spf.jointCounting.version,
        "spf-hhad-paired-direct-results-v3",
      );
      assert.equal(
        jointWithoutGoals.spf.jointCounting.method,
        "paired-market-direct-results",
      );
      assert.equal(
        jointWithoutGoals.spf.jointCounting.outcomeBasis,
        "stored-market-result",
      );
      assert.equal(
        jointWithoutGoals.spf.jointCounting.jointSamples,
        jointWithoutGoals.hhad.jointCounting.jointSamples,
      );
      assert.equal(
        jointWithoutGoals.spf.stats.total,
        jointWithoutGoals.hhad.stats.total,
      );
      const conditionalGroups =
        jointWithoutGoals.hhad.jointCounting.conditionalHhadBySpf;
      assert.deepEqual(Object.keys(conditionalGroups), ["胜", "平", "负"]);
      const conditionalTotals = { 胜: 0, 平: 0, 负: 0 };
      let conditionalSamples = 0;
      for (const spfLabel of ["胜", "平", "负"]) {
        const group = conditionalGroups[spfLabel];
        const groupTotal = Object.values(group.counts).reduce(
          (sum, count) => sum + count,
          0,
        );
        assert.equal(groupTotal, group.samples);
        conditionalSamples += group.samples;
        for (const hhadLabel of ["胜", "平", "负"]) {
          conditionalTotals[hhadLabel] += group.counts[hhadLabel];
        }
      }
      assert.equal(conditionalSamples, jointWithoutGoals.spf.stats.total);
      assert.deepEqual(
        conditionalTotals,
        jointWithoutGoals.hhad.stats.counts,
      );
      assert.equal(
        "displayProbabilities" in jointWithoutGoals.spf.jointCounting,
        false,
      );
      assert.equal(jointWithoutGoals.spf.empiricalWeight, 1);
      // empiricalWeight=1 表示完全采用历史分布、不混入赔率先验。
      // 但防零层会先把零样本格抬离 0%，所以 final 等于防零后的
      // weightedEmpirical，而不是裸占比 empirical。
      assert.deepEqual(
        jointWithoutGoals.spf.final,
        jointWithoutGoals.spf.weightedEmpirical,
      );
      assert.deepEqual(
        jointWithoutGoals.spf.rawWeightedEmpirical,
        jointWithoutGoals.spf.empirical,
      );
      assert.equal(jointWithoutGoals.hhad.empiricalWeight, 1);
      assert.equal(jointWithoutGoals.hhad.probabilityModel.enabled, false);
      assert.deepEqual(
        jointWithoutGoals.hhad.final,
        jointWithoutGoals.hhad.weightedEmpirical,
      );
      assert.equal(
        jointWithoutGoals.model.spf.policy,
        "historical-similarity-v3-zero-floor-m1.5",
      );
      assert.match(jointWithoutGoals.method.spf, /相似比赛.*等权赛果占比/);
      assert.match(jointWithoutGoals.method.hhad, /相似比赛.*等权赛果占比/);
      assert.equal(jointWithoutGoals.spf.smoothing.applied, false);
      assert.equal(jointWithoutGoals.hhad.smoothing.applied, false);
      assert.ok(jointWithoutGoals.settings.matching.jointSamples > 0);
      assert.equal(
        selectedStabilitySamples(jointWithoutGoals, "spf"),
        jointWithoutGoals.settings.matching.jointSamples,
      );
      assert.equal(
        selectedStabilitySamples(jointWithoutGoals, "hhad"),
        jointWithoutGoals.settings.matching.jointSamples,
      );
      for (const market of ["spf", "hhad"]) {
        const comparison = jointWithoutGoals[market].marketComparison;
        assert.equal(comparison.available, true);
        assert.ok(
          ["market-aligned", "historical-divergence"].includes(
            comparison.status,
          ),
        );
        assert.equal(comparison.actionable, false);
        assert.equal(comparison.outcomes.length, 3);
        assert.equal(
          typeof comparison.selected.probabilityDelta,
          "number",
        );
        assert.equal(
          typeof comparison.selected.breakEvenDelta,
          "number",
        );
      }
      for (const market of ["spf", "hhad"]) {
        const support = jointWithoutGoals.stability[market];
        assert.ok(["supported", "mixed", "opposed", "insufficient"].includes(support.status));
        assert.equal(support.points.length, 4);
        assert.equal(support.direction, jointWithoutGoals[market].predicted);
        assert.ok(Array.isArray(support.points[0].historicalTopLabels));
        assert.equal(typeof support.points[0].supportsFinal, "boolean");
      }

      const onlyHad = await predict(port, "2040724");
      assert.ok(onlyHad.spf);
      assert.equal(onlyHad.hhad, null);
      assert.equal(onlyHad.goals, null);

      const onlyHhad = await predict(port, "2040726");
      assert.equal(onlyHhad.spf, null);
      assert.ok(onlyHhad.hhad);
      assert.equal(onlyHhad.goals, null);
      assert.deepEqual(onlyHhad.topScores, []);

      const onlyGoals = await predict(port, "2040725");
      assert.equal(onlyGoals.spf, null);
      assert.equal(onlyGoals.hhad, null);
      assert.ok(onlyGoals.goals);
      assert.equal(onlyGoals.goals.marketComparison.available, true);
      assert.equal(onlyGoals.goals.marketComparison.outcomes.length, 8);
      assert.equal(onlyGoals.goals.empiricalWeight, 1);
      assert.deepEqual(
        onlyGoals.goals.final,
        onlyGoals.goals.weightedEmpirical,
      );
      assert.match(onlyGoals.method.goals, /综合距离加权/);

      const allLeagues = await predict(port, "2040738", {
        spfTolerance: 0.1,
        hhadTolerance: 0.1,
        goalTolerance: 0.015,
        sameLeague: false,
      });
      const sameLeague = await predict(port, "2040738", {
        spfTolerance: 0.1,
        hhadTolerance: 0.1,
        goalTolerance: 0.015,
        sameLeague: true,
      });
      assert.equal(allLeagues.settings.sameLeague, false);
      assert.equal(sameLeague.settings.sameLeague, true);
      assert.ok(allLeagues.spf.stats.total >= sameLeague.spf.stats.total);
      assert.ok(
        sameLeague.similarSpf.rows.every(
          (row) => row.league === sameLeague.match.league,
        ),
      );
      // 同上：final 对齐防零后的 weightedEmpirical，裸占比在
      // rawWeightedEmpirical 里保留，用来确认没有额外加权。
      assert.deepEqual(allLeagues.spf.final, allLeagues.spf.weightedEmpirical);
      assert.deepEqual(
        allLeagues.spf.rawWeightedEmpirical,
        allLeagues.spf.empirical,
      );
      assert.equal(sameLeague.spf.empiricalWeight, 1);
      assert.equal(sameLeague.spf.probabilityModel.enabled, false);
      assert.deepEqual(sameLeague.spf.final, sameLeague.spf.weightedEmpirical);
      assert.notDeepEqual(allLeagues.spf.final, sameLeague.spf.final);

      const bandedGoals = await predict(port, "2040742", {
        goalTolerance: 0.015,
        sameLeague: false,
        pageSize: 50,
      });
      assert.equal(typeof matchesPayload.goalZeroConfig.stale, "boolean");
      assert.equal(matchesPayload.goalZeroConfig.enabled, true);
      assert.equal(matchesPayload.goalZeroConfig.stale, false);
      assert.equal(matchesPayload.goalZeroConfig.source, "内置生产规则");
      assert.equal(matchesPayload.goalZeroConfig.researchReportOnly, true);
      assert.equal(bandedGoals.settings.zeroOdds.enabled, true);
      assert.equal(bandedGoals.settings.zeroOdds.blocked, false);
      assert.equal(bandedGoals.settings.zeroOdds.intervalId, "g0-2");
      assert.equal(bandedGoals.settings.zeroOdds.target, 21);
      assert.equal(bandedGoals.settings.zeroOdds.tolerance, 2);
      assert.equal(bandedGoals.settings.zeroOdds.lower, 19);
      assert.equal(bandedGoals.settings.zeroOdds.upper, 23);
      assert.equal(bandedGoals.settings.zeroOdds.usesAllSamples, true);
      assert.equal(bandedGoals.settings.zeroOdds.sampleLimit, null);
      assert.equal(bandedGoals.sampleOrigins.goals.total, bandedGoals.similarGoals.total);
      assert.equal(bandedGoals.sampleOrigins.goals.effectiveSamples, bandedGoals.goals.weighting.effectiveSamples);
      assert.equal(bandedGoals.sampleOrigins.goals.mode, "goals-independent");
      assert.equal(
        bandedGoals.goals.weighting.method,
        "exponential-composite-distance",
      );
      assert.equal(
        bandedGoals.goals.stats.total,
        bandedGoals.similarGoals.total,
      );
      assert.equal(
        bandedGoals.stability.goals.mode,
        "composite-distance-pool",
      );
      assert.deepEqual(
        bandedGoals.stability.goals.points.map((point) => point.threshold),
        [0.25, 0.5, 0.75, 1],
      );
      assert.ok(
        bandedGoals.similarGoals.rows.every(
          (row) => Math.abs(Number(row.odds[0]) - 21) <= 2,
        ),
      );
      assert.ok(
        bandedGoals.similarGoals.rows.every(
          (row) => Number(row.odds[0]) !== 25,
        ),
      );

      const sameLeagueGoals = await predict(port, "2040742", {
        goalTolerance: 0.015,
        sameLeague: true,
        pageSize: 50,
      });
      assert.equal(sameLeagueGoals.settings.zeroOdds.tolerance, 2.5);
      assert.equal(sameLeagueGoals.settings.zeroOdds.lower, 18.5);
      assert.equal(sameLeagueGoals.settings.zeroOdds.upper, 23.5);
      assert.ok(
        sameLeagueGoals.similarGoals.rows.every(
          (row) =>
            row.league === sameLeagueGoals.match.league &&
            Math.abs(Number(row.odds[0]) - 21) <= 2.5,
        ),
      );
      assert.equal(
        sameLeagueGoals.stability.goals.points.at(-1).samples,
        sameLeagueGoals.goals.stats.total,
      );
      assert.notDeepEqual(sameLeagueGoals.goals.final, bandedGoals.goals.final);

      const goalMultiple = await predict(port, "2040741", {
        sameLeague: false,
      });
      assert.equal(typeof goalMultiple.goalMultiple.available, "boolean");
      const multipleStore = createDataStore(databasePath);
      try {
        const expected = selectGoalMultiplePrediction(
          ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7plus"].map(k => goalMultiple.match.goals[k]),
          buildGoalMultipleDistribution(multipleStore.getGoalHistory()),
        );
        assert.deepEqual(goalMultiple.goalMultiple, expected);
      } finally { multipleStore.close(); }
      if (goalMultiple.goalMultiple.available) {
        assert.equal(
          goalMultiple.goalMultiple.zeroOdds,
          goalMultiple.match.goals.g0,
        );
        assert.ok(goalMultiple.goalMultiple.samples > 0);
        assert.equal(goalMultiple.goalMultiple.labels.length, 2);
        assert.equal(goalMultiple.goalMultiple.counts.length, 2);
        assert.ok(goalMultiple.goalMultiple.relations.length > 0);
        assert.ok(
          goalMultiple.goalMultiple.relations.every(
            (relation) => Number.isInteger(relation.multiple) && relation.multiple >= 2,
          ),
        );
      }

      const zeroJoint = await predict(port, "9990001");
      assert.equal(zeroJoint.settings.matching.jointSamples, 0);
      assert.equal(zeroJoint.spf.matchingMode, "joint-unavailable");
      assert.equal(zeroJoint.hhad.matchingMode, "joint-unavailable");
      assert.equal(zeroJoint.spf.available, false);
      assert.equal(zeroJoint.hhad.available, false);
      assert.equal(zeroJoint.spf.jointCounting.available, false);
      assert.match(zeroJoint.spf.jointCounting.reason, /没有同时满足/);
      assert.equal(zeroJoint.goals, null);

      const ledgerResponse = await fetch(
        `http://127.0.0.1:${port}/api/ledger?settle=false&singleMarket=goalMultiple&singleScope=global&singleStatus=all&singleQuery=${encodeURIComponent("坎布尔")}&pageSize=100`,
      );
      const ledgerPayload = await ledgerResponse.json();
      assert.equal(ledgerResponse.status, 200);
      assert.ok(ledgerPayload.recordContext.all >= ledgerPayload.recordContext.selectedPolicy);
      assert.ok(ledgerPayload.parlays.recordContext.all >= ledgerPayload.parlays.recordContext.selectedPolicy);
      assert.ok(ledgerPayload.historicalSourceUpdatedAt);
      assert.equal(ledgerPayload.settledNow, 0);
      assert.equal(ledgerPayload.parlaySettledNow, 0);
      assert.equal(ledgerPayload.parlayBackfilledNow, 0);
      assert.equal(ledgerPayload.overview.policyMode, "current");
      assert.ok(ledgerPayload.overview.totals.fixtures >= 1);
      assert.ok(ledgerPayload.overview.byMarketScope.spf.all);
      assert.ok(Array.isArray(ledgerPayload.overview.calibration.bins));
      assert.ok(ledgerPayload.overview.oddsBenchmark.byMarketScope.spf.all);
      assert.ok(ledgerPayload.overview.scopeComparison.byMarket.spf);
      assert.ok(ledgerPayload.overview.errorDiagnosis.byMarket.spf);
      assert.ok(Array.isArray(ledgerPayload.overview.errorDiagnosis.byOddsBand));
      assert.ok(Array.isArray(ledgerPayload.overview.errorDiagnosis.byLeague));
      assert.ok(ledgerPayload.overview.errorDiagnosis.confusion.spf.matrix);
      assert.ok(ledgerPayload.overview.errorDiagnosis.confusion.hhad.matrix);
      assert.ok(ledgerPayload.overview.errorDiagnosis.confusion.goals.bias);
      assert.ok(ledgerPayload.overview.parlays.totals);
      assert.match(
        ledgerPayload.policyVersion,
        /^historical-similarity-v3-zero-floor-m1\.5:/,
      );
      assert.ok(
        ledgerPayload.rows.every((row) =>
          ledgerPayload.currentPolicyVersions.includes(row.algorithmVersion),
        ),
      );
      assert.ok(ledgerPayload.overview.totals.coreSettledFixtures >= 0);
      assert.ok(ledgerPayload.overview.coreByScope.all);
      assert.ok(ledgerPayload.overview.coreByScope.sameLeague);
      assert.ok(ledgerPayload.overview.calibrationByScope.all);
      assert.ok(
        ["empty", "insufficient", "better", "worse", "uncertain"].includes(
          ledgerPayload.overview.oddsBenchmark.byMarketScope.spf.all
            .liftStatus,
        ),
      );
      assert.equal(
        ledgerPayload.overview.oddsBenchmark.byMarketScope.spf.all.liftMethod,
        "fixture-chronological-block-bootstrap",
      );
      assert.ok(
        ledgerPayload.overview.oddsBenchmark.byMarketScope.spf.all.lift ===
          null ||
          Number.isFinite(
            ledgerPayload.overview.oddsBenchmark.byMarketScope.spf.all.lift,
          ),
      );
      assert.ok(
        Number.isInteger(
          ledgerPayload.overview.evidence.current.settledFixtures,
        ),
      );
      assert.ok(
        Number.isInteger(
          ledgerPayload.overview.evidence.lifetime.settledFixtures,
        ),
      );
      assert.ok(
        Number.isInteger(
          ledgerPayload.overview.evidence.historical.unifiedHistory,
        ),
      );
      assert.ok(
        Number.isInteger(
          ledgerPayload.overview.evidence.historical.verifiedHistory,
        ),
      );
      assert.ok(
        ledgerPayload.overview.evidence.historical.markets.spf === null ||
          Number.isInteger(
            ledgerPayload.overview.evidence.historical.markets.spf.evaluated,
          ),
      );
      assert.ok(
        Number.isInteger(ledgerPayload.byMarket.goalMultiple.total),
      );

      const parlayBackfillParams = new URLSearchParams({
        parlayStatus: "all",
        parlayPolicy: "all",
        parlayQuery: "比亚韦斯托克",
        pageSize: "100",
      });
      const legacyGetResponse = await fetch(
        `http://127.0.0.1:${port}/api/ledger?settle=true&${parlayBackfillParams}`,
      );
      const legacyGetPayload = await legacyGetResponse.json();
      assert.equal(legacyGetResponse.status, 200);
      assert.equal(legacyGetPayload.settledNow, 0);
      assert.equal(legacyGetPayload.parlayBackfilledNow, 0);

      const wrongMethodResponse = await fetch(
        `http://127.0.0.1:${port}/api/ledger/settle?${parlayBackfillParams}`,
      );
      assert.equal(wrongMethodResponse.status, 405);

      const parlayBackfillResponse = await fetch(
        `http://127.0.0.1:${port}/api/ledger/settle?${parlayBackfillParams}`,
        { method: "POST" },
      );
      const parlayBackfillPayload = await parlayBackfillResponse.json();
      assert.equal(parlayBackfillResponse.status, 200);
      assert.equal(parlayBackfillPayload.parlayBackfilledNow, 1);
      const backfilledParlay = parlayBackfillPayload.parlays.rows.find(
        (row) => row.id === 14,
      );
      assert.ok(backfilledParlay);
      assert.equal(backfilledParlay.status, "settled");
      assert.equal(backfilledParlay.correct, false);
      assert.equal(backfilledParlay.simulatedProfit, -4);
      assert.equal(backfilledParlay.actualResults.length, 2);
      assert.deepEqual(
        backfilledParlay.actualResults.find(
          (result) => String(result.matchId) === "2040724",
        ),
        {
          matchId: "2040724",
          actualResult: "3",
          score: "2:1",
          correct: true,
          selectedOdds: 3.4,
          sourceFile: "历史进球数.xlsx",
          sourceRow: 8488,
        },
      );
      // Generated cards can query prior archive status without saving anything.
      const archiveCount = () => {
        const db = new DatabaseSync(databasePath, { readOnly: true });
        try { return db.prepare("SELECT COUNT(*) AS n FROM parlay_ledger").get().n; }
        finally { db.close(); }
      };
      const countBeforeLookup = archiveCount();
      const portfolioQuery = new URLSearchParams({ mode: "goalsPair", legs: "2", limit: "3", maxMatchUses: "1" });
      const portfolioResponse = await fetch(`http://127.0.0.1:${port}/api/parlay?${portfolioQuery}`);
      assert.equal(portfolioResponse.status, 200);
      const portfolio = await portfolioResponse.json();
      assert.ok(portfolio.combinations.rows.length > 0);
      assert.equal(portfolio.combinations.settings.maxMatchUses, 1);
      assert.equal(portfolio.requestSettings.limit, 3);
      assert.equal(portfolio.requestSettings.maxMatchUses, 1);
      const allSelected = portfolio.candidates.map(c => c.id).join(",");
      const limitedQuery = new URLSearchParams({ mode: "goalsPair", legs: "2", limit: "5", maxMatchUses: "2", selected: allSelected });
      const limited = await (await fetch(`http://127.0.0.1:${port}/api/parlay?${limitedQuery}`)).json();
      assert.ok(limited.combinations.rows.length <= 5);
      const uses = new Map();
      limited.combinations.rows.flatMap(row => row.legs).forEach(leg => uses.set(leg.id, (uses.get(leg.id) || 0) + 1));
      assert.ok([...uses.values()].every(n => n <= 2));
      assert.equal(archiveCount(), countBeforeLookup);
      const firstPortfolio = portfolio.combinations.rows[0];
      portfolioQuery.set("combinationId", firstPortfolio.id);
      const savePortfolioResponse = await fetch(`http://127.0.0.1:${port}/api/parlay/save?${portfolioQuery}`, { method: "POST" });
      assert.ok([200, 201].includes(savePortfolioResponse.status));
      const savedPortfolio = await savePortfolioResponse.json();
      assert.equal(savedPortfolio.record.settings.maxMatchUses, 1);
      assert.equal(savedPortfolio.record.settings.limit, 3);
      const rereadPortfolio = await (await fetch(`http://127.0.0.1:${port}/api/parlay?${portfolioQuery}`)).json();
      assert.equal(rereadPortfolio.combinations.rows.find(row => row.id === firstPortfolio.id).recorded.id, savedPortfolio.record.id);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
