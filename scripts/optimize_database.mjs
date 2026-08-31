#!/usr/bin/env node

import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const databasePath = process.env.BETWIN_DATABASE_PATH || resolve("betwin.db");
if (!existsSync(databasePath)) {
  console.error(`数据库文件不存在: ${databasePath}`);
  process.exit(1);
}

const db = new DatabaseSync(databasePath);
const requiredIndexes = [
  {
    name: "idx_historical_spf_odds",
    description: "胜平负三项终赔",
    sql: `CREATE INDEX IF NOT EXISTS idx_historical_spf_odds
          ON historical_spf(final_home_odds, final_draw_odds, final_away_odds)`,
  },
  {
    name: "idx_historical_hhad_odds",
    description: "让球数与三项终赔",
    sql: `CREATE INDEX IF NOT EXISTS idx_historical_hhad_odds
          ON historical_hhad(handicap, final_home_odds, final_draw_odds, final_away_odds)`,
  },
  {
    name: "idx_goals_g0",
    description: "总进球0球终赔",
    sql: `CREATE INDEX IF NOT EXISTS idx_goals_g0
          ON historical_goals(final_g0)`,
  },
];

const indexExists = db.prepare(`
  SELECT 1 AS found
  FROM sqlite_master
  WHERE type = 'index' AND name = ?
`);

let created = 0;
let existing = 0;
let failed = 0;
console.log(`数据库: ${databasePath}`);
console.log("检查预测查询需要的索引:");
for (const index of requiredIndexes) {
  const alreadyExists = Boolean(indexExists.get(index.name));
  try {
    db.exec(index.sql);
    if (alreadyExists) {
      existing += 1;
      console.log(`  已存在  ${index.description} (${index.name})`);
    } else {
      created += 1;
      console.log(`  已创建  ${index.description} (${index.name})`);
    }
  } catch (error) {
    failed += 1;
    console.error(`  失败    ${index.description}: ${error.message}`);
  }
}

if (!failed) {
  db.exec("ANALYZE historical_spf");
  db.exec("ANALYZE historical_hhad");
  db.exec("ANALYZE historical_goals");
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

function benchmark({ name, sql, params = [] }) {
  const statement = db.prepare(sql);
  for (let index = 0; index < 10; index += 1) statement.get(...params);
  const samples = [];
  let count = 0;
  for (let index = 0; index < 100; index += 1) {
    const start = performance.now();
    const row = statement.get(...params);
    samples.push(performance.now() - start);
    count = Number(row?.count || 0);
  }
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join(" | ");
  return { name, count, medianMs: median(samples), plan };
}

const benchmarks = [
  {
    name: "胜平负赔率范围",
    sql: `SELECT COUNT(*) AS count
          FROM historical_spf
          WHERE final_home_odds BETWEEN ? AND ?
            AND final_draw_odds BETWEEN ? AND ?
            AND final_away_odds BETWEEN ? AND ?`,
    params: [1.8, 2.2, 3, 3.6, 3, 3.6],
  },
  {
    name: "让球数与赔率范围",
    sql: `SELECT COUNT(*) AS count
          FROM historical_hhad
          WHERE handicap = ?
            AND final_home_odds BETWEEN ? AND ?`,
    params: [-1, 1.8, 2.2],
  },
  {
    name: "总进球0球赔率范围",
    sql: `SELECT COUNT(*) AS count
          FROM historical_goals
          WHERE final_g0 BETWEEN ? AND ?`,
    params: [19, 23],
  },
].map(benchmark);

console.log(`索引结果: 新建 ${created}，已存在 ${existing}，失败 ${failed}`);
console.log("当前查询基准（预热后100次中位数，不代表优化前后提升倍数）:");
for (const result of benchmarks) {
  console.log(
    `  ${result.name}: ${result.medianMs.toFixed(3)}ms，${result.count.toLocaleString()}场`,
  );
  console.log(`    查询计划: ${result.plan}`);
}

db.close();
if (failed) process.exitCode = 1;
