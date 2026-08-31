// 只读验证：证明手工篡改候选配置的 runtimeEnabled 无法让候选上线。
// 用法：node scripts/verify_production_lock.mjs
import { readFileSync } from "node:fs";
import {
  candidateArtifact,
  resolveProductionApproval,
} from "../lib/production-approval.mjs";

const read = (name) =>
  JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8"));

const MODULES = [
  {
    label: "动态范围",
    candidate: read("adaptive-config.json"),
    approval: read("adaptive-production.json"),
    paramsOf: (n) => ({
      minSamples: Number(n?.minSamples) || null,
      thresholds: Array.isArray(n?.thresholds) ? n.thresholds.map(Number) : [],
    }),
    approvedParamsOf: (n) => ({
      minSamples: Number(n?.minSamples) || null,
      thresholds: Array.isArray(n?.thresholds) ? n.thresholds.map(Number) : [],
    }),
  },
  {
    label: "距离权重",
    candidate: read("weighting-config.json"),
    approval: read("weighting-production.json"),
    paramsOf: (n) => ({
      floor: Number(n?.selected?.floor) || 1,
      power: Number(n?.selected?.power) || 1,
      coreRatio: 0.5,
    }),
    approvedParamsOf: (n) => ({
      floor: Number(n?.floor) || 1,
      power: Number(n?.power) || 1,
      coreRatio: Number(n?.coreRatio) || 0.5,
    }),
  },
  {
    label: "走势修正",
    candidate: read("movement-config.json"),
    approval: read("movement-production.json"),
    paramsOf: (n) => ({ weight: Number(n?.selected?.weight) || 0 }),
    approvedParamsOf: (n) => ({ weight: Number(n?.weight) || 0 }),
  },
];

const MARKETS = ["spf", "hhad", "goals"];
let failures = 0;

for (const mod of MODULES) {
  console.log(`\n===== ${mod.label}`);
  const opts = {
    moduleLabel: mod.label,
    paramsOf: mod.paramsOf,
    approvedParamsOf: mod.approvedParamsOf,
  };

  // 场景 1：现状（候选文件原样）
  const now = resolveProductionApproval(mod.candidate, mod.approval, opts);
  console.log(`现状          runtimeEnabled=${now.runtimeEnabled}  ${now.status}`);

  // 场景 2：攻击者把候选文件 runtimeEnabled 改成 true
  const tampered = { ...mod.candidate, runtimeEnabled: true };
  const attacked = resolveProductionApproval(tampered, mod.approval, opts);
  console.log(
    `篡改候选文件   runtimeEnabled=${attacked.runtimeEnabled}  ${attacked.status}`,
  );
  if (attacked.runtimeEnabled !== false) {
    console.log("  ✗ 篡改候选文件竟然生效了");
    failures += 1;
  }

  // 场景 3：连批准文件也开启，且指纹参数全对，但任一门禁未过
  const forged = {
    version: 1,
    runtimeEnabled: true,
    approvedAt: new Date().toISOString(),
    approvedArtifact: candidateArtifact(mod.candidate),
    markets: Object.fromEntries(
      MARKETS.map((m) => [
        m,
        { enabled: true, ...mod.paramsOf(mod.candidate.markets?.[m] || {}) },
      ]),
    ),
  };
  const forgedResult = resolveProductionApproval(mod.candidate, forged, opts);
  console.log(
    `伪造完整批准   runtimeEnabled=${forgedResult.runtimeEnabled}  ${forgedResult.status}`,
  );
  for (const m of MARKETS) {
    const d = forgedResult.markets[m];
    console.log(
      `  ${m.padEnd(6)} enabled=${String(d.enabled).padEnd(5)} 概率=${String(d.probabilityPassed).padEnd(5)} ROI=${String(d.strategyPassed).padEnd(5)} (${d.strategyStatus})`,
    );
    // 概率门禁过但 ROI 门禁没过的玩法，绝不能被启用
    if (d.probabilityPassed && !d.strategyPassed && d.enabled) {
      console.log("    ✗ 概率过但ROI未过却上线了");
      failures += 1;
    }
  }
}

console.log(
  failures === 0
    ? "\n结论：候选文件与伪造批准均无法绕过 ROI 门禁上线。"
    : `\n结论：存在 ${failures} 处绕过路径。`,
);
process.exit(failures === 0 ? 0 : 1);
