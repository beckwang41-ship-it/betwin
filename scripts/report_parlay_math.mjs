// 只读诊断：串关的三个数学问题
//   1. 水钱复合：每关 88.6% 返还率相乘，N 关后剩多少
//   2. 组合搜索的多重比较：从 C(n,k) 个组合里挑最大 valueIndex，
//      即使每场概率无偏，选出来的那个也系统性虚高
//   3. 概率误差放大：单场 p 有误差 ε 时，N 关乘积的相对误差
// 用法：node scripts/report_parlay_math.mjs
const RTP = 0.886; // 三项赔率倒数和 1.129 → 市场无优势基准返还率
const pct = (v) => `${(v * 100).toFixed(2)}%`;

console.log("=== 1. 水钱复合效应 ===");
console.log("假设每关都按市场公允定价投注（返还率 88.6%），");
console.log("串关把水钱按关数乘方，不是相加：\n");
console.log("关数   无优势基准返还   基准累计损耗");
for (const legs of [1, 2, 3, 4, 5]) {
  const rtp = RTP ** legs;
  console.log(
    `${String(legs).padStart(2)}关   ${pct(rtp).padStart(9)}   ${pct(rtp - 1).padStart(9)}`,
  );
}

console.log("\n=== 2. 组合搜索的多重比较偏差 ===");
console.log("从 n 场候选里选 k 场，组合数 C(n,k)。");
console.log("按 valueIndex 排序取第一名 = 在 C(n,k) 个随机变量里取最大值。");
console.log("即使每场概率完全无偏，最大值的期望也高于真值。\n");

function combinations(n, k) {
  let result = 1;
  for (let i = 0; i < k; i += 1) result = (result * (n - i)) / (i + 1);
  return Math.round(result);
}

// 蒙特卡洛：模拟无偏概率下 argmax valueIndex 的虚高幅度
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(20260829);

function simulateSelectionBias(n, k, trials = 4000) {
  let sumSelectedTrue = 0;
  let sumSelectedEstimate = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    // n 场比赛：真实命中率 pTrue，模型估计 pEst = pTrue + 无偏噪声
    const matches = Array.from({ length: n }, () => {
      const pTrue = 0.35 + random() * 0.35; // 真实 35%~70%
      const noise = (random() - 0.5) * 0.16; // ±8pp 无偏噪声
      const pEst = Math.min(0.95, Math.max(0.05, pTrue + noise));
      // 赔率按公允定价加水钱：odds = RTP / pTrue
      const odds = RTP / pTrue;
      return { pTrue, pEst, odds };
    });
    // 穷举所有 k 组合，按模型估计的 valueIndex 取最大
    let best = null;
    const idx = Array.from({ length: k }, (_, i) => i);
    const advance = () => {
      let i = k - 1;
      while (i >= 0 && idx[i] === n - k + i) i -= 1;
      if (i < 0) return false;
      idx[i] += 1;
      for (let j = i + 1; j < k; j += 1) idx[j] = idx[j - 1] + 1;
      return true;
    };
    do {
      let estProb = 1;
      let trueProb = 1;
      let odds = 1;
      for (const i of idx) {
        estProb *= matches[i].pEst;
        trueProb *= matches[i].pTrue;
        odds *= matches[i].odds;
      }
      const vi = estProb * odds;
      if (!best || vi > best.vi) best = { vi, estProb, trueProb, odds };
    } while (advance());
    sumSelectedEstimate += best.estProb * best.odds;
    sumSelectedTrue += best.trueProb * best.odds;
  }
  return {
    estimated: sumSelectedEstimate / trials,
    actual: sumSelectedTrue / trials,
  };
}

console.log("候选场次  关数  组合数   模型说回报指数  实际回报指数   虚高");
for (const [n, k] of [
  [8, 2],
  [8, 3],
  [12, 3],
  [12, 4],
  [16, 4],
]) {
  const total = combinations(n, k);
  const { estimated, actual } = simulateSelectionBias(n, k);
  console.log(
    `${String(n).padStart(6)}场${String(k).padStart(5)}关${String(total).padStart(8)}` +
      `${estimated.toFixed(3).padStart(15)}${actual.toFixed(3).padStart(14)}` +
      `${((estimated - actual) / actual * 100).toFixed(1).padStart(8)}%`,
  );
}
console.log("\n说明：噪声完全无偏（均值0、±8pp），赔率按真实概率公允定价。");
console.log("虚高纯粹来自「从很多组合里挑最好的那个」这个动作本身。");

console.log("\n=== 3. 概率误差在乘法下放大 ===");
console.log("单场概率相对误差 δ，N 关乘积的相对误差 ≈ (1+δ)^N - 1：\n");
console.log("单场误差   2关      3关      4关      5关");
for (const delta of [0.05, 0.1, 0.15, 0.2]) {
  const row = [2, 3, 4, 5]
    .map((n) => pct((1 + delta) ** n - 1).padStart(8))
    .join("");
  console.log(`${pct(delta).padStart(8)}${row}`);
}
