// 只读诊断：查串关账本的已结算战绩，按回报指数分档看实际 ROI。
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(new URL("../betwin.db", import.meta.url).pathname);
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((row) => row.name)
  .filter((name) => /parlay/i.test(name));
console.log("串关相关表:", tables.join(", ") || "(无)");

for (const table of tables) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const count = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  console.log(`\n${table}  行数=${count}`);
  console.log("  列:", cols.join(", "));
}

const rows = db
  .prepare(
    `SELECT value_index, hit_probability, total_stake, status, correct,
            simulated_return, simulated_profit, mode
     FROM parlay_ledger ORDER BY value_index DESC`,
  )
  .all();

const settled = rows.filter((r) => r.status === "settled" || r.correct !== null);
console.log(`\n已结算 ${settled.length} / 共 ${rows.length}`);
if (!settled.length) {
  console.log("尚无已结算记录，无法评估实际 ROI。");
} else {
  const buckets = [
    { label: "valueIndex < 1.00", test: (v) => v < 1 },
    { label: "1.00 ~ 1.10", test: (v) => v >= 1 && v < 1.1 },
    { label: "1.10 ~ 1.30", test: (v) => v >= 1.1 && v < 1.3 },
    { label: "≥ 1.30", test: (v) => v >= 1.3 },
  ];
  console.log("\n档位            注数  中  投入    回收     ROI");
  for (const bucket of buckets) {
    const group = settled.filter((r) => bucket.test(Number(r.value_index)));
    if (!group.length) {
      console.log(`${bucket.label.padEnd(16)} —`);
      continue;
    }
    const stake = group.reduce((s, r) => s + Number(r.total_stake || 0), 0);
    const back = group.reduce((s, r) => s + Number(r.simulated_return || 0), 0);
    const wins = group.filter((r) => Number(r.correct) === 1).length;
    const roi = stake ? back / stake - 1 : null;
    console.log(
      `${bucket.label.padEnd(16)}${String(group.length).padStart(4)}${String(wins).padStart(4)}` +
        `${stake.toFixed(0).padStart(7)}${back.toFixed(2).padStart(9)}` +
        `${roi === null ? "   n/a" : `${(roi * 100).toFixed(2)}%`.padStart(9)}`,
    );
  }
  const stake = settled.reduce((s, r) => s + Number(r.total_stake || 0), 0);
  const back = settled.reduce((s, r) => s + Number(r.simulated_return || 0), 0);
  console.log(
    `\n合计 ROI ${stake ? (((back / stake - 1) * 100).toFixed(2) + "%") : "n/a"}` +
      `（投入 ${stake.toFixed(0)}，回收 ${back.toFixed(2)}）`,
  );
  console.log("注意：样本量极小，仅作现状描述，不能作为统计证据。");
}
