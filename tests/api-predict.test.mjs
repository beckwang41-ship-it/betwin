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
      "DELETE FROM goal_odds_snapshots WHERE match_id IN (2040718, 2040724, 2040726)",
    ).run();
    db.prepare(
      "DELETE FROM spf_odds_snapshots WHERE match_id = 2040724 AND market = 'hhad'",
    ).run();
    db.prepare(
      "DELETE FROM spf_odds_snapshots WHERE match_id = 2040725",
    ).run();
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

async function predict(port, matchId) {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/predict?matchId=${matchId}`,
  );
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

function selectedStabilitySamples(payload, market) {
  const selected = payload.settings.effectiveThresholds[market];
  return payload.stability[market].points.find(
    (point) => Math.abs(point.threshold - selected) < 1e-9,
  )?.samples;
}

test(
  "预测接口按实际存在的市场独立计算，并保持联合匹配与零样本回退",
  { timeout: 30_000 },
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

      const jointWithoutGoals = await predict(port, "2040718");
      assert.ok(jointWithoutGoals.spf);
      assert.ok(jointWithoutGoals.hhad);
      assert.equal(jointWithoutGoals.goals, null);
      assert.equal(jointWithoutGoals.spf.matchingMode, "joint");
      assert.equal(jointWithoutGoals.hhad.matchingMode, "joint");
      assert.ok(jointWithoutGoals.settings.matching.jointSamples > 0);
      assert.equal(
        selectedStabilitySamples(jointWithoutGoals, "spf"),
        jointWithoutGoals.settings.matching.jointSamples,
      );
      assert.equal(
        selectedStabilitySamples(jointWithoutGoals, "hhad"),
        jointWithoutGoals.settings.matching.jointSamples,
      );

      const onlyHad = await predict(port, "2040724");
      assert.ok(onlyHad.spf);
      assert.equal(onlyHad.hhad, null);
      assert.equal(onlyHad.goals, null);

      const onlyHhad = await predict(port, "2040726");
      assert.equal(onlyHhad.spf, null);
      assert.ok(onlyHhad.hhad);
      assert.equal(onlyHhad.goals, null);

      const onlyGoals = await predict(port, "2040725");
      assert.equal(onlyGoals.spf, null);
      assert.equal(onlyGoals.hhad, null);
      assert.ok(onlyGoals.goals);

      const zeroJoint = await predict(port, "9990001");
      assert.equal(zeroJoint.settings.matching.jointSamples, 0);
      assert.equal(zeroJoint.spf.matchingMode, "standalone-fallback");
      assert.equal(zeroJoint.hhad.matchingMode, "standalone-fallback");
      assert.equal(zeroJoint.goals, null);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
