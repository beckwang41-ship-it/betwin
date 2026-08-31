// 一次性只读诊断：统计零概率格的出现频率与实际命中率
import { createDataStore } from "../lib/database.mjs";
import { OUTCOME_LABELS } from "../lib/predictor.mjs";
import {
  buildThreeWaySmoothingRows,
  createThreeWaySmoothingResolvers,
} from "../lib/three-way-smoothing.mjs";

const store = createDataStore(
  new URL("../betwin.db", import.meta.url).pathname,
);
const history = store.getVerifiedHistory();

for (const market of ["spf", "hhad"]) {
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

  let total = 0;
  let matchesWithZero = 0;
  let zeroCells = 0;
  let zeroCellHits = 0;
  const tiers = new Map();

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
      total += 1;
      const zeros = counts.filter((count) => count === 0).length;
      if (zeros > 0) matchesWithZero += 1;
      zeroCells += zeros;
      if (counts[actualIndex] === 0) zeroCellHits += 1;

      const size = similar.length;
      const tier =
        size <= 3
          ? "n<=3"
          : size <= 10
            ? "4-10"
            : size <= 30
              ? "11-30"
              : size <= 100
                ? "31-100"
                : "n>100";
      if (!tiers.has(tier)) tiers.set(tier, { matches: 0, zero: 0, hit: 0 });
      const entry = tiers.get(tier);
      entry.matches += 1;
      if (zeros > 0) entry.zero += 1;
      if (counts[actualIndex] === 0) entry.hit += 1;
    }
  }

  console.log(`\n=== ${market}  验证段 ${total} 场`);
  console.log(
    `含至少一个零概率格的场次：${matchesWithZero} (${((matchesWithZero / total) * 100).toFixed(1)}%)`,
  );
  console.log(
    `零概率格总数 ${zeroCells}，其中实际发生 ${zeroCellHits} → 零概率格真实发生率 ${((zeroCellHits / Math.max(1, zeroCells)) * 100).toFixed(2)}%（模型宣称 0%）`,
  );
  for (const [tier, entry] of tiers) {
    console.log(
      `  ${tier.padEnd(8)} 场次 ${String(entry.matches).padStart(4)}  含零 ${String(entry.zero).padStart(4)} (${((entry.zero / entry.matches) * 100).toFixed(0)}%)  零格被命中 ${entry.hit}`,
    );
  }
}
store.close?.();
