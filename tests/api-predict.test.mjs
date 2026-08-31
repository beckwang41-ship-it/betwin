import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

function selectedStabilitySamples(payload, market) {
  const selected = payload.settings.effectiveThresholds[market];
  return payload.stability[market].points.find(
    (point) => Math.abs(point.threshold - selected) < 1e-9,
  )?.samples;
}

test(
  "预测接口按实际存在的市场独立计算，并保持联合匹配与零样本回退",
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
      assert.equal(matchesPayload.smoothingConfig.runtimeEnabled, false);
      // 未人工批准时为 disabled；若候选报告落后于当前数据水位则为
      // candidate-stale。两种情况下生产平滑都必须保持关闭。
      assert.ok(
        ["disabled", "candidate-stale"].includes(
          matchesPayload.smoothingConfig.approval.status,
        ),
        `未预期的批准状态：${matchesPayload.smoothingConfig.approval.status}`,
      );
      assert.equal(matchesPayload.smoothingConfig.approval.enabledMarkets.length, 0);
      for (const market of ["spf", "hhad", "goals"]) {
        assert.equal(
          matchesPayload.productionPolicy.smoothing[market].enabled,
          false,
        );
        assert.equal(
          matchesPayload.productionPolicy.smoothing[market].strength,
          0,
        );
      }

      const ledgerBeforeRead = pendingLedgerState(databasePath);
      const jointWithoutGoals = await predict(port, "2040718");
      assert.equal(jointWithoutGoals.ledgerSnapshotInserted, 0);
      assert.deepEqual(pendingLedgerState(databasePath), ledgerBeforeRead);

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
      assert.equal(
        typeof (await explicitSnapshot.json()).ledgerSnapshotInserted,
        "number",
      );

      assert.ok(jointWithoutGoals.spf);
      assert.ok(jointWithoutGoals.hhad);
      assert.equal(jointWithoutGoals.goals, null);
      assert.deepEqual(jointWithoutGoals.topScores, []);
      assert.equal(jointWithoutGoals.spf.matchingMode, "joint");
      assert.equal(jointWithoutGoals.hhad.matchingMode, "joint");
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
      assert.equal(zeroJoint.spf.matchingMode, "standalone-fallback");
      assert.equal(zeroJoint.hhad.matchingMode, "standalone-fallback");
      assert.equal(zeroJoint.goals, null);

      const ledgerResponse = await fetch(
        `http://127.0.0.1:${port}/api/ledger?settle=false&singleMarket=goalMultiple&singleScope=global&singleStatus=all&singleQuery=${encodeURIComponent("坎布尔")}&pageSize=100`,
      );
      const ledgerPayload = await ledgerResponse.json();
      assert.equal(ledgerResponse.status, 200);
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
        "chronological-block-bootstrap",
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
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
