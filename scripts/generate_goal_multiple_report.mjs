import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { exactGoalMultipleRelations } from "../public/goal-multiples.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH = process.env.BETWIN_DATABASE_PATH
  ? path.resolve(process.env.BETWIN_DATABASE_PATH)
  : path.join(ROOT, "betwin.db");
const OUTPUT_PATH = process.env.BETWIN_GOAL_MULTIPLE_REPORT_PATH
  ? path.resolve(process.env.BETWIN_GOAL_MULTIPLE_REPORT_PATH)
  : path.join(ROOT, "倍数赔率历史比赛.html");
const SOURCE_FILE = "历史进球数.xlsx";
const GOAL_LABELS = ["0", "1", "2", "3", "4", "5", "6", "7+"];
const DISTRIBUTION_GOALS = ["2", "3", "4", "5", "6", "7+"];

function buildGoalDistribution(records) {
  const matchingRecords = records.filter(
    (record) => DISTRIBUTION_GOALS.includes(record.goals),
  );
  const grouped = new Map();

  for (const record of matchingRecords) {
    const odds = Number(record.odds[0]);
    const key = odds.toFixed(2);
    const group = grouped.get(key) || {
      odds,
      counts: Object.fromEntries(DISTRIBUTION_GOALS.map((goal) => [goal, 0])),
    };
    group.counts[record.goals] += 1;
    grouped.set(key, group);
  }

  const groups = [...grouped.values()]
    .map((group) => ({
      ...group,
      total: DISTRIBUTION_GOALS.reduce(
        (sum, goal) => sum + group.counts[goal],
        0,
      ),
      share: matchingRecords.length
        ? DISTRIBUTION_GOALS.reduce(
            (sum, goal) => sum + group.counts[goal],
            0,
          ) / matchingRecords.length
        : 0,
    }))
    .sort((left, right) => left.odds - right.odds);

  return {
    total: matchingRecords.length,
    groups,
    maximum: Math.max(0, ...groups.map((group) => group.total)),
  };
}

