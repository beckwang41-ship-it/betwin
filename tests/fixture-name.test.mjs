import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFixtureText,
  normalizeTeamName,
} from "../lib/fixture-name.mjs";

test("fixture names normalize harmless spacing and separators", () => {
  assert.equal(
    normalizeFixtureText(" 帕梅拉斯 · U23 "),
    normalizeFixtureText("帕梅拉斯U23"),
  );
});

test("known team aliases resolve to one canonical name", () => {
  assert.equal(
    normalizeTeamName("帕尔梅拉斯"),
    normalizeTeamName("帕梅拉斯"),
  );
});

test("settlement aliases from teamname.json resolve to one team", () => {
  for (const [alias, canonical] of [
    ["弗鲁米嫩", "弗鲁米嫩塞"],
    ["达伽马", "瓦斯科达伽马"],
    ["圣吉尔联合", "圣吉联合"],
    ["布拉格斯巴达", "布斯巴达"],
    ["格风暴", "格拉茨风暴"],
  ]) {
    assert.equal(normalizeTeamName(alias), normalizeTeamName(canonical));
  }
});

test("different teams are not merged by fuzzy matching", () => {
  assert.notEqual(
    normalizeTeamName("维多利亚"),
    normalizeTeamName("维多利亚FC"),
  );
});
