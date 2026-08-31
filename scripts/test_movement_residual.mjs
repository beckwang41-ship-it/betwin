// 一次性只读诊断：回答 ChatGPT 提出的精确问题——
// 「在终赔已经相同或接近的情况下，走势相似能否进一步提高预测？」
//
// 这是走势模块的核心命题。终赔本身已含市场最终判断，
// 如果同时用终赔和走势，可能是重复计算同一份信息。
//
// 实验设计：先按终赔 ±7% 分组（控制终赔），再在组内按走势方向
// 切分，看结果分布是否真的不同。如果走势有增量信息，
// 「降赔组」的主胜率应显著高于「升赔组」。
import { createDataStore } from "../lib/database.mjs";

if (process.env.BETWIN_ALLOW_LEGACY_DIAGNOSTIC !== "1") {
  console.log(
    "该一次性脚本只按主胜终赔宽区间分组，没有控制完整三项终赔，已停止作为验证依据。\n" +
      "请运行：npm run model:tune-movement && npm run report:strategy-gates\n" +
      "如仅需复现旧实验，可显式设置 BETWIN_ALLOW_LEGACY_DIAGNOSTIC=1。",
  );
  process.exit(0);
}

const store = createDataStore(
  new URL("../betwin.db", import.meta.url).pathname,
);
const history = store.getVerifiedHistory();
const f = (x, d = 2) => Number(x).toFixed(d);

// 走势幅度：终赔相对初赔的变化率（负=降赔=市场看好）
function drift(initial, final) {
  const a = Number(initial);
  const b = Number(final);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 1 || b <= 1) {
    return null;
  }
  return (b - a) / a;
}

function wilson(hits, total) {
  if (!total) return [0, 0];
  const z = 1.96;
  const p = hits / total;
  const denominator = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const spread =
    z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [(center - spread) / denominator, (center + spread) / denominator];
}

// 终赔分档：控制「终赔已接近」这个条件
const FINAL_BANDS = [
  [1.0, 1.3],
  [1.3, 1.6],
  [1.6, 2.0],
  [2.0, 2.6],
  [2.6, 100],
];

for (const market of ["spf", "hhad"]) {
  console.log(
    "\n=== " + (market === "spf" ? "胜平负" : "让球胜平负") +
      "：控制终赔后，主胜赔率走势与实际主胜率 ===",
  );
  const usable = history.filter((row) => {
    const entry = row[market];
    return (
      Array.isArray(entry?.odds) &&
      Array.isArray(entry?.initialOdds) &&
      drift(entry.initialOdds[0], entry.odds[0]) !== null &&
      ["胜", "平", "负"].includes(String(entry.result))
    );
  });
  console.log("  可用样本 " + usable.length + " 场\n");
  console.log(
    "  终赔区间   走势分组      场次    主胜率   95%区间下限-上限   与本档基准差",
  );

  for (const [lo, hi] of FINAL_BANDS) {
    const bucket = usable.filter((row) => {
      const odds = Number(row[market].odds[0]);
      return odds >= lo && odds < hi;
    });
    if (bucket.length < 100) continue;
    const baseRate =
      bucket.filter((row) => String(row[market].result) === "胜").length /
      bucket.length;
    // 走势三分组：明显降赔 / 基本不动 / 明显升赔
    const buckets = [
      ["明显降赔 <-3%", bucket.filter((row) => drift(row[market].initialOdds[0], row[market].odds[0]) < -0.03)],
      ["基本不动 ±3%", bucket.filter((row) => Math.abs(drift(row[market].initialOdds[0], row[market].odds[0])) <= 0.03)],
      ["明显升赔 >+3%", bucket.filter((row) => drift(row[market].initialOdds[0], row[market].odds[0]) > 0.03)],
    ];
    const label = (hi >= 100 ? lo + "+" : lo + "-" + hi).padEnd(11);
    let first = true;
    for (const [name, group] of buckets) {
      if (group.length < 30) continue;
      const hits = group.filter(
        (row) => String(row[market].result) === "胜",
      ).length;
      const rate = hits / group.length;
      const [low, high] = wilson(hits, group.length);
      console.log(
        "  " + (first ? label : " ".repeat(11)) +
          name.padEnd(15) +
          String(group.length).padStart(5) +
          (f(rate * 100) + "%").padStart(10) +
          ("  " + f(low * 100) + "% - " + f(high * 100) + "%").padStart(20) +
          (f((rate - baseRate) * 100) + "pp").padStart(13),
      );
      first = false;
    }
    console.log(
      "  " + " ".repeat(11) + "本档基准".padEnd(15) +
        String(bucket.length).padStart(5) +
        (f(baseRate * 100) + "%").padStart(10),
    );
    console.log("");
  }
}
store.close?.();
