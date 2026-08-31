// 只读报告：在「只看赔率」的前提下，按赔率区间统计
// 模型概率、真实命中率、保本线、ROI，用来回答「什么时候该投」。
//
// 关键口径说明：
// - 保本线用赔率的调和平均 1/mean(1/odds)，不能用 1/mean(odds)。
//   用算术平均会得出自相矛盾的结论（曾出现「差距 +5.0pp 却 ROI -9.7%」）。
// - 模型概率经过防零层（applyZeroCellFloor），与生产口径一致。
// - 全部走时序回放：只用该场之前的历史，不含未来信息。
import { createDataStore } from "../lib/database.mjs";
import { OUTCOME_LABELS } from "../lib/predictor.mjs";
import {
  buildThreeWaySmoothingRows,
  createThreeWaySmoothingResolvers,
} from "../lib/three-way-smoothing.mjs";
import { applyZeroCellFloor } from "../lib/smoothing.mjs";

const store = createDataStore(
  new URL("../betwin.db", import.meta.url).pathname,
);
const history = store.getVerifiedHistory();
const f = (x, d = 2) => Number(x).toFixed(d);

// 赔率分档：按投注标的的赔率分组
const ODDS_BANDS = [
  [1, 1.3],
  [1.3, 1.6],
  [1.6, 2],
  [2, 2.5],
  [2.5, 3.5],
  [3.5, 100],
];

function bandOf(odds) {
  return ODDS_BANDS.findIndex(([lo, hi]) => odds >= lo && odds < hi);
}

function harmonicMean(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, value) => acc + 1 / value, 0);
  return values.length / sum;
}

function collect(market) {
  // 注意：赔率在 target[market].odds，result 在顶层
  const rows = buildThreeWaySmoothingRows(history, market);
  const resolvers = createThreeWaySmoothingResolvers(market, {
    spfTolerance: 0.07,
    hhadTolerance: 0.07,
  });
  const groups = new Map();
  for (const row of rows) {
    const key = row.sourceFile || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.sourceRow - right.sourceRow);
  }

  const picks = [];
  for (const group of groups.values()) {
    const start = Math.max(501, Math.floor(group.length * 0.8));
    for (let i = start; i < group.length; i += 1) {
      const target = group[i];
      const actualIndex = OUTCOME_LABELS.indexOf(String(target.result));
      if (actualIndex < 0) continue;
      const similar = resolvers
        .sampleResolver(target, group.slice(0, i))
        .filter((row) => OUTCOME_LABELS.includes(String(row.result)));
      if (!similar.length) continue;

      const counts = OUTCOME_LABELS.map(
        (label) => similar.filter((row) => String(row.result) === label).length,
      );
      const probabilities = applyZeroCellFloor(counts).probabilities;
      let top = 0;
      for (let k = 1; k < probabilities.length; k += 1) {
        if (probabilities[k] > probabilities[top]) top = k;
      }
      const odds = Number(target[market]?.odds?.[top]);
      if (!Number.isFinite(odds) || odds <= 1) continue;

      picks.push({
        odds,
        probability: probabilities[top],
        won: top === actualIndex,
        samples: similar.length,
      });
    }
  }
  return picks;
}

function report(label, picks) {
  console.log("\n=== " + label + "　共 " + picks.length + " 场（按模型首选投注）===");
  console.log(
    "  赔率区间      场次   模型概率   真实命中   保本线   命中-保本      ROI",
  );
  let totalStake = 0;
  let totalReturn = 0;
  for (let b = 0; b < ODDS_BANDS.length; b += 1) {
    const bucket = picks.filter((pick) => bandOf(pick.odds) === b);
    if (!bucket.length) continue;
    const [lo, hi] = ODDS_BANDS[b];
    const wins = bucket.filter((pick) => pick.won);
    const hitRate = wins.length / bucket.length;
    const modelProb =
      bucket.reduce((sum, pick) => sum + pick.probability, 0) / bucket.length;
    const breakEven = 1 / harmonicMean(bucket.map((pick) => pick.odds));
    const returned = wins.reduce((sum, pick) => sum + pick.odds, 0);
    const roi = returned / bucket.length - 1;
    totalStake += bucket.length;
    totalReturn += returned;
    const range = (hi >= 100 ? lo + "+" : lo + "-" + hi).padEnd(12);
    console.log(
      "  " + range +
        String(bucket.length).padStart(5) +
        (f(modelProb * 100) + "%").padStart(11) +
        (f(hitRate * 100) + "%").padStart(11) +
        (f(breakEven * 100) + "%").padStart(9) +
        (f((hitRate - breakEven) * 100) + "pp").padStart(11) +
        (f(roi * 100) + "%").padStart(9),
    );
  }
  const overallRoi = totalReturn / totalStake - 1;
  console.log(
    "  " + "全部".padEnd(12) + String(totalStake).padStart(5) +
      "".padStart(31) + (f(overallRoi * 100) + "%").padStart(20),
  );
}

for (const market of ["spf", "hhad"]) {
  const picks = collect(market);
  report(market === "spf" ? "胜平负" : "让球胜平负", picks);
}
store.close?.();
