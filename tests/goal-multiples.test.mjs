import assert from "node:assert/strict";
import test from "node:test";
import { exactGoalMultipleRelations } from "../public/goal-multiples.js";

test("0球赔率按两位小数严格识别整数倍关系", () => {
  assert.deepEqual(
    exactGoalMultipleRelations([12, 4.9, 3, 3.4, 4.2, 7, 11, 18]),
    [{ index: 2, label: "2", multiple: 4 }],
  );
  assert.deepEqual(
    exactGoalMultipleRelations([23, 7.4, 4.2, 3.3, 4.4, 6.7, 11.5, 14]),
    [{ index: 6, label: "6", multiple: 2 }],
  );
});

test("近似倍数和小于2倍的关系不标记", () => {
  assert.deepEqual(
    exactGoalMultipleRelations([12, 4.01, 3.01, 3.4, 4.2, 7, 11, 18]),
    [],
  );
  assert.deepEqual(exactGoalMultipleRelations([4, 5, 6, 7, 8, 9, 10, 11]), []);
});
