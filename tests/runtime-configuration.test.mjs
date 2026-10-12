import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeConfiguration, currentAlgorithmVersions, assertRuntimeUnchanged } from "../lib/runtime-configuration.mjs";

test("配置变化和历史更新重新加载，未变化复用，失败不提交半套配置", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "betwin-runtime-"));
  try {
    const file = path.join(dir, "policy.json");
    let source = "batch-1", loads = 0, fail = false, mutate = false;
    writeFileSync(file, "{}");
    const manager = createRuntimeConfiguration({ files: [file], sourceVersion: () => source, load() {
      loads++;
      if (fail) throw new Error("broken policy");
      if (mutate) source += "-changed";
      return { loads };
    } });
    const first = manager.get();
    assert.equal(manager.get(), first);
    source = "batch-2";
    assert.equal(manager.get().value.loads, 2);
    writeFileSync(file, '{"enabled":false}');
    const next = manager.get();
    assert.equal(next.value.loads, 3);
    fail = true; source = "batch-3";
    assert.throws(() => manager.get(), /broken policy/);
    fail = false; mutate = true;
    assert.throws(() => manager.get(), /正在更新/);
    mutate = false;
    assert.notEqual(manager.get().revision, next.revision);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("冻结读取结构化版本，允许平滑后缀，不借用同联赛或猜测缺失版本", () => {
  const spec = { versions: Object.fromEntries(["spf", "hhad", "goals"].map(m => [m, {
    all: `model:${m}:all-leagues:smoothing-abcdef0123456789`, sameLeague: `model:${m}:same-league`,
  }])) };
  assert.equal(currentAlgorithmVersions(spec).hhad, spec.versions.hhad.all);
  delete spec.versions.hhad.all;
  assert.throws(() => currentAlgorithmVersions(spec), /hhad缺少结构化/);
  assert.throws(() => currentAlgorithmVersions(null), /结构化/);
});

test("冻结期间配置、代码、数据库或任意玩法版本变化都拒绝混合", () => {
  const expected = { runtime: { revision: "r1", codeSignature: "code", databaseIdentity: "db" },
    currentAlgorithmSpec: { versions: Object.fromEntries(["spf", "hhad", "goals"].map(m => [m, { all: m }])) } };
  assert.doesNotThrow(() => assertRuntimeUnchanged(expected, structuredClone(expected)));
  for (const key of ["revision", "codeSignature", "databaseIdentity"]) {
    const actual = structuredClone(expected); actual.runtime[key] += "-new";
    assert.throws(() => assertRuntimeUnchanged(expected, actual), /拒绝混合批次/);
  }
  const changed = structuredClone(expected);
  changed.currentAlgorithmSpec.versions.hhad.all += ":smoothing-123";
  assert.throws(() => assertRuntimeUnchanged(expected, changed), /拒绝混合批次/);
  assert.throws(() => assertRuntimeUnchanged(expected, {}), /拒绝混合批次/);
});
