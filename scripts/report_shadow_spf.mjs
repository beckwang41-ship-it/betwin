import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { summarizeShadowSpfRows } from "../lib/shadow-prediction-ledger.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH =
  process.env.BETWIN_DATABASE_PATH || path.join(ROOT, "betwin.db");
const OUTPUT_PATH =
  process.env.BETWIN_SHADOW_SPF_REPORT_PATH ||
  path.join(ROOT, "data", "shadow-spf-report.json");

const db = new DatabaseSync(DATABASE_PATH, { readOnly: true });
try {
  const table = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'shadow_spf_predictions'
  `).get();
  const rows = table
    ? db.prepare(`
        SELECT * FROM shadow_spf_predictions
        ORDER BY captured_at, id
      `).all()
    : [];
  const summary = summarizeShadowSpfRows(rows);
  const stateTable = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'shadow_model_state'
  `).get();
  const state = stateTable
    ? db.prepare(`
        SELECT * FROM shadow_model_state WHERE model_version = ?
      `).get(summary.modelVersion)
    : null;
  const initialMatches = state
    ? JSON.parse(state.initial_match_ids_json || "[]")
    : [];
  const report = {
    ...summary,
    activation: {
      activatedAt: state?.activated_at || null,
      initialMatchesExcluded: initialMatches.length,
      backfillExistingMatches: false,
    },
  };
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`影子模型快照：${report.totals.snapshots}`);
  console.log(`待结算：${report.totals.pending}`);
  console.log(`已结算：${report.totals.settled}`);
  if (report.totals.settled) {
    console.log(
      `基线命中率：${(report.baseline.accuracy * 100).toFixed(2)}% | ` +
        `Hellinger：${(report.candidate.accuracy * 100).toFixed(2)}%`,
    );
    console.log(
      `概率门禁：${report.probabilityComparison.passed ? "通过" : "未通过"} | ` +
        `ROI门禁：${report.reviewGate.roiPassed ? "通过" : "未通过"}`,
    );
  } else {
    console.log("尚无真正未来结算样本，暂不形成效果结论。");
  }
  console.log(`报告已写入：${OUTPUT_PATH}`);
  console.log("本命令不修改生产预测或影子快照。");
} finally {
  db.close();
}
