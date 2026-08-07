import { readFileSync } from "node:fs";

const TEAM_NAME_PATH = new URL("../teamname.json", import.meta.url);

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·•]/g, "");
}

function loadTeamNameAliases() {
  let entries;
  try {
    const parsed = JSON.parse(readFileSync(TEAM_NAME_PATH, "utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new TypeError("根节点必须是名称到标准名称的对象");
    }
    entries = Object.entries(parsed);
  } catch (error) {
    throw new Error(`无法读取球队别名表 teamname.json：${error.message}`, {
      cause: error,
    });
  }

  return new Map(
    entries.map(([alias, canonical]) => [
      normalizeText(alias),
      normalizeText(canonical),
    ]),
  );
}

const TEAM_NAME_ALIASES = loadTeamNameAliases();

export function normalizeFixtureText(value) {
  return normalizeText(value);
}

export function normalizeTeamName(value) {
  let normalized = normalizeText(value);
  const visited = new Set();
  while (TEAM_NAME_ALIASES.has(normalized) && !visited.has(normalized)) {
    visited.add(normalized);
    const canonical = TEAM_NAME_ALIASES.get(normalized);
    if (!canonical || canonical === normalized) break;
    normalized = canonical;
  }
  return normalized;
}
