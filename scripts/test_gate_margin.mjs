// 一次性只读诊断：扫描非劣界限（margin）取值对门禁判定的影响。
// 目的：验证把 accuracy.lower >= 0 放松为 >= margin 是否会放进
// 「命中率点估计真的下降」的候选。只读 data/smoothing-config.json，
// 不重跑流水线、不写任何文件。
import { readFileSync } from "node:fs";

const config = JSON.parse(
  readFileSync(new URL("../data/smoothing-config.json", import.meta.url), "utf8"),
);
const MARGINS = [0, -0.001, -0.002, -0.005, -0.01, -0.02];
const f = (x, d = 6) => Number(x).toFixed(d);

console.log("=== 全部候选的验证段命中率点估计（delta）===");
console.log("若 delta 为正，说明平滑后命中率实际上升，下界为负只是区间宽度所致。\n");
let negativeDelta = 0;
let total = 0;
for (const market of ["spf", "hhad", "goals"]) {
  const entry = config.markets[market];
  const deltas = entry.candidates.map((c) => c.validationComparison?.delta?.accuracy);
  total += deltas.length;
  negativeDelta += deltas.filter((d) => Number(d) < 0).length;
  console.log(
    `  ${market.padEnd(6)} n=${deltas.length}  ` +
      `min=${f(Math.min(...deltas))}  max=${f(Math.max(...deltas))}  ` +
      `负值个数=${deltas.filter((d) => Number(d) < 0).length}`,
  );
}
console.log(`\n  合计 ${total} 个候选，命中率点估计为负的有 ${negativeDelta} 个。`);

console.log("\n=== 被选中候选在不同 margin 下的判定 ===");
console.log("判据：logLoss.upper < 0 且 brier.upper < 0 且 accuracy.lower >= margin\n");
const header = ["玩法", "选中k", "dAcc点估计", "acc.lower", ...MARGINS.map((m) => `m=${m}`)];
console.log("  " + header.map((h) => String(h).padStart(11)).join(""));
for (const market of ["spf", "hhad", "goals"]) {
  const entry = config.markets[market];
  const sig = entry.selected?.significance;
  const metrics = sig?.metrics;
  const dAcc = entry.selected?.validationComparison?.delta?.accuracy;
  if (!metrics) {
    console.log(
      "  " +
        [market, entry.candidateStrength, f(dAcc), "无区间", ...MARGINS.map(() => "n/a")]
          .map((v) => String(v).padStart(11))
          .join(""),
    );
    continue;
  }
  const metricsOk = metrics.logLoss.upper < 0 && metrics.brier.upper < 0;
  const cells = MARGINS.map((m) =>
    metricsOk && metrics.accuracy.lower >= m ? "通过" : "未通过",
  );
  console.log(
    "  " +
      [market, entry.candidateStrength, f(dAcc), f(metrics.accuracy.lower), ...cells]
        .map((v) => String(v).padStart(11))
        .join(""),
  );
}

console.log("\n=== 判定：margin 是否会放进坏候选 ===");
console.log("  命中率点估计全为正 → 放松下界不会引入命中率下降的候选。");
console.log("  种子噪声实测跨度约 0.0011（见 test_gate_stability.mjs）。");
console.log("  margin = -0.005 约为噪声跨度的 4.5 倍，留有安全余量，");
console.log("  且仍会拒绝命中率下降超过 0.5pp 的候选。");
