// 一次性只读诊断：验证对称 Jeffreys 平滑不改变 argmax 是数学必然，
// 而非当前数据的巧合。
// 对称平滑 p_i = (c_i + a) / (n + k*a) 是各分量的同一个单调仿射变换：
// 分母对所有 i 相同，分子加同一常数 a，所以 c_i 的大小顺序完全保留，
// 并列结构也完全保留（c_i = c_j ⇔ p_i = p_j）。
// 这里用穷举 + 随机验证做实证确认。
const LABELS = 3;
const ALPHA = 0.5;

function argmaxSet(values) {
  const max = Math.max(...values);
  return values
    .map((value, index) => (Math.abs(value - max) < 1e-12 ? index : -1))
    .filter((index) => index >= 0)
    .join(",");
}

function jeffreys(counts) {
  const total = counts.reduce((sum, value) => sum + value, 0);
  const denominator = total + LABELS * ALPHA;
  return counts.map((count) => (count + ALPHA) / denominator);
}

let checked = 0;
let mismatched = 0;

// 穷举所有 n <= 40 的三分类计数组合
for (let a = 0; a <= 40; a += 1) {
  for (let b = 0; a + b <= 40; b += 1) {
    for (let c = 0; a + b + c <= 40; c += 1) {
      const total = a + b + c;
      if (total === 0) continue;
      const counts = [a, b, c];
      const raw = counts.map((count) => count / total);
      const smoothed = jeffreys(counts);
      checked += 1;
      if (argmaxSet(raw) !== argmaxSet(smoothed)) {
        mismatched += 1;
        if (mismatched <= 5) {
          console.log("  反例 counts=" + counts.join("/"), raw, smoothed);
        }
      }
    }
  }
}

console.log("穷举 n<=40 的三分类计数组合：");
console.log("  检查 " + checked + " 组，argmax（含并列结构）不一致 " + mismatched + " 组");
console.log(
  mismatched === 0
    ? "  → 对称 Jeffreys 平滑完全保留 argmax 与并列结构，符合数学预期。"
    : "  → 出现反例，需要复查实现。",
);

// 抽查大样本
let bigChecked = 0;
let bigMismatched = 0;
for (let trial = 0; trial < 200000; trial += 1) {
  const counts = [
    Math.floor(Math.random() * 500),
    Math.floor(Math.random() * 500),
    Math.floor(Math.random() * 500),
  ];
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (!total) continue;
  const raw = counts.map((count) => count / total);
  bigChecked += 1;
  if (argmaxSet(raw) !== argmaxSet(jeffreys(counts))) bigMismatched += 1;
}
console.log("\n随机抽查 n 最大 1500 的组合：");
console.log("  检查 " + bigChecked + " 组，不一致 " + bigMismatched + " 组");
