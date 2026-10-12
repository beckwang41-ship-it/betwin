import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script=fileURLToPath(new URL("../scripts/compare_goal_pairs.mjs",import.meta.url));
test("双选研究拒绝覆盖已有报告或逐场档案，且不启动数据库读取", () => {
  const directory=mkdtempSync(path.join(tmpdir(),"betwin-goal-pair-report-"));
  try {
    for (const suffix of ["json","md","cases.jsonl"]) {
      const prefix=path.join(directory,`run-${suffix.replaceAll(".","-")}`);
      const file=`${prefix}.${suffix}`;
      writeFileSync(file,"旧实验内容\n");
      const run=spawnSync(process.execPath,["--disable-warning=ExperimentalWarning",script,`--output=${prefix}.json`],{
        cwd:directory,encoding:"utf8",env:{...process.env,BETWIN_DATABASE_PATH:path.join(directory,"missing.db")},
      });
      assert.notEqual(run.status,0);
      assert.match(run.stderr,/输出已存在/);
      assert.equal(readFileSync(file,"utf8"),"旧实验内容\n");
    }
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
