import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import {
  GOAL_EQUALITY_PAIRS,
  buildGoalMultipleDistribution,
  exactGoalMultipleRelations,
  exactGoalOddsEqualities,
} from "../public/goal-multiples.js";

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
  const rawGroups = buildGoalMultipleDistribution(records);
  const total = rawGroups.reduce((sum, group) => sum + group.samples, 0);
  const groups = rawGroups
    .map((group) => ({
      odds: group.zeroOdds,
      counts: group.counts,
      total: group.samples,
      share: total ? group.samples / total : 0,
    }))
    .sort((left, right) => left.odds - right.odds);

  return {
    total,
    groups,
    maximum: Math.max(0, ...groups.map((group) => group.total)),
  };
}

function buildEqualityRecords(history) {
  return history.flatMap((row) => {
    const odds = row.odds.map(Number);
    return exactGoalOddsEqualities(odds).map((relation) => ({
      pairId: relation.id,
      pairLabel: relation.label,
      equalOdds: relation.equalOdds,
      goals: String(row.goals),
      league: row.league,
      home: row.home,
      away: row.away,
      sourceFile: row.sourceFile,
      sourceRow: Number(row.sourceRow),
    }));
  });
}

function reportHtml(
  records,
  generatedAt,
  goalDistribution,
  equalityRecords,
  equalityDatabaseRows,
) {
  const serialized = JSON.stringify(records).replaceAll("<", "\\u003c");
  const serializedEqualities = JSON.stringify(equalityRecords).replaceAll(
    "<",
    "\\u003c",
  );
  const serializedEqualityPairs = JSON.stringify(GOAL_EQUALITY_PAIRS);
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
      return `<tr class="${peakClass.trim()}" data-zero-odds="${group.odds.toFixed(2)}">
        <td class="dist-odds"><button type="button" data-select-zero-odds="${group.odds.toFixed(2)}" aria-label="查看0球赔率${group.odds.toFixed(2)}的${group.total}场比赛">${group.odds.toFixed(2)}</button></td>
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
    .distribution tbody tr[data-zero-odds] { cursor: pointer; }
    .distribution tbody tr[data-zero-odds]:hover td { background: #fff2ec; }
    .distribution tbody tr.selected td { background: #f1f8d3; box-shadow: inset 0 2px var(--acid), inset 0 -2px var(--acid); }
    .distribution tbody tr.selected .dist-odds { box-shadow: inset 6px 0 var(--red), inset 0 2px var(--acid), inset 0 -2px var(--acid); }
    .dist-odds { color: var(--red); font: 800 17px/1 ui-monospace, monospace; }
    .dist-odds button {
      width: 100%;
      padding: 8px 6px;
      color: inherit;
      background: transparent;
      border: 0;
      cursor: pointer;
      font: inherit;
      text-align: left;
    }
    .dist-odds button::after { content: " →"; opacity: 0; transition: opacity .16s ease, transform .16s ease; }
    .distribution tbody tr:hover .dist-odds button::after,
    .distribution tbody tr.selected .dist-odds button::after { opacity: 1; }
    .dist-count { width: 110px; text-align: right; font-family: ui-monospace, monospace; }
    .dist-outcome { width: 125px; text-align: right; font-family: ui-monospace, monospace; }
    .dist-outcome strong { display: block; font-size: 15px; }
    .dist-outcome small { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; }
    .dist-share { position: relative; width: 22%; min-width: 200px; overflow: hidden; }
    .dist-share span { position: absolute; inset: 8px auto 8px 0; background: var(--red-soft); border-right: 4px solid var(--red); }
    .dist-share strong { position: relative; z-index: 1; display: block; padding-left: 10px; font: 800 14px/1 ui-monospace, monospace; }
    .distribution-note { margin: 0; padding: 13px 26px; color: var(--muted); border-top: 1px solid var(--line); font-size: 13px; line-height: 1.6; }
    .odds-drilldown { border-top: 8px solid var(--ink); background: #faf8f0; scroll-margin-top: 18px; }
    .odds-drilldown[hidden] { display: none; }
    .odds-drilldown-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(230px, 300px);
      align-items: end;
      gap: 28px;
      padding: 24px 26px 20px;
      border-bottom: 1px solid var(--ink);
    }
    .odds-drilldown-label { margin: 0 0 7px; color: var(--muted); font: 700 11px/1.2 ui-monospace, monospace; letter-spacing: .15em; }
    .odds-drilldown h3 { margin: 0; font-size: clamp(24px, 2.2vw, 36px); font-weight: 600; line-height: 1.15; }
    .odds-drilldown-total { display: flex; align-items: baseline; gap: 8px; color: var(--muted); white-space: nowrap; }
    .odds-drilldown-total strong { color: var(--red); font: 800 36px/1 ui-monospace, monospace; }
    .odds-drilldown-field { display: grid; gap: 6px; }
    .odds-drilldown-field label { color: var(--muted); font: 700 11px/1.2 ui-monospace, monospace; letter-spacing: .12em; }
    .odds-drilldown-field select { width: 100%; height: 46px; padding: 0 12px; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 0; }
    .odds-drilldown-table-wrap { max-height: 520px; overflow: auto; }
    .odds-drilldown table { min-width: 1320px; }
    .odds-drilldown .fixture { min-width: 240px; }
    .odds-drilldown-note { margin: 0; padding: 12px 26px; color: var(--muted); border-top: 1px solid var(--line); font-size: 13px; line-height: 1.6; }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(240px, 1.4fr) repeat(5, minmax(140px, .55fr));
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
    .band-summary {
      background: var(--panel);
      border: 1px solid var(--ink);
      border-top: 0;
    }
    .band-summary-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      gap: 24px;
      padding: 22px 26px 18px;
      border-bottom: 1px solid var(--line);
    }
    .band-summary-label { margin: 0 0 7px; color: var(--muted); font: 700 11px/1.2 ui-monospace, monospace; letter-spacing: .15em; }
    .band-summary h2 { margin: 0; font-size: clamp(24px, 2vw, 34px); font-weight: 600; line-height: 1.2; }
    .band-summary-total { display: flex; align-items: baseline; gap: 9px; color: var(--muted); white-space: nowrap; }
    .band-summary-total strong { color: var(--red); font: 800 36px/1 ui-monospace, monospace; }
    .band-goal-grid { display: grid; grid-template-columns: repeat(8, minmax(110px, 1fr)); }
    .band-goal-card {
      position: relative;
      min-height: 142px;
      padding: 18px 16px 16px;
      overflow: hidden;
      border-right: 1px solid var(--line);
    }
    .band-goal-card:last-child { border-right: 0; }
    .band-goal-card.leader { background: #f1f8d3; }
    .band-goal-card.leader::before { content: ""; position: absolute; inset: 0 0 auto; height: 5px; background: var(--acid); }
    .band-goal-name { display: block; color: var(--muted); font: 700 12px/1.2 ui-monospace, monospace; letter-spacing: .08em; }
    .band-goal-percent { display: block; margin-top: 13px; font: 800 28px/1 ui-monospace, monospace; }
    .band-goal-count { display: block; margin-top: 8px; color: var(--muted); font: 600 12px/1.2 ui-monospace, monospace; }
    .band-goal-track { position: absolute; right: 16px; bottom: 15px; left: 16px; height: 5px; background: #e4e2d9; }
    .band-goal-track span { display: block; height: 100%; background: var(--red); }
    .band-summary-note { margin: 0; padding: 12px 26px; color: var(--muted); border-top: 1px solid var(--line); font-size: 13px; line-height: 1.6; }
    .equality-analysis { margin-top: 20px; background: var(--panel); border: 1px solid var(--ink); }
    .equality-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      gap: 28px;
      padding: 26px;
      color: #f7f4e9;
      background: var(--ink);
      border-bottom: 6px solid var(--acid);
    }
    .equality-label { margin: 0 0 8px; color: #9fadaa; font: 700 11px/1.2 ui-monospace, monospace; letter-spacing: .16em; }
    .equality-head h2 { margin: 0; font-size: clamp(27px, 2.7vw, 44px); font-weight: 600; line-height: 1.15; }
    .equality-total { display: flex; align-items: baseline; gap: 9px; color: #9fadaa; white-space: nowrap; }
    .equality-total strong { color: var(--acid); font: 800 42px/1 ui-monospace, monospace; }
    .equality-controls {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(210px, 280px);
      gap: 18px;
      padding: 18px 22px;
      border-bottom: 1px solid var(--line);
    }
    .equality-tabs { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 8px; }
    .equality-tab {
      min-height: 58px;
      padding: 8px 13px;
      color: var(--ink);
      background: #ece9df;
      border: 1px solid var(--line);
      cursor: pointer;
      text-align: left;
    }
    .equality-tab strong { display: block; font-size: 16px; }
    .equality-tab small { display: block; margin-top: 5px; color: var(--muted); font: 700 11px/1 ui-monospace, monospace; }
    .equality-tab.active { color: var(--panel); background: var(--ink); border-color: var(--ink); box-shadow: inset 0 -4px var(--acid); }
    .equality-tab.active small { color: #b7c3c1; }
    .equality-price-field { display: grid; gap: 6px; }
    .equality-price-field label { color: var(--muted); font: 700 11px/1.2 ui-monospace, monospace; letter-spacing: .12em; }
    .equality-price-field select { width: 100%; height: 58px; padding: 0 12px; color: var(--ink); background: #f7f4eb; border: 1px solid var(--line); border-radius: 0; }
    .equality-grid { display: grid; grid-template-columns: repeat(8, minmax(110px, 1fr)); }
    .equality-grid .band-goal-card { border-top: 0; }
    .equality-note { margin: 0; padding: 13px 22px; color: var(--muted); border-top: 1px solid var(--line); font-size: 13px; line-height: 1.65; }
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
      .odds-drilldown-head { grid-template-columns: 1fr 1fr; }
      .odds-drilldown-field { grid-column: 1 / -1; }
      .band-summary-head { grid-template-columns: 1fr; }
      .band-goal-grid { grid-template-columns: repeat(4, minmax(110px, 1fr)); }
      .band-goal-card:nth-child(4) { border-right: 0; }
      .band-goal-card:nth-child(-n+4) { border-bottom: 1px solid var(--line); }
      .equality-head, .equality-controls { grid-template-columns: 1fr; }
      .equality-tabs { grid-template-columns: 1fr 1fr; }
      .equality-grid { grid-template-columns: repeat(4, minmax(110px, 1fr)); }
      .equality-grid .band-goal-card:nth-child(4) { border-right: 0; }
      .equality-grid .band-goal-card:nth-child(-n+4) { border-bottom: 1px solid var(--line); }
      .toolbar { grid-template-columns: 1fr 1fr; }
      .field:first-child { grid-column: 1 / -1; }
    }
    @media (max-width: 560px) {
      .band-goal-grid { grid-template-columns: repeat(2, minmax(110px, 1fr)); }
      .band-goal-card:nth-child(2n) { border-right: 0; }
      .band-goal-card:nth-child(-n+6) { border-bottom: 1px solid var(--line); }
      .equality-tabs { grid-template-columns: 1fr; }
      .equality-grid { grid-template-columns: repeat(2, minmax(110px, 1fr)); }
      .equality-grid .band-goal-card:nth-child(2n) { border-right: 0; }
      .equality-grid .band-goal-card:nth-child(-n+6) { border-bottom: 1px solid var(--line); }
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
      <section id="odds-drilldown" class="odds-drilldown" aria-label="选中0球赔率的历史比赛" hidden>
        <header class="odds-drilldown-head">
          <div>
            <p class="odds-drilldown-label">SELECTED ODDS / 逐场历史明细</p>
            <h3 id="odds-drilldown-title">选中一个0球赔率查看比赛</h3>
          </div>
          <div class="odds-drilldown-total"><strong id="odds-drilldown-total">—</strong><span id="odds-drilldown-total-label">场比赛</span></div>
          <div class="odds-drilldown-field">
            <label for="odds-drilldown-league">按联赛筛选</label>
            <select id="odds-drilldown-league"><option value="all">全部联赛</option></select>
          </div>
        </header>
        <div class="odds-drilldown-table-wrap">
          <table>
            <thead>
              <tr>
                <th>联赛</th><th>比赛</th><th>比分</th><th>实际进球</th>
                <th>0球</th><th>1球</th><th>2球</th><th>3球</th><th>4球</th><th>5球</th><th>6球</th><th>7+球</th><th>倍数关系</th>
              </tr>
            </thead>
            <tbody id="odds-drilldown-rows"></tbody>
          </table>
        </div>
        <p id="odds-drilldown-note" class="odds-drilldown-note"></p>
      </section>
    </section>

    <section class="toolbar" aria-label="筛选条件">
      <div class="field">
        <label for="search">比赛 / 联赛 / 比分</label>
        <input id="search" type="search" placeholder="例如：英超、曼联、2:1">
      </div>
      <div class="field">
        <label for="league-filter">联赛</label>
        <select id="league-filter"><option value="all">全部联赛</option></select>
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

    <section class="band-summary" aria-label="当前0球赔率区间的实际进球占比">
      <header class="band-summary-head">
        <div>
          <p class="band-summary-label">SELECTED BAND / 全部比赛统计</p>
          <h2 id="band-summary-title">当前赔率区间 · 实际进球占比</h2>
        </div>
        <div class="band-summary-total"><strong id="band-summary-total">—</strong><span>场比赛</span></div>
      </header>
      <div id="band-goal-grid" class="band-goal-grid"></div>
      <p id="band-summary-note" class="band-summary-note">只跟随“0球赔率区间”；统计该区间内符合整数倍条件的全部比赛，不受实际进球、整数倍、搜索和分页筛选影响。</p>
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

    <section class="equality-analysis" aria-label="相同赔率组合的实际进球统计">
      <header class="equality-head">
        <div>
          <p class="equality-label">EQUAL ODDS / 数据库历史统计</p>
          <h2 id="equality-title">相同赔率出现时，实际进了多少球</h2>
        </div>
        <div class="equality-total"><strong id="equality-total">—</strong><span>场相同赔率比赛</span></div>
      </header>
      <div class="equality-controls">
        <div id="equality-tabs" class="equality-tabs" role="tablist" aria-label="相同赔率组合"></div>
        <div class="equality-price-field">
          <label for="equality-price">相同赔率的具体数值</label>
          <select id="equality-price"><option value="all">全部相同赔率</option></select>
        </div>
      </div>
      <div id="equality-grid" class="equality-grid"></div>
      <p id="equality-note" class="equality-note">直接读取 betwin.db 的历史总进球表，共 ${equalityDatabaseRows.toLocaleString("zh-CN")} 条；不读取 Excel。最终赔率按两位小数完全相同判断。</p>
    </section>
    <p class="note">生成时间：${generatedAt}。本页直接读取数据库，只用于历史统计研究，不参与也不会改变主预测。整数倍按数据库两位小数精度严格计算，例如16.00＝4.00×4；近似倍数不计入，倍数规律也尚未通过预测验证。</p>
  </main>

  <script>
    const records = ${serialized};
    const equalityRecords = ${serializedEqualities};
    const equalityPairs = ${serializedEqualityPairs};
    const equalityDatabaseRows = ${equalityDatabaseRows};
    const goalLabels = ["0", "1", "2", "3", "4", "5", "6", "7+"];
    const distributionGoalLabels = new Set(["2", "3", "4", "5", "6", "7+"]);
    const state = {
      page: 1,
      filtered: records,
      equalityPair: equalityPairs[0].id,
      selectedZeroOdds: null,
      selectedDrilldownLeague: "all",
    };
    const byId = (id) => document.getElementById(id);
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
    const oddsText = (value) => Number(value).toFixed(2);

    function populateFilters() {
      const leagueCounts = new Map();
      for (const record of records) {
        const league = String(record.league || "未知联赛");
        leagueCounts.set(league, (leagueCounts.get(league) || 0) + 1);
      }
      const leagueSelect = byId("league-filter");
      leagueSelect.options[0].textContent = "全部联赛（" + records.length.toLocaleString("zh-CN") + "场）";
      for (const [league, count] of [...leagueCounts.entries()].sort((left, right) => left[0].localeCompare(right[0], "zh-CN"))) {
        const option = document.createElement("option");
        option.value = league;
        option.textContent = league + "（" + count.toLocaleString("zh-CN") + "场）";
        leagueSelect.append(option);
      }
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

    function bandLabel(band) {
      if (band === "11-19") return "0球赔率 11～18.99";
      if (band === "19-26") return "0球赔率 19～25.99";
      if (band === "26-33") return "0球赔率 26～32.99";
      if (band === "33+") return "0球赔率 33以上";
      return "全部0球赔率（≥11）";
    }

    function goalShareCards(counts, total) {
      const maximum = Math.max(0, ...Object.values(counts));
      return goalLabels.map((label) => {
        const count = counts[label];
        const percentage = total ? (count / total) * 100 : 0;
        const leader = count > 0 && count === maximum ? " leader" : "";
        return '<article class="band-goal-card' + leader + '">' +
          '<span class="band-goal-name">实际 ' + label + ' 球</span>' +
          '<strong class="band-goal-percent">' + percentage.toFixed(1) + '%</strong>' +
          '<span class="band-goal-count">' + count.toLocaleString("zh-CN") + ' 场 / 共 ' + total.toLocaleString("zh-CN") + ' 场</span>' +
          '<span class="band-goal-track" aria-hidden="true"><span style="width:' + percentage.toFixed(1) + '%"></span></span>' +
          '</article>';
      }).join("");
    }

    function renderBandSummary() {
      const band = byId("band").value;
      const league = byId("league-filter").value;
      const leagueLabel = league === "all" ? "全部联赛" : league;
      const bandRecords = records.filter((record) =>
        inBand(Number(record.odds[0]), band) &&
        (league === "all" || String(record.league || "未知联赛") === league)
      );
      const counts = Object.fromEntries(goalLabels.map((label) => [label, 0]));
      for (const record of bandRecords) {
        if (Object.hasOwn(counts, record.goals)) counts[record.goals] += 1;
      }
      byId("band-summary-title").textContent = leagueLabel + " · " + bandLabel(band) + " · 实际进球占比";
      byId("band-summary-total").textContent = bandRecords.length.toLocaleString("zh-CN");
      byId("band-goal-grid").innerHTML = goalShareCards(counts, bandRecords.length);
      byId("band-summary-note").textContent = leagueLabel + "中，" + bandLabel(band) + "共 " + bandRecords.length.toLocaleString("zh-CN") + " 场；以上分母均为当前联赛与赔率区间内的全部整数倍比赛，不受实际进球、整数倍、搜索和分页筛选影响。";
    }

    function currentEqualityPair() {
      return equalityPairs.find((pair) => pair.id === state.equalityPair) || equalityPairs[0];
    }

    function equalityPairRecords() {
      return equalityRecords.filter((record) => record.pairId === state.equalityPair);
    }

    function renderEqualityTabs() {
      byId("equality-tabs").innerHTML = equalityPairs.map((pair) => {
        const total = equalityRecords.filter((record) => record.pairId === pair.id).length;
        const active = pair.id === state.equalityPair;
        return '<button class="equality-tab' + (active ? ' active' : '') + '" type="button" role="tab" aria-selected="' + active + '" data-pair="' + pair.id + '">' +
          '<strong>' + pair.label + '</strong><small>' + total.toLocaleString("zh-CN") + ' 场</small></button>';
      }).join("");
    }

    function populateEqualityPrices() {
      const select = byId("equality-price");
      const priceCounts = new Map();
      for (const record of equalityPairRecords()) {
        const key = Number(record.equalOdds).toFixed(2);
        priceCounts.set(key, (priceCounts.get(key) || 0) + 1);
      }
      const options = [...priceCounts.entries()].sort((left, right) => Number(left[0]) - Number(right[0]));
      select.innerHTML = '<option value="all">全部相同赔率（' + equalityPairRecords().length.toLocaleString("zh-CN") + '场）</option>' +
        options.map(([price, count]) => '<option value="' + price + '">' + price + '（' + count.toLocaleString("zh-CN") + '场）</option>').join("");
    }

    function renderEqualitySummary() {
      const pair = currentEqualityPair();
      const selectedPrice = byId("equality-price").value;
      const pairRecords = equalityPairRecords();
      const selected = selectedPrice === "all"
        ? pairRecords
        : pairRecords.filter((record) => Number(record.equalOdds).toFixed(2) === selectedPrice);
      const counts = Object.fromEntries(goalLabels.map((label) => [label, 0]));
      for (const record of selected) {
        if (Object.hasOwn(counts, record.goals)) counts[record.goals] += 1;
      }
      const priceLabel = selectedPrice === "all" ? "全部相同赔率" : "相同赔率 " + selectedPrice;
      byId("equality-title").textContent = pair.label + " · " + priceLabel + "下的实际进球占比";
      byId("equality-total").textContent = selected.length.toLocaleString("zh-CN");
      byId("equality-grid").innerHTML = goalShareCards(counts, selected.length);
      byId("equality-note").textContent = "直接读取 betwin.db 的历史总进球表 " + equalityDatabaseRows.toLocaleString("zh-CN") + " 条记录；" + pair.label + "共有 " + pairRecords.length.toLocaleString("zh-CN") + " 场，当前“" + priceLabel + "”为 " + selected.length.toLocaleString("zh-CN") + " 场。最终赔率按两位小数完全相同判断，不读取 Excel。";
    }

    function initializeEqualityAnalysis() {
      renderEqualityTabs();
      populateEqualityPrices();
      byId("equality-tabs").addEventListener("click", (event) => {
        const button = event.target.closest("[data-pair]");
        if (!button) return;
        state.equalityPair = button.dataset.pair;
        renderEqualityTabs();
        populateEqualityPrices();
        renderEqualitySummary();
      });
      byId("equality-price").addEventListener("change", renderEqualitySummary);
    }

    function applyFilters() {
      const query = byId("search").value.trim().toLowerCase();
      const league = byId("league-filter").value;
      const band = byId("band").value;
      const actual = byId("actual").value;
      const multiple = byId("multiple-filter").value;
      state.filtered = records.filter((record) => {
        const haystack = [record.league, record.home, record.away, record.score, record.sourceRow].join(" ").toLowerCase();
        return (!query || haystack.includes(query)) &&
          (league === "all" || String(record.league || "未知联赛") === league) &&
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

    function drilldownRowHtml(record) {
      const relations = record.relations.map((item) => "0球 " + oddsText(record.odds[0]) + " = " + item.label + "球 " + oddsText(record.odds[item.index]) + " × " + item.multiple).join("<br>");
      return "<tr>" +
        "<td>" + escapeHtml(record.league) + "</td>" +
        '<td class="fixture">' + escapeHtml(record.home) + " vs " + escapeHtml(record.away) + "</td>" +
        "<td>" + escapeHtml(record.score) + "</td>" +
        '<td class="actual">' + escapeHtml(record.goals) + "</td>" +
        record.odds.map((_, index) => oddsCell(record, index)).join("") +
        '<td class="relation">' + relations + "</td></tr>";
    }

    function selectedZeroOddsRecords() {
      if (state.selectedZeroOdds === null) return [];
      const selectedCents = Math.round(Number(state.selectedZeroOdds) * 100);
      return records.filter((record) =>
        distributionGoalLabels.has(record.goals) &&
        Math.round(Number(record.odds[0]) * 100) === selectedCents
      );
    }

    function populateDrilldownLeagues(selectedRecords) {
      const leagueCounts = new Map();
      for (const record of selectedRecords) {
        const league = String(record.league || "未知联赛");
        leagueCounts.set(league, (leagueCounts.get(league) || 0) + 1);
      }
      const options = [...leagueCounts.entries()].sort((left, right) =>
        left[0].localeCompare(right[0], "zh-CN")
      );
      byId("odds-drilldown-league").innerHTML =
        '<option value="all">全部联赛（' + selectedRecords.length.toLocaleString("zh-CN") + '场）</option>' +
        options.map(([league, count]) =>
          '<option value="' + escapeHtml(league) + '">' + escapeHtml(league) + '（' + count.toLocaleString("zh-CN") + '场）</option>'
        ).join("");
      byId("odds-drilldown-league").value = state.selectedDrilldownLeague;
    }

    function renderOddsDrilldown({ resetLeague = false, scroll = false } = {}) {
      const panel = byId("odds-drilldown");
      if (state.selectedZeroOdds === null) {
        panel.hidden = true;
        return;
      }
      const selectedRecords = selectedZeroOddsRecords();
      if (resetLeague) {
        state.selectedDrilldownLeague = "all";
        populateDrilldownLeagues(selectedRecords);
      }
      const visibleRecords = state.selectedDrilldownLeague === "all"
        ? selectedRecords
        : selectedRecords.filter((record) => String(record.league || "未知联赛") === state.selectedDrilldownLeague);
      const zeroOdds = Number(state.selectedZeroOdds).toFixed(2);
      byId("odds-drilldown-title").textContent = "0球赔率 " + zeroOdds + " · 历史比赛";
      byId("odds-drilldown-total").textContent = visibleRecords.length.toLocaleString("zh-CN");
      byId("odds-drilldown-total-label").textContent = state.selectedDrilldownLeague === "all"
        ? "场比赛"
        : "场 / 全部 " + selectedRecords.length.toLocaleString("zh-CN") + " 场";
      byId("odds-drilldown-rows").innerHTML = visibleRecords.length
        ? visibleRecords.map(drilldownRowHtml).join("")
        : '<tr><td class="empty" colspan="13">该联赛没有符合当前赔率口径的比赛</td></tr>';
      byId("odds-drilldown-note").textContent = "0球赔率 " + zeroOdds + " 在上方总表共有 " + selectedRecords.length.toLocaleString("zh-CN") + " 场；当前显示 " + visibleRecords.length.toLocaleString("zh-CN") + " 场。这里只按联赛过滤，不改变整数倍和实际2球至7+球的统计口径。";
      panel.hidden = false;
      document.querySelectorAll(".distribution tr[data-zero-odds]").forEach((row) => {
        row.classList.toggle("selected", row.dataset.zeroOdds === zeroOdds);
      });
      if (scroll) panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function render() {
      renderBandSummary();
      renderEqualitySummary();
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

    for (const id of ["search", "league-filter", "band", "actual", "multiple-filter", "page-size"]) {
      byId(id).addEventListener(id === "search" ? "input" : "change", applyFilters);
    }
    byId("previous").addEventListener("click", () => { state.page -= 1; render(); });
    byId("next").addEventListener("click", () => { state.page += 1; render(); });
    document.querySelector(".distribution tbody").addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-zero-odds]");
      if (!row) return;
      state.selectedZeroOdds = Number(row.dataset.zeroOdds);
      renderOddsDrilldown({ resetLeague: true, scroll: true });
    });
    byId("odds-drilldown-league").addEventListener("change", (event) => {
      state.selectedDrilldownLeague = event.target.value;
      renderOddsDrilldown();
    });
    populateFilters();
    initializeEqualityAnalysis();
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
  const equalityHistory = store.getGoalHistory();
  const equalityRecords = buildEqualityRecords(equalityHistory);
  const generatedAt = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "long",
    timeStyle: "medium",
    timeZone: "Asia/Shanghai",
  }).format(new Date());
  writeFileSync(
    OUTPUT_PATH,
    reportHtml(
      records,
      generatedAt,
      goalDistribution,
      equalityRecords,
      equalityHistory.length,
    ),
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
  console.log(`相同赔率统计数据库样本：${equalityHistory.length.toLocaleString()} 场`);
  for (const pair of GOAL_EQUALITY_PAIRS) {
    const samples = equalityRecords.filter((row) => row.pairId === pair.id).length;
    console.log(`${pair.label}：${samples.toLocaleString()} 场`);
  }
} finally {
  store.close();
}
