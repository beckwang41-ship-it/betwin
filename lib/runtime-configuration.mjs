import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const hash = value => createHash("sha256").update(value).digest("hex");

export function runtimeCodeSignature(root) {
  const files = ["server.mjs", ...readdirSync(path.join(root, "lib"))
    .filter(name => name.endsWith(".mjs")).sort().map(name => `lib/${name}`),
  "public/goal-multiples.js"];
  return hash(JSON.stringify(files.map(file => [file, hash(readFileSync(path.join(root, file)))])));
}

export const databaseIdentity = filename => hash(path.resolve(filename));

// 只在文件或历史水位变化时重建；整组配置加载成功后才替换，避免新旧规则混用。
export function createRuntimeConfiguration({ files, sourceVersion, load }) {
  let current;
  const signature = () => hash(JSON.stringify([sourceVersion(), files.map(file => {
    try {
      const stat = statSync(file, { bigint: true });
      return [file, String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)];
    } catch (error) {
      if (error.code === "ENOENT") return [file, "missing"];
      throw error;
    }
  })]));
  return {
    get() {
      const revision = signature();
      if (current?.revision === revision) return current;
      const value = load();
      if (signature() !== revision) throw new Error("配置或历史数据正在更新，请完成更新后重试");
      current = { revision, value };
      return current;
    },
  };
}

export function currentAlgorithmVersions(spec, markets = ["spf", "hhad", "goals"]) {
  return Object.fromEntries(markets.map(market => {
    const version = spec?.versions?.[market]?.all;
    if (typeof version !== "string" || !version) throw new Error(`${market}缺少结构化算法版本，请更新预测服务`);
    return [market, version];
  }));
}

export function assertRuntimeUnchanged(expected, actual) {
  const sameIdentity = ["revision", "codeSignature", "databaseIdentity"].every(key =>
    typeof expected?.runtime?.[key] === "string" && expected.runtime[key] === actual?.runtime?.[key]);
  if (!sameIdentity || JSON.stringify(currentAlgorithmVersions(expected.currentAlgorithmSpec)) !==
    JSON.stringify(currentAlgorithmVersions(actual.currentAlgorithmSpec))) {
    throw new Error("冻结期间预测配置或算法版本变化，拒绝混合批次，请重新执行更新命令");
  }
}
