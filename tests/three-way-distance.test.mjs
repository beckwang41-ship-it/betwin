import assert from "node:assert/strict";
import test from "node:test";
import {
  hellingerOddsDistance,
  jensenShannonOddsDistance,
  logOddsDistance,
  threeWayOddsDistance,
} from "../lib/three-way-distance.mjs";

const LEFT = [2, 3.2, 4.1];
const RIGHT = [2.1, 3.1, 4];

test("三项盘距离在相同赔率下为0且保持对称", () => {
  for (const method of ["log-max", "hellinger", "jensen-shannon"]) {
    assert.equal(threeWayOddsDistance(LEFT, LEFT, method), 0);
    assert.ok(
      Math.abs(
        threeWayOddsDistance(LEFT, RIGHT, method) -
          threeWayOddsDistance(RIGHT, LEFT, method),
      ) < 1e-12,
    );
  }
});

test("概率空间距离忽略三项赔率的共同倍率", () => {
  const scaled = LEFT.map((value) => value * 1.15);
  assert.ok(hellingerOddsDistance(LEFT, scaled) < 1e-12);
  assert.ok(jensenShannonOddsDistance(LEFT, scaled) < 1e-12);
  assert.ok(logOddsDistance(LEFT, scaled) > 0.1);
});

test("相对赔率基线保持现有最大相对误差定义", () => {
  const expected = Math.max(
    ...LEFT.map((value, index) => Math.abs(value / RIGHT[index] - 1)),
  );
  assert.equal(threeWayOddsDistance(LEFT, RIGHT), expected);
});

test("无效赔率与未知方法快速报错", () => {
  assert.throws(
    () => threeWayOddsDistance([2, 3], RIGHT, "hellinger"),
    /长度为3/,
  );
  assert.throws(
    () => threeWayOddsDistance(LEFT, RIGHT, "unknown"),
    /未知三项盘距离方法/,
  );
});
