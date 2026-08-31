import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productionGoalFeaturePools } from "../lib/goal-production.mjs";
import { loadGoalRows } from "./rolling_backtest.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");

export function buildGoalProductionEvents(rows) {
  const groups = new Map();
  for (const row of rows) {
    const sourceFile = String(row.sourceFile || "unknown");
    if (!groups.has(sourceFile)) groups.set(sourceFile, []);
    groups.get(sourceFile).push(row);
  }

  const events = [];
  for (const [sourceFile, sourceRows] of groups) {
    sourceRows.sort((left, right) => Number(left.sourceRow) - Number(right.sourceRow));
    const history = [];
    for (const target of sourceRows) {
      const featurePools = productionGoalFeaturePools(history, target);
      events.push({
        sourceFile,
        sourceRow: Number(target.sourceRow),
        pools: featurePools.pools,
      });
      history.push(target);
    }
  }
  return events;
}

function main() {
  const db = new DatabaseSync(DATABASE_PATH, { readOnly: true });
  try {
    const rows = loadGoalRows(db);
    process.stdout.write(JSON.stringify({
      matchingVersion: "goal-zero-composite-v1",
      ordering: "同一来源文件按source_row递增，每场只读取更早记录",
      events: buildGoalProductionEvents(rows),
    }));
  } finally {
    db.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