function reportHtml(records, generatedAt, goalDistribution) {
  const serialized = JSON.stringify(records).replaceAll("<", "\\u003c");
  const distributionRows = goalDistribution.groups
    .map((group) => {
      const percentage = (group.share * 100).toFixed(1);
      const outcomeCells = DISTRIBUTION_GOALS.map((goal) => {
        const outcomePercentage = group.total
          ? ((group.counts[goal] / group.total) * 100).toFixed(1)
          : "0.0";
        return `<td class="dist-outcome"><strong>${group.counts[goal]}场</strong><small>该档 ${outcomePercentage}%</small></td>`;
      }).join("");
      const barWidth = goalDistribution.maximum
        ? ((group.total / goalDistribution.maximum) * 100).toFixed(1)
        : "0";
      const peakClass = group.total === goalDistribution.maximum ? " peak" : "";
      return `<tr class="${peakClass.trim()}">
        <td class="dist-odds">${group.odds.toFixed(2)}</td>
        ${outcomeCells}
        <td class="dist-count"><strong>${group.total}</strong></td>
        <td class="dist-share"><span style="width:${barWidth}%"></span><strong>${percentage}%</strong></td>
      </tr>`;
    })
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>0球整数倍赔率 · 历史比赛档案</title>
  <style>
    :root {
      --ink: #10282c;
      --muted: #708084;
      --paper: #f4f1e7;
      --panel: #fffdf6;
      --line: #ccd0c7;
      --acid: #d9ff3f;
      --red: #d93c25;
      --red-soft: #ffe4dc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        linear-gradient(rgba(16,40,44,.045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(16,40,44,.045) 1px, transparent 1px),
        var(--paper);
      background-size: 32px 32px;
      font-family: "Songti SC", "STSong", "Noto Serif CJK SC", serif;
    }
    button, input, select { font: inherit; }
    .shell { width: min(1780px, calc(100% - 48px)); margin: 28px auto 56px; }
    .masthead {
      position: relative;
      overflow: hidden;
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(320px, .6fr);
      gap: 32px;
      padding: 38px 42px;
      color: #f7f4e9;
      background: var(--ink);
      border-top: 10px solid var(--acid);
    }
    .masthead::after {
      content: "×";
      position: absolute;
      right: 5%; top: -48%;
      font-size: 280px;
      color: rgba(217,255,63,.08);
      transform: rotate(10deg);
    }
    .eyebrow { margin: 0 0 12px; color: #9fadaa; font: 700 13px/1.2 ui-monospace, monospace; letter-spacing: .22em; }
    h1 { margin: 0; font-size: clamp(34px, 4.8vw, 72px); font-weight: 600; letter-spacing: -.04em; }
    .subtitle { max-width: 820px; margin: 18px 0 0; color: #c8d0cd; font-size: 16px; line-height: 1.8; }
    .headline-stats { position: relative; z-index: 1; display: grid; grid-template-columns: 1fr 1fr; align-self: end; border: 1px solid #3d5356; }
    .headline-stats div { padding: 18px; border-right: 1px solid #3d5356; }
    .headline-stats div:last-child { border: 0; }
    .headline-stats span { display: block; color: #96a6a5; font-size: 12px; }
    .headline-stats strong { display: block; margin-top: 5px; color: var(--acid); font: 700 30px/1 ui-monospace, monospace; }
    .distribution {
      background: var(--panel);
      border: 1px solid var(--ink);
      border-top: 0;
    }
    .distribution-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      gap: 24px;
      padding: 22px 26px;
      border-bottom: 1px solid var(--ink);
    }
    .distribution-label { margin: 0 0 8px; color: var(--muted); font: 700 11px/1.2 ui-monospace, monospace; letter-spacing: .15em; }
    .distribution h2 { margin: 0; font-size: clamp(25px, 2.5vw, 42px); font-weight: 600; line-height: 1.15; }
    .distribution-total { display: flex; align-items: baseline; gap: 10px; color: var(--muted); }
    .distribution-total strong { color: var(--red); font: 800 clamp(38px, 4vw, 58px)/1 ui-monospace, monospace; }
    .distribution-table-wrap { max-height: 430px; overflow: auto; }
    .distribution table { min-width: 1280px; }
    .distribution th { top: 0; }
    .distribution td { height: 48px; }
    .distribution .peak td { background: #f1f8d3; }
    .dist-odds { color: var(--red); font: 800 17px/1 ui-monospace, monospace; }
    .dist-count { width: 110px; text-align: right; font-family: ui-monospace, monospace; }
    .dist-outcome { width: 125px; text-align: right; font-family: ui-monospace, monospace; }
    .dist-outcome strong { display: block; font-size: 15px; }
    .dist-outcome small { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; }
    .dist-share { position: relative; width: 22%; min-width: 200px; overflow: hidden; }
    .dist-share span { position: absolute; inset: 8px auto 8px 0; background: var(--red-soft); border-right: 4px solid var(--red); }
    .dist-share strong { position: relative; z-index: 1; display: block; padding-left: 10px; font: 800 14px/1 ui-monospace, monospace; }
    .distribution-note { margin: 0; padding: 13px 26px; color: var(--muted); border-top: 1px solid var(--line); font-size: 13px; line-height: 1.6; }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(240px, 1.4fr) repeat(4, minmax(150px, .55fr));
      gap: 12px;
      padding: 18px;
      background: var(--panel);
      border: 1px solid var(--ink);
      border-top: 0;
    }
    .field { display: grid; gap: 6px; }
    .field label { color: var(--muted); font: 700 11px/1.2 ui-monospace, monospace; letter-spacing: .12em; }
    .field input, .field select {
      min-width: 0;
      height: 44px;
      padding: 0 12px;
      color: var(--ink);
      background: #f7f4eb;
      border: 1px solid var(--line);
      border-radius: 0;
      outline: none;
    }
    .field input:focus, .field select:focus { border-color: var(--ink); box-shadow: inset 0 -3px var(--acid); }
    .table-panel { margin-top: 20px; background: var(--panel); border: 1px solid var(--ink); }
    .table-bar { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 18px; border-bottom: 1px solid var(--ink); }
    .table-bar strong { font-size: 18px; }
    .table-bar span { color: var(--muted); font-size: 13px; }
    .table-wrap { overflow: auto; max-height: 74vh; }
    table { width: 100%; min-width: 1420px; border-collapse: collapse; font-family: "STSong", "Songti SC", serif; }
    th {
      position: sticky; top: 0; z-index: 3;
      padding: 12px 10px;
      color: #d6dedb;
      background: var(--ink);
      border-right: 1px solid #30484b;
      font: 700 12px/1.2 ui-monospace, monospace;
      letter-spacing: .06em;
      text-align: left;
      white-space: nowrap;
    }
    td { padding: 11px 10px; border-right: 1px solid #e1e1d9; border-bottom: 1px solid #dadbd3; white-space: nowrap; }
    tbody tr:hover td { background: #f4f6df; }
    .number { color: #344b4e; font-family: ui-monospace, "SFMono-Regular", monospace; text-align: right; }
    .fixture { min-width: 220px; white-space: normal; font-weight: 700; }
    .actual { text-align: center; font-size: 18px; font-weight: 800; }
    .multiple {
      position: relative;
      color: var(--red) !important;
      background: var(--red-soft) !important;
      font-weight: 900;
    }
    .multiple small { margin-left: 4px; color: #952918; font-size: 10px; }
    .relation { min-width: 250px; color: var(--red); white-space: normal; font: 700 12px/1.6 ui-monospace, monospace; }
    .empty { padding: 70px 20px; color: var(--muted); text-align: center; }
    .pager { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px 18px; border-top: 1px solid var(--ink); }
    .pager-controls { display: flex; align-items: center; gap: 8px; }
    .pager button {
      height: 36px; padding: 0 14px;
      color: var(--panel); background: var(--ink); border: 1px solid var(--ink); cursor: pointer;
    }
    .pager button:disabled { opacity: .3; cursor: not-allowed; }
    .note { margin: 15px 0 0; color: var(--muted); font-size: 13px; line-height: 1.7; }
    @media (max-width: 980px) {
      .shell { width: calc(100% - 20px); margin-top: 10px; }
      .masthead { grid-template-columns: 1fr; padding: 28px 24px; }
      .distribution-head { grid-template-columns: 1fr; }
      .toolbar { grid-template-columns: 1fr 1fr; }
      .field:first-child { grid-column: 1 / -1; }
    }
    @media print {
      body { background: #fff; }
      .shell { width: 100%; margin: 0; }
      .toolbar, .pager { display: none; }
      .table-wrap { max-height: none; overflow: visible; }
      th { position: static; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="masthead">
      <div>
        <p class="eyebrow">GOAL ODDS / INTEGER MULTIPLE ARCHIVE</p>
        <h1>0球整数倍赔率档案</h1>
        <p class="subtitle">仅收录《历史进球数.xlsx》的最终赔率；0球赔率必须不低于11，并且是1球至7+球中至少一项赔率的整数倍。红色表示构成倍数关系的赔率。</p>
      </div>
      <div class="headline-stats" aria-label="报告概要">
        <div><span>符合比赛</span><strong id="total-count">—</strong></div>
        <div><span>倍数关系</span><strong id="relation-count">—</strong></div>
      </div>
    </header>

    <section class="distribution" aria-label="实际2球至7+球的0球赔率分布">
      <header class="distribution-head">
        <div>
          <p class="distribution-label">GOAL 2 → 7+ / 0球赔率总表</p>
          <h2>一个0球赔率，对应各进球数有多少场</h2>
        </div>
        <div class="distribution-total"><strong>${goalDistribution.total.toLocaleString("zh-CN")}</strong><span>场2球至7+球比赛</span></div>
      </header>
      <div class="distribution-table-wrap">
        <table>
          <thead><tr><th>0球赔率</th>${DISTRIBUTION_GOALS.map((goal) => `<th>实际${goal}球（该档占比）</th>`).join("")}<th>2球至7+合计</th><th>该档占全部${goalDistribution.total.toLocaleString("zh-CN")}场</th></tr></thead>
          <tbody>${distributionRows}</tbody>
        </table>
      </div>
      <p class="distribution-note">每个进球格子的“该档占比”，分母是同一0球赔率下2球至7+球的合计场次；最后一列的分母是本表全部${goalDistribution.total.toLocaleString("zh-CN")}场。统计范围仍是整数倍比赛，且0球赔率不低于11。</p>
    </section>

    <section class="toolbar" aria-label="筛选条件">
      <div class="field">
        <label for="search">比赛 / 联赛 / 比分</label>
        <input id="search" type="search" placeholder="例如：英超、曼联、2:1">
      </div>
      <div class="field">
        <label for="band">0球赔率区间</label>
        <select id="band">
          <option value="all">全部（≥11）</option>
          <option value="11-19">11～18.99</option>
          <option value="19-26">19～25.99</option>
          <option value="26-33">26～32.99</option>
          <option value="33+">33以上</option>
        </select>
      </div>
      <div class="field">
        <label for="actual">实际进球</label>
        <select id="actual"><option value="all">全部赛果</option></select>
      </div>
      <div class="field">
        <label for="multiple-filter">整数倍</label>
        <select id="multiple-filter"><option value="all">全部倍数</option></select>
      </div>
      <div class="field">
        <label for="page-size">每页显示</label>
        <select id="page-size">
          <option value="50">50场</option>
          <option value="100" selected>100场</option>
          <option value="250">250场</option>
          <option value="all">全部</option>
        </select>
      </div>
    </section>

    <section class="table-panel">
      <div class="table-bar">
        <strong id="result-title">符合条件的历史比赛</strong>
        <span>按源文件行号由新到旧</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>源行</th><th>联赛</th><th>比赛</th><th>比分</th><th>实际进球</th>
              <th>0球</th><th>1球</th><th>2球</th><th>3球</th><th>4球</th><th>5球</th><th>6球</th><th>7+球</th><th>倍数关系</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
      <div class="pager">
        <span id="page-state">—</span>
        <div class="pager-controls"><button id="previous" type="button">上一页</button><button id="next" type="button">下一页</button></div>
      </div>
    </section>
    <p class="note">生成时间：${generatedAt}。整数倍按Excel显示精度严格计算，例如16.00＝4.00×4；近似倍数不计入。该页面只展示历史事实，不代表倍数规律已经通过预测验证。</p>
  </main>

  <script>
    const records = ${serialized};
    const goalLabels = ["0", "1", "2", "3", "4", "5", "6", "7+"];
    const state = { page: 1, filtered: records };
    const byId = (id) => document.getElementById(id);
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
    const oddsText = (value) => Number(value).toFixed(2);

    function populateFilters() {
      for (const label of goalLabels) {
        const option = document.createElement("option");
        option.value = label; option.textContent = label + "球";
        byId("actual").append(option);
      }
      const multiples = [...new Set(records.flatMap((record) => record.relations.map((item) => item.multiple)))].sort((a, b) => a - b);
      for (const multiple of multiples) {
        const option = document.createElement("option");
        option.value = String(multiple); option.textContent = multiple + "倍";
        byId("multiple-filter").append(option);
      }
      byId("total-count").textContent = records.length.toLocaleString("zh-CN");
      byId("relation-count").textContent = records.reduce((sum, record) => sum + record.relations.length, 0).toLocaleString("zh-CN");
    }

    function inBand(value, band) {
      if (band === "11-19") return value >= 11 && value < 19;
      if (band === "19-26") return value >= 19 && value < 26;
      if (band === "26-33") return value >= 26 && value < 33;
      if (band === "33+") return value >= 33;
      return true;
    }

    function applyFilters() {
      const query = byId("search").value.trim().toLowerCase();
      const band = byId("band").value;
      const actual = byId("actual").value;
      const multiple = byId("multiple-filter").value;
      state.filtered = records.filter((record) => {
        const haystack = [record.league, record.home, record.away, record.score, record.sourceRow].join(" ").toLowerCase();
        return (!query || haystack.includes(query)) &&
          inBand(record.odds[0], band) &&
          (actual === "all" || record.goals === actual) &&
          (multiple === "all" || record.relations.some((item) => String(item.multiple) === multiple));
      });
      state.page = 1;
      render();
    }

    function oddsCell(record, index) {
      const relation = record.relations.find((item) => item.index === index);
      const marked = index === 0 || Boolean(relation);
      const badge = relation ? "<small>×" + relation.multiple + "</small>" : "";
      return '<td class="number ' + (marked ? "multiple" : "") + '">' + oddsText(record.odds[index]) + badge + "</td>";
    }

    function rowHtml(record) {
      const relations = record.relations.map((item) => "0球 " + oddsText(record.odds[0]) + " = " + item.label + "球 " + oddsText(record.odds[item.index]) + " × " + item.multiple).join("<br>");
      return "<tr>" +
        '<td class="number">' + record.sourceRow + "</td>" +
        "<td>" + escapeHtml(record.league) + "</td>" +
        '<td class="fixture">' + escapeHtml(record.home) + " vs " + escapeHtml(record.away) + "</td>" +
        "<td>" + escapeHtml(record.score) + "</td>" +
        '<td class="actual">' + escapeHtml(record.goals) + "</td>" +
        record.odds.map((_, index) => oddsCell(record, index)).join("") +
        '<td class="relation">' + relations + "</td></tr>";
    }

    function render() {
      const rawSize = byId("page-size").value;
      const size = rawSize === "all" ? Math.max(1, state.filtered.length) : Number(rawSize);
      const pages = Math.max(1, Math.ceil(state.filtered.length / size));
      state.page = Math.min(state.page, pages);
      const start = (state.page - 1) * size;
      const visible = state.filtered.slice(start, start + size);
      byId("rows").innerHTML = visible.length ? visible.map(rowHtml).join("") : '<tr><td class="empty" colspan="14">当前筛选条件下没有比赛</td></tr>';
      byId("result-title").textContent = "符合条件 " + state.filtered.length.toLocaleString("zh-CN") + " 场";
      byId("page-state").textContent = state.filtered.length ? "第 " + state.page + " / " + pages + " 页 · 当前显示 " + (start + 1) + "～" + Math.min(start + size, state.filtered.length) + " 场" : "0 场";
      byId("previous").disabled = state.page <= 1;
      byId("next").disabled = state.page >= pages;
    }

    for (const id of ["search", "band", "actual", "multiple-filter", "page-size"]) {
      byId(id).addEventListener(id === "search" ? "input" : "change", applyFilters);
    }
    byId("previous").addEventListener("click", () => { state.page -= 1; render(); });
    byId("next").addEventListener("click", () => { state.page += 1; render(); });
    populateFilters();
    render();
  </script>
</body>
</html>`;
}

const store = createDataStore(DATABASE_PATH);
try {
  const records = store
    .getVerifiedHistory()
    .filter(
      (row) =>
        row.goalSourceFile === SOURCE_FILE &&
        Number(row.goalMarket?.odds?.[0]) >= 11,
    )
    .map((row) => {
      const odds = row.goalMarket.odds.map(Number);
      return {
        sourceRow: Number(row.goalSourceRow),
        league: row.league,
        home: row.home,
        away: row.away,
        score: row.score,
        goals: String(row.goals),
        odds,
        relations: exactGoalMultipleRelations(odds, GOAL_LABELS),
      };
    })
    .filter((row) => row.relations.length)
    .sort((left, right) => right.sourceRow - left.sourceRow);
  const goalDistribution = buildGoalDistribution(records);
  const generatedAt = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "long",
    timeStyle: "medium",
    timeZone: "Asia/Shanghai",
  }).format(new Date());
  writeFileSync(
    OUTPUT_PATH,
    reportHtml(records, generatedAt, goalDistribution),
    "utf8",
  );
  const relations = records.reduce(
    (sum, record) => sum + record.relations.length,
    0,
  );
  console.log(`已生成：${OUTPUT_PATH}`);
  console.log(`符合条件：${records.length.toLocaleString()} 场`);
  console.log(`整数倍关系：${relations.toLocaleString()} 条`);
  const peak = goalDistribution.groups.find(
    (group) => group.total === goalDistribution.maximum,
  );
  console.log(`实际2球至7+球：${goalDistribution.total.toLocaleString()} 场`);
  if (peak) {
    console.log(
      `合计最多的0球赔率：${peak.odds.toFixed(2)}，${peak.total} 场（${(peak.share * 100).toFixed(1)}%）`,
    );
  }
} finally {
  store.close();
}
