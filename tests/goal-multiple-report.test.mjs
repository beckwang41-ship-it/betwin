import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { buildGoalMultipleRecords } from "../public/goal-multiples.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test("倍率报告与同赔统计读取同一完整数据库，保留比分但不以比分齐全筛样本", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "betwin-multiple-report-"));
  const output = path.join(directory, "report.html");
  const store = createDataStore(path.join(root, "betwin.db"));
  try {
    const history = store.getGoalHistory({ includeScores: true });
    assert.equal(history.length, store.getGoalHistory().length);
    assert.ok(history.some(row => row.score));
    const expected = buildGoalMultipleRecords(history);
    const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(root, "scripts/generate_goal_multiple_report.mjs")], {
      cwd: directory, encoding: "utf8", env: { ...process.env,
        BETWIN_DATABASE_PATH: path.join(root, "betwin.db"), BETWIN_GOAL_MULTIPLE_REPORT_PATH: output },
    });
    assert.equal(run.status, 0, run.stderr);
    const html = readFileSync(output, "utf8");
    const records = JSON.parse(html.match(/const records = (.*);/)[1]);
    assert.deepEqual(records, expected);
    assert.equal(new Set(records.map(row => row.historyId)).size, records.length);
    assert.ok(records.some(row => row.sourceFile === "history.xlsx"));
    assert.match(run.stdout, new RegExp(`符合条件：${expected.length.toLocaleString()} 场`));
    assert.match(run.stdout, new RegExp(`倍率统计数据库样本：${history.length.toLocaleString()} 场`));
    assert.match(run.stdout, new RegExp(`相同赔率统计数据库样本：${history.length.toLocaleString()} 场`));
    assert.doesNotMatch(html, /按历史源文件行号倒序/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
