import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditPaths, readPredictionAudit, savePredictionAudit } from "../lib/prediction-audit-store.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  const locations = auditPaths(root), report = readPredictionAudit(locations);
  const saved = savePredictionAudit(locations.outputDir, report);
  console.log(`预测对照已复盘：${report.summary.evaluatedFixtures}场已核对，${report.summary.pendingItems}项待结算，${report.summary.excludedItems}项需核查；未调用AI、未重算旧预测。`);
  if (process.env.BETWIN_VERBOSE === "1") console.log(`报告：${saved}`);
} catch (error) {
  console.error(`预测复盘未完成：${error.message}`);
  process.exitCode = 1;
}
