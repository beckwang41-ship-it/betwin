import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTypesafeWorkflow } from "../lib/typesafe-workflow.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
try {
  const result = await runTypesafeWorkflow({ root,
    database: process.env.BETWIN_DATABASE_PATH || path.join(root, "betwin.db"),
    outputDir: process.env.BETWIN_TYPESAFE_DIR || path.join(root, "data/typesafe"),
    parentPath: arg("parent"), mode: arg("mode") || "predict" });
  console.log(result.summary);
  if (process.env.BETWIN_VERBOSE === "1") console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`TypeSafe E未完成：${error.message}`);
  process.exitCode = 1;
}
