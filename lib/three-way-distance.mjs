import { normalizeOdds, spfDistance } from "./predictor.mjs";

export const THREE_WAY_DISTANCE_METHODS = Object.freeze([
  "relative-max",
  "log-max",
  "hellinger",
  "jensen-shannon",
]);

function validThreeWayOdds(odds) {
  return (
    Array.isArray(odds) &&
    odds.length === 3 &&
    odds.every((value) => Number.isFinite(Number(value)) && Number(value) > 1)
  );
}

function assertComparableOdds(leftOdds, rightOdds) {
  if (!validThreeWayOdds(leftOdds) || !validThreeWayOdds(rightOdds)) {
    throw new TypeError("三项盘距离要求两组长度为3且全部大于1的有效赔率");
  }
}

export function logOddsDistance(leftOdds, rightOdds) {
  assertComparableOdds(leftOdds, rightOdds);
  return Math.max(
    ...leftOdds.map((value, index) =>
      Math.abs(Math.log(Number(value) / Number(rightOdds[index]))),
    ),
  );
}

export function hellingerOddsDistance(leftOdds, rightOdds) {
  assertComparableOdds(leftOdds, rightOdds);
  const left = normalizeOdds(leftOdds);
  const right = normalizeOdds(rightOdds);
  const squared = left.reduce(
    (sum, value, index) =>
      sum + (Math.sqrt(value) - Math.sqrt(right[index])) ** 2,
    0,
  );
  return Math.sqrt(squared / 2);
}

export function jensenShannonOddsDistance(leftOdds, rightOdds) {
  assertComparableOdds(leftOdds, rightOdds);
  const left = normalizeOdds(leftOdds);
  const right = normalizeOdds(rightOdds);
  const midpoint = left.map((value, index) => (value + right[index]) / 2);
  const divergence = (values) =>
    values.reduce(
      (sum, value, index) => sum + value * Math.log(value / midpoint[index]),
      0,
    );
  const value = (divergence(left) + divergence(right)) / 2;
  // 完全相同的分布可能因浮点舍入得到约 -1e-17；JS 散度理论上非负。
  return Math.sqrt(Math.max(0, value));
}

export function threeWayOddsDistance(
  leftOdds,
  rightOdds,
  method = "relative-max",
) {
  switch (method) {
    case "relative-max":
      assertComparableOdds(leftOdds, rightOdds);
      return spfDistance(leftOdds, rightOdds);
    case "log-max":
      return logOddsDistance(leftOdds, rightOdds);
    case "hellinger":
      return hellingerOddsDistance(leftOdds, rightOdds);
    case "jensen-shannon":
      return jensenShannonOddsDistance(leftOdds, rightOdds);
    default:
      throw new RangeError(`未知三项盘距离方法：${method}`);
  }
}
