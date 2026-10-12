import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import {
  GOAL_EQUALITY_PAIRS,
  buildGoalMultipleDistribution,
  buildGoalMultipleRecords,
  exactGoalOddsEqualities,
} from "../public/goal-multiples.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATABASE_PATH = process.env.BETWIN_DATABASE_PATH
  ? path.resolve(process.env.BETWIN_DATABASE_PATH)
  : path.join(ROOT, "betwin.db");
const OUTPUT_PATH = process.env.BETWIN_GOAL_MULTIPLE_REPORT_PATH
  ? path.resolve(process.env.BETWIN_GOAL_MULTIPLE_REPORT_PATH)
  : path.join(ROOT, "倍数赔率历史比赛.html");
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

  const totalMatches = records.length;
  const totalRelations = records.reduce((sum, r) => sum + r.relations.length, 0);
  const uniqueLeagues = new Set(records.map((r) => r.league)).size;
  const peakGroup = goalDistribution.groups.find(
    (g) => g.total === goalDistribution.maximum,
  );
  const peakOdds = peakGroup ? peakGroup.odds.toFixed(2) : "—";
  const peakShare = peakGroup ? (peakGroup.share * 100).toFixed(1) : "0.0";
  const peakCount = peakGroup ? peakGroup.total : 0;

  const distributionRows = goalDistribution.groups
    .map((group) => {
      const percentage = (group.share * 100).toFixed(1);
      const isPeakGroup = group.total === goalDistribution.maximum;
      const countsArray = DISTRIBUTION_GOALS.map((goal) => group.counts[goal] || 0);
      const maxCount = Math.max(...countsArray);

      const outcomeCells = DISTRIBUTION_GOALS.map((goal) => {
        const count = group.counts[goal] || 0;
        if (count === 0) {
          return `<td class="dist-outcome is-zero"><span class="dist-empty">—</span></td>`;
        }
        const outcomePercentage = group.total
          ? ((count / group.total) * 100).toFixed(1)
          : "0.0";
        const isTop = count === maxCount && count >= 2;
        return `<td class="dist-outcome${isTop ? " is-top" : ""}">
          <div class="dist-cell-content">
            <span class="dist-num">${count}<span class="dist-unit">场</span></span>
            <span class="dist-pct">${outcomePercentage}%</span>
          </div>
        </td>`;
      }).join("");

      const barWidth = goalDistribution.maximum
        ? ((group.total / goalDistribution.maximum) * 100).toFixed(1)
        : "0";

      return `<tr class="dist-row${isPeakGroup ? " peak-row" : ""}" data-zero-odds="${group.odds.toFixed(2)}">
        <td class="dist-odds">
          <div class="dist-odds-chip">
            <span class="dist-odds-val">${group.odds.toFixed(2)}</span>
            ${isPeakGroup ? '<span class="tag-peak">峰值</span>' : ""}
            <span class="dist-drill-hint">明细 ▾</span>
          </div>
        </td>
        ${outcomeCells}
        <td class="dist-count">
          <span class="count-num">${group.total}</span><span class="count-unit">场</span>
        </td>
        <td class="dist-share">
          <div class="share-cell">
            <div class="share-track">
              <span class="share-fill" style="width:${barWidth}%"></span>
            </div>
            <strong class="share-pct">${percentage}%</strong>
          </div>
        </td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>0球整数倍赔率 · 历史比赛档案雷达</title>
  <style>
    :root {
      --bg: #0c1017;
      --bg-subtle: #131924;
      --panel: #161f2e;
      --panel-alt: #1c2738;
      --panel-hover: #223046;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --text-subtle: #64748b;
      --border: #253347;
      --border-subtle: #1a2332;
      --accent-rose: #f43f5e;
      --accent-rose-soft: rgba(244, 63, 94, 0.16);
      --accent-rose-border: rgba(244, 63, 94, 0.35);
      --accent-lime: #bef264;
      --accent-lime-soft: rgba(190, 242, 100, 0.16);
      --accent-mint: #2dd4bf;
      --accent-amber: #fbbf24;
      --accent-amber-soft: rgba(251, 191, 36, 0.16);
      --accent-blue: #38bdf8;
      --accent-indigo: #818cf8;
      --accent-glow: 0 0 20px rgba(190, 242, 100, 0.25);
      --top-bg: rgba(56, 189, 248, 0.12);
      --top-border: rgba(56, 189, 248, 0.35);
      --top-text: #38bdf8;
      --top-pct: #7dd3fc;
      --selected-row-bg: rgba(56, 189, 248, 0.08);
      --share-fill-color: linear-gradient(90deg, #38bdf8, #818cf8);
      --card-radius: 12px;
      --btn-radius: 8px;
      --shadow-sm: 0 2px 6px rgba(0, 0, 0, 0.35);
      --shadow-md: 0 8px 24px rgba(0, 0, 0, 0.45);
      --shadow-lg: 0 16px 40px rgba(0, 0, 0, 0.6);
      --font-mono: "SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace;
      --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }

    [data-theme="light"] {
      --bg: #f8fafc;
      --bg-subtle: #f1f5f9;
      --panel: #ffffff;
      --panel-alt: #f8fafc;
      --panel-hover: #f1f5f9;
      --text: #0f172a;
      --text-muted: #64748b;
      --text-subtle: #94a3b8;
      --border: #e2e8f0;
      --border-subtle: #f1f5f9;
      --accent-rose: #e11d48;
      --accent-rose-soft: rgba(225, 29, 72, 0.08);
      --accent-rose-border: rgba(225, 29, 72, 0.25);
      --accent-lime: #65a30d;
      --accent-lime-soft: rgba(101, 163, 13, 0.12);
      --accent-mint: #0d9488;
      --accent-amber: #d97706;
      --accent-amber-soft: rgba(217, 119, 6, 0.1);
      --accent-blue: #0284c7;
      --accent-indigo: #4f46e5;
      --accent-glow: 0 0 20px rgba(101, 163, 13, 0.15);
      --top-bg: #eff6ff;
      --top-border: #bfdbfe;
      --top-text: #1d4ed8;
      --top-pct: #2563eb;
      --selected-row-bg: #f0f7ff;
      --share-fill-color: #2563eb;
      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.06);
      --shadow-md: 0 6px 18px rgba(0, 0, 0, 0.08);
      --shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.12);
    }

    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--text);
      background-color: var(--bg);
      background-image:
        radial-gradient(var(--border) 1px, transparent 1px),
        radial-gradient(var(--border) 1px, transparent 1px);
      background-size: 32px 32px;
      background-position: 0 0, 16px 16px;
      font-family: var(--font-sans);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    button, input, select { font: inherit; color: inherit; }
    a { color: var(--accent-blue); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Top Nav */
    .top-navbar {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
    }
    .top-navbar-inner {
      width: min(1740px, calc(100% - 40px));
      margin: 0 auto;
      height: 60px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }
    .nav-brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .08em;
      color: var(--accent-lime);
      background: var(--accent-lime-soft);
      border: 1px solid var(--accent-lime);
      border-radius: var(--radius-full);
    }
    .brand-badge .pulse-dot {
      width: 6px; height: 6px;
      background: currentColor;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .4; transform: scale(0.85); } }
    .brand-title {
      font-weight: 700;
      font-size: 16px;
      letter-spacing: -.01em;
    }
    .nav-links {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .nav-link {
      padding: 6px 14px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      border-radius: var(--btn-radius);
      transition: color .15s, background-color .15s;
    }
    .nav-link:hover {
      color: var(--text);
      background: var(--panel-hover);
      text-decoration: none;
    }
    .nav-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .action-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 36px;
      padding: 0 14px;
      font-size: 13px;
      font-weight: 600;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: var(--btn-radius);
      cursor: pointer;
      transition: all .2s ease;
    }
    .action-btn:hover {
      background: var(--panel-hover);
      border-color: var(--text-muted);
    }

    /* Container Shell */
    .shell {
      width: min(1740px, calc(100% - 40px));
      margin: 24px auto 80px;
      display: grid;
      gap: 24px;
    }

    /* Masthead Hero */
    .hero-banner {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--card-radius);
      padding: 32px 36px;
      box-shadow: var(--shadow-sm);
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(420px, 1fr);
      gap: 36px;
      position: relative;
      overflow: hidden;
    }
    .hero-banner::before {
      content: "";
      position: absolute;
      top: -120px; right: -80px;
      width: 320px; height: 320px;
      background: radial-gradient(circle, var(--accent-lime-soft) 0%, transparent 70%);
      pointer-events: none;
    }
    .hero-eyebrow {
      margin: 0 0 10px;
      color: var(--accent-mint);
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .18em;
      text-transform: uppercase;
    }
    .hero-title {
      margin: 0;
      font-size: clamp(28px, 3.2vw, 44px);
      font-weight: 800;
      letter-spacing: -.03em;
      line-height: 1.15;
    }
    .hero-desc {
      margin: 14px 0 0;
      color: var(--text-muted);
      font-size: 14.5px;
      line-height: 1.75;
      max-width: 780px;
    }
    .hero-desc b { color: var(--accent-rose); }
    .hero-stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      align-self: center;
    }
    .stat-card {
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 18px;
      transition: transform .2s, border-color .2s;
    }
    .stat-card:hover {
      transform: translateY(-2px);
      border-color: var(--accent-lime);
    }
    .stat-label {
      font-size: 12px;
      color: var(--text-muted);
      font-weight: 500;
    }
    .stat-value {
      margin-top: 6px;
      font-family: var(--font-mono);
      font-size: 28px;
      font-weight: 800;
      line-height: 1.1;
      font-variant-numeric: tabular-nums;
      color: var(--text);
    }
    .stat-value.highlight-lime { color: var(--accent-lime); }
    .stat-value.highlight-rose { color: var(--accent-rose); }
    .stat-value.highlight-amber { color: var(--accent-amber); }
    .stat-hint {
      margin-top: 4px;
      font-size: 11px;
      color: var(--text-subtle);
    }

    /* Section Wrapper */
    .content-section {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--card-radius);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      padding: 20px 24px;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
    }
    .section-header.with-accent {
      border-top: 4px solid var(--accent-lime);
    }
    .section-tag {
      margin: 0 0 6px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .15em;
      text-transform: uppercase;
    }
    .section-title {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -.02em;
    }
    .section-badge-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .section-pill {
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
      padding: 6px 14px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: var(--radius-full);
      font-size: 12.5px;
      color: var(--text-muted);
    }
    .section-pill strong {
      font-family: var(--font-mono);
      font-size: 18px;
      font-weight: 800;
      color: var(--accent-rose);
      font-variant-numeric: tabular-nums;
    }

    /* Distribution Table */
    .table-responsive {
      max-height: 480px;
      overflow: auto;
    }
    .styled-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 13.5px;
      min-width: 1200px;
    }
    .styled-table th {
      position: sticky;
      top: 0;
      z-index: 20;
      background: var(--bg-subtle);
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .05em;
      text-transform: uppercase;
      padding: 12px 14px;
      text-align: left;
      border-bottom: 1px solid var(--border);
      border-right: 1px solid var(--border-subtle);
      white-space: nowrap;
    }
    .styled-table th:last-child { border-right: none; }
    .styled-table td {
      padding: 11px 14px;
      border-bottom: 1px solid var(--border-subtle);
      border-right: 1px solid var(--border-subtle);
      vertical-align: middle;
      transition: background-color .15s;
    }
    .styled-table td:last-child { border-right: none; }
    .styled-table tbody tr:hover td {
      background-color: var(--panel-hover);
    }

    /* Selected row for tables: clean, dignified indicator */
    .styled-table tbody tr.selected td {
      background-color: var(--selected-row-bg) !important;
    }
    .styled-table tbody tr.selected td:first-child {
      border-left: 3px solid var(--accent-blue);
    }

    /* Distribution Legend */
    .dist-legend-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      padding: 10px 16px;
      margin-bottom: 12px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: var(--btn-radius);
      font-size: 12px;
      color: var(--text-muted);
    }
    .legend-items {
      display: flex;
      align-items: center;
      gap: 18px;
      flex-wrap: wrap;
    }
    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .legend-badge-top {
      display: inline-block;
      width: 14px;
      height: 14px;
      border-radius: 3px;
      background: var(--top-bg);
      border: 1px solid var(--top-border);
    }
    .legend-dash {
      font-family: var(--font-mono);
      color: var(--text-subtle);
      font-weight: 700;
    }
    .legend-peak-tag, .tag-peak {
      display: inline-block;
      padding: 1px 6px;
      font-size: 11px;
      font-weight: 700;
      border-radius: 4px;
      background: rgba(245, 158, 11, 0.15);
      color: #f59e0b;
      border: 1px solid rgba(245, 158, 11, 0.35);
    }
    .legend-hint {
      color: var(--text-subtle);
      font-size: 12px;
    }

    /* Distribution Table Container & Table */
    .dist-table-container {
      max-height: 520px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: var(--card-radius);
      background: var(--panel);
      box-shadow: var(--shadow-sm);
    }
    .dist-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 13px;
      min-width: 1050px;
    }
    .dist-table th {
      position: sticky;
      top: 0;
      z-index: 20;
      background: var(--panel-alt);
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .02em;
      padding: 11px 12px;
      text-align: center;
      border-bottom: 2px solid var(--border);
      border-right: 1px solid var(--border-subtle);
      white-space: nowrap;
    }
    .dist-table th.th-odds {
      width: 170px;
      text-align: left;
      padding-left: 16px;
    }
    .dist-table th.th-goal {
      width: 105px;
      text-align: center;
    }
    .dist-table th.th-total {
      width: 110px;
      text-align: right;
      padding-right: 14px;
    }
    .dist-table th.th-share {
      width: 190px;
      text-align: left;
      padding-left: 16px;
    }
    .dist-table th:last-child {
      border-right: none;
    }

    .dist-table td {
      padding: 9px 12px;
      border-bottom: 1px solid var(--border-subtle);
      border-right: 1px solid var(--border-subtle);
      vertical-align: middle;
      transition: background-color .15s ease;
    }
    .dist-table td:last-child {
      border-right: none;
    }

    /* Distribution Rows */
    .dist-table tbody tr.dist-row {
      cursor: pointer;
    }
    .dist-table tbody tr.dist-row:hover td {
      background-color: var(--panel-hover);
    }

    /* Selected Row on Distribution */
    .dist-table tbody tr.dist-row.selected td {
      background-color: var(--selected-row-bg) !important;
    }
    .dist-table tbody tr.dist-row.selected td.dist-odds {
      border-left: 3px solid var(--accent-blue);
    }
    .dist-table tbody tr.dist-row.selected .dist-drill-hint {
      background: var(--accent-blue);
      color: #ffffff;
      border-color: var(--accent-blue);
    }

    /* Odds column */
    .dist-table td.dist-odds {
      padding-left: 14px;
    }
    .dist-odds-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
    }
    .dist-odds-val {
      font-family: var(--font-mono);
      font-size: 15px;
      font-weight: 800;
      color: var(--text);
      letter-spacing: -0.01em;
    }
    .dist-drill-hint {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 4px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      color: var(--text-muted);
      transition: all .15s ease;
      font-weight: 500;
    }
    .dist-row:hover .dist-drill-hint {
      border-color: var(--accent-blue);
      color: var(--accent-blue);
    }

    /* Cell content & numbers */
    .dist-outcome {
      text-align: center;
      font-family: var(--font-mono);
    }
    .dist-outcome.is-zero {
      background: transparent;
    }
    .dist-empty {
      color: var(--text-subtle);
      font-size: 14px;
      opacity: 0.45;
    }
    .dist-cell-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1px;
    }
    .dist-num {
      font-size: 13.5px;
      font-weight: 700;
      color: var(--text);
      line-height: 1.2;
    }
    .dist-unit {
      font-size: 11px;
      font-weight: 400;
      color: var(--text-muted);
      margin-left: 1px;
    }
    .dist-pct {
      font-size: 11px;
      color: var(--text-muted);
      line-height: 1.2;
    }

    /* Peak / Highest Goal in Row - Crisp, elegant blue accent */
    .dist-outcome.is-top {
      background-color: var(--top-bg) !important;
    }
    .dist-outcome.is-top .dist-num {
      color: var(--top-text);
      font-weight: 800;
    }
    .dist-outcome.is-top .dist-unit {
      color: var(--top-text);
      opacity: 0.8;
    }
    .dist-outcome.is-top .dist-pct {
      color: var(--top-pct);
      font-weight: 600;
    }

    /* Total column */
    .dist-count {
      text-align: right;
      font-family: var(--font-mono);
      white-space: nowrap;
      padding-right: 14px;
    }
    .count-num {
      font-size: 14.5px;
      font-weight: 800;
      color: var(--text);
    }
    .count-unit {
      font-size: 11px;
      color: var(--text-muted);
      margin-left: 2px;
    }

    /* Share column */
    .dist-share {
      padding-left: 16px;
      padding-right: 16px;
    }
    .share-cell {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
    }
    .share-track {
      flex: 1;
      height: 7px;
      background: var(--bg-subtle);
      border-radius: var(--radius-full);
      overflow: hidden;
      border: 1px solid var(--border-subtle);
    }
    .share-fill {
      display: block;
      height: 100%;
      background: var(--share-fill-color);
      border-radius: var(--radius-full);
      transition: width .3s ease;
    }
    .share-pct {
      font-family: var(--font-mono);
      font-size: 12.5px;
      font-weight: 700;
      color: var(--text);
      min-width: 44px;
      text-align: right;
    }
    .section-footer-note {
      padding: 12px 24px;
      font-size: 12.5px;
      color: var(--text-muted);
      border-top: 1px solid var(--border);
      background: var(--bg-subtle);
      margin: 0;
    }

    /* Odds Drilldown Section */
    .odds-drilldown {
      border-top: 2px solid var(--accent-blue);
      background: var(--panel-alt);
      scroll-margin-top: 70px;
      animation: fadeIn .25s ease-out;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
    .odds-drilldown-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .drilldown-title-wrap h3 {
      margin: 4px 0 0;
      font-size: 18px;
      font-weight: 700;
    }
    .drilldown-controls {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .drilldown-select-field {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--text-muted);
    }
    .drilldown-select-field select {
      height: 34px;
      padding: 0 10px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--btn-radius);
      font-size: 13px;
    }
    .drilldown-close-btn {
      height: 34px;
      padding: 0 12px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--btn-radius);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all .15s;
    }
    .drilldown-close-btn:hover {
      color: var(--accent-rose);
      border-color: var(--accent-rose);
    }

    /* Filter Toolbar */
    .filter-workbench {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--card-radius);
      padding: 20px 24px;
      display: grid;
      gap: 18px;
      box-shadow: var(--shadow-sm);
    }
    .toolbar-grid {
      display: grid;
      grid-template-columns: minmax(280px, 1.5fr) repeat(5, minmax(130px, 1fr));
      gap: 14px;
    }
    .field-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .field-label {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .input-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }
    .field-input, .field-select {
      width: 100%;
      height: 42px;
      padding: 0 12px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: var(--btn-radius);
      font-size: 13.5px;
      color: var(--text);
      outline: none;
      transition: border-color .15s, box-shadow .15s;
    }
    .field-input:focus, .field-select:focus {
      border-color: var(--accent-lime);
      box-shadow: 0 0 0 3px var(--accent-lime-soft);
    }
    .clear-search-btn {
      position: absolute;
      right: 10px;
      width: 22px; height: 22px;
      border: none;
      background: var(--border);
      color: var(--text-muted);
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      cursor: pointer;
      opacity: 0;
      transition: opacity .15s;
    }
    .field-input:not(:placeholder-shown) + .clear-search-btn {
      opacity: 1;
    }

    /* Quick Preset Chips */
    .quick-chips-bar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      padding-top: 14px;
      border-top: 1px dashed var(--border);
    }
    .chips-label {
      font-size: 12px;
      color: var(--text-muted);
      margin-right: 4px;
      font-weight: 600;
    }
    .preset-chip {
      height: 28px;
      padding: 0 12px;
      font-size: 12px;
      font-weight: 500;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: var(--radius-full);
      cursor: pointer;
      transition: all .15s ease;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .preset-chip:hover {
      border-color: var(--text-muted);
      background: var(--panel-hover);
    }
    .preset-chip.active {
      background: var(--accent-lime-soft);
      border-color: var(--accent-lime);
      color: var(--accent-lime);
      font-weight: 700;
    }
    .chips-divider {
      width: 1px;
      height: 16px;
      background: var(--border);
      margin: 0 4px;
    }

    /* Band Summary Cards */
    .band-summary-container {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--card-radius);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
    }
    .band-cards-grid {
      display: grid;
      grid-template-columns: repeat(8, minmax(0, 1fr));
      gap: 1px;
      background: var(--border);
    }
    .band-card {
      background: var(--panel);
      padding: 16px 18px 18px;
      position: relative;
      cursor: pointer;
      transition: background-color .15s, transform .15s;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-height: 130px;
    }
    .band-card:hover {
      background: var(--panel-hover);
      z-index: 2;
    }
    .band-card.leader {
      background: var(--panel-alt);
    }
    .band-card.leader::before {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 4px;
      background: var(--accent-lime);
    }
    .band-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .band-card-title {
      font-family: var(--font-mono);
      font-size: 11.5px;
      font-weight: 700;
      color: var(--text-muted);
      letter-spacing: .06em;
    }
    .band-card-crown {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      color: var(--accent-amber);
      background: var(--accent-amber-soft);
      letter-spacing: .05em;
    }
    .band-card-percent {
      font-family: var(--font-mono);
      font-size: 26px;
      font-weight: 800;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      color: var(--text);
    }
    .band-card.leader .band-card-percent {
      color: var(--accent-lime);
    }
    .band-card-count {
      font-family: var(--font-mono);
      font-size: 11.5px;
      color: var(--text-muted);
      margin: 8px 0 10px;
    }
    .band-card-track {
      height: 5px;
      background: var(--bg-subtle);
      border-radius: var(--radius-full);
      overflow: hidden;
    }
    .band-card-track span {
      display: block;
      height: 100%;
      background: var(--accent-rose);
      border-radius: var(--radius-full);
      transition: width .3s ease;
    }
    .band-card.leader .band-card-track span {
      background: var(--accent-lime);
    }

    /* Matches Table Styling */
    .badge-league {
      display: inline-block;
      padding: 3px 8px;
      background: var(--bg-subtle);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      white-space: nowrap;
    }
    .fixture-teams {
      min-width: 220px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .fixture-score-tag {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 2px 8px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-family: var(--font-mono);
      font-weight: 700;
      font-size: 12.5px;
      color: var(--text);
    }
    .actual-goals-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 32px;
      height: 26px;
      padding: 0 8px;
      background: var(--accent-rose-soft);
      border: 1px solid var(--accent-rose-border);
      color: var(--accent-rose);
      font-family: var(--font-mono);
      font-weight: 800;
      font-size: 14px;
      border-radius: var(--radius-full);
    }
    .odds-number-cell {
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      text-align: right;
      white-space: nowrap;
    }
    .odds-multiple-cell {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 4px;
    }
    .odds-chip {
      padding: 3px 6px;
      border-radius: 4px;
      font-weight: 600;
    }
    .odds-chip.base-zero {
      background: var(--bg-subtle);
      font-weight: 700;
    }
    .odds-chip.is-multiple {
      background: var(--accent-rose-soft);
      color: var(--accent-rose);
      font-weight: 800;
    }
    .mult-tag {
      font-size: 10.5px;
      font-weight: 800;
      padding: 1px 5px;
      background: var(--accent-rose);
      color: #ffffff;
      border-radius: 3px;
    }
    .relation-pill-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 240px;
    }
    .relation-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      background: var(--accent-rose-soft);
      border: 1px solid var(--accent-rose-border);
      border-radius: 4px;
      color: var(--accent-rose);
      font-family: var(--font-mono);
      font-size: 11.5px;
      font-weight: 600;
    }

    /* Pager */
    .pager-container {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 24px;
      background: var(--panel);
      border-top: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .pager-status {
      font-size: 13px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }
    .pager-button-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .pager-btn {
      height: 34px;
      padding: 0 12px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: var(--btn-radius);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all .15s;
    }
    .pager-btn:hover:not(:disabled) {
      background: var(--panel-hover);
      border-color: var(--accent-lime);
    }
    .pager-btn:disabled {
      opacity: .4;
      cursor: not-allowed;
    }
    .pager-jump {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: var(--text-muted);
      margin-left: 8px;
    }
    .pager-jump input {
      width: 52px;
      height: 32px;
      text-align: center;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: var(--btn-radius);
      font-family: var(--font-mono);
    }

    /* Equality Tabs & Section */
    .equality-toolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(240px, 320px);
      gap: 20px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--border);
    }
    .equality-tabs-scroll {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding-bottom: 4px;
    }
    .equality-tab-btn {
      min-height: 48px;
      padding: 6px 14px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: var(--btn-radius);
      cursor: pointer;
      text-align: left;
      transition: all .15s;
      white-space: nowrap;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .equality-tab-btn:hover {
      border-color: var(--text-muted);
      background: var(--panel-hover);
    }
    .equality-tab-btn.active {
      background: var(--accent-lime-soft);
      border-color: var(--accent-lime);
      box-shadow: 0 0 0 1px var(--accent-lime);
    }
    .equality-tab-btn strong {
      font-size: 14px;
      color: var(--text);
    }
    .equality-tab-btn small {
      margin-top: 3px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
    }
    .equality-tab-btn.active strong { color: var(--accent-lime); }

    /* Footer */
    .archive-footer {
      text-align: center;
      padding: 32px 0 20px;
      color: var(--text-subtle);
      font-size: 12.5px;
      line-height: 1.8;
    }

    /* Back to top floating button */
    .back-to-top {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 44px; height: 44px;
      border-radius: 50%;
      background: var(--panel);
      border: 1px solid var(--border);
      box-shadow: var(--shadow-md);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 16px;
      opacity: 0;
      pointer-events: none;
      transition: all .2s ease;
      z-index: 90;
    }
    .back-to-top.visible {
      opacity: 1;
      pointer-events: auto;
    }
    .back-to-top:hover {
      background: var(--panel-hover);
      border-color: var(--accent-lime);
      transform: translateY(-2px);
    }

    @media (max-width: 1200px) {
      .hero-banner { grid-template-columns: 1fr; }
      .toolbar-grid { grid-template-columns: 1fr 1fr; }
      .band-cards-grid { grid-template-columns: repeat(4, 1fr); }
      .equality-toolbar { grid-template-columns: 1fr; }
    }
    @media (max-width: 768px) {
      .top-navbar-inner { width: calc(100% - 24px); }
      .shell { width: calc(100% - 24px); margin-top: 16px; }
      .nav-links { display: none; }
      .toolbar-grid { grid-template-columns: 1fr; }
      .band-cards-grid { grid-template-columns: repeat(2, 1fr); }
      .hero-stats-grid { grid-template-columns: 1fr 1fr; }
      .section-header { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <!-- Top Navigation Bar -->
  <header class="top-navbar">
    <div class="top-navbar-inner">
      <div class="nav-brand">
        <span class="brand-badge"><span class="pulse-dot"></span>BETWIN RADAR</span>
        <span class="brand-title">0球整数倍赔率档案</span>
      </div>
      <nav class="nav-links" aria-label="快捷跳转">
        <a class="nav-link" href="#section-distribution">0球总表</a>
        <a class="nav-link" href="#section-band">区间统计</a>
        <a class="nav-link" href="#section-matches">比赛明细</a>
        <a class="nav-link" href="#section-equality">同赔分析</a>
      </nav>
      <div class="nav-actions">
        <button id="theme-toggle" class="action-btn" type="button" aria-label="切换深色/浅色模式">
          <span id="theme-icon">☀️</span> <span id="theme-text">浅色</span>
        </button>
        <button id="reset-all" class="action-btn" type="button" aria-label="重置全部筛选">
          ⟳ 重置筛选
        </button>
      </div>
    </div>
  </header>

  <main class="shell">
    <!-- Hero Banner with 4 Stats -->
    <section class="hero-banner">
      <div>
        <p class="hero-eyebrow">GOAL ODDS / INTEGER MULTIPLE ARCHIVE</p>
        <h1 class="hero-title">0球整数倍赔率雷达档案</h1>
        <p class="hero-desc">
          本页面收录历史数据中 <b>0球赔率 ≥ 11.00</b> 且其终盘赔率恰好为 1球至7+球 中至少一项赔率<b>严格整数倍</b>的比赛。
          表格内以粉红/绯红徽章标出构成倍数关系的对应盘口，支持按赔率区间、赛果、倍数与联赛精准下钻。
        </p>
      </div>
      <div class="hero-stats-grid">
        <article class="stat-card">
          <div class="stat-label">符合条件历史比赛</div>
          <div class="stat-value highlight-lime" id="total-count">${totalMatches.toLocaleString("zh-CN")}</div>
          <div class="stat-hint">0球赔率 ≥ 11 且有倍数</div>
        </article>
        <article class="stat-card">
          <div class="stat-label">检出倍数关系总数</div>
          <div class="stat-value highlight-rose" id="relation-count">${totalRelations.toLocaleString("zh-CN")}</div>
          <div class="stat-hint">含同场命中多项倍数</div>
        </article>
        <article class="stat-card">
          <div class="stat-label">覆盖全球赛事联赛</div>
          <div class="stat-value highlight-amber">${uniqueLeagues}</div>
          <div class="stat-hint">主要联赛及次级联赛样本</div>
        </article>
        <article class="stat-card">
          <div class="stat-label">0球峰值赔率集中档</div>
          <div class="stat-value highlight-lime">${peakOdds}</div>
          <div class="stat-hint">${peakCount} 场 · 占全部 ${peakShare}%</div>
        </article>
      </div>
    </section>

    <!-- 0-Goal Distribution Table Section -->
    <section id="section-distribution" class="content-section" aria-label="0球赔率与各进球数分布">
      <header class="section-header with-accent">
        <div>
          <p class="section-tag">OVERVIEW MATRIX / 0球赔率矩阵</p>
          <h2 class="section-title">一个0球赔率，对应各进球数有多少场</h2>
        </div>
        <div class="section-badge-group">
          <div class="section-pill">
            <span>实际2球至7+球比赛合计</span>
            <strong>${goalDistribution.total.toLocaleString("zh-CN")}</strong>
            <span>场</span>
          </div>
        </div>
      </header>

      <!-- Distribution Legend Bar -->
      <div class="dist-legend-bar">
        <div class="legend-items">
          <span class="legend-item"><span class="legend-badge-top"></span>最高频打出进球 (该赔率首选)</span>
          <span class="legend-item"><span class="legend-dash">—</span>无历史场次</span>
          <span class="legend-item"><span class="legend-peak-tag">峰值</span>样本量最多赔率档位</span>
        </div>
        <div class="legend-hint">💡 点击任意一行展开或收起该赔率下的逐场历史比赛明细</div>
      </div>

      <div class="dist-table-container">
        <table class="dist-table">
          <thead>
            <tr>
              <th class="th-odds">0球赔率</th>
              <th class="th-goal">实际 2 球</th>
              <th class="th-goal">实际 3 球</th>
              <th class="th-goal">实际 4 球</th>
              <th class="th-goal">实际 5 球</th>
              <th class="th-goal">实际 6 球</th>
              <th class="th-goal">实际 7+ 球</th>
              <th class="th-total">样本合计</th>
              <th class="th-share">占总样本比例</th>
            </tr>
          </thead>
          <tbody>
            ${distributionRows}
          </tbody>
        </table>
      </div>

      <!-- Odds Drilldown (Hidden by default, opens on row click) -->
      <section id="odds-drilldown" class="odds-drilldown" hidden aria-label="选中0球赔率的历史比赛">
        <header class="odds-drilldown-head">
          <div class="drilldown-title-wrap">
            <p class="hero-eyebrow" style="margin:0;">SELECTED ODDS DRILLDOWN / 逐场明细</p>
            <h3 id="odds-drilldown-title">选中一个0球赔率查看比赛</h3>
          </div>
          <div class="drilldown-controls">
            <div class="drilldown-select-field">
              <label for="odds-drilldown-league">联赛筛选:</label>
              <select id="odds-drilldown-league"><option value="all">全部联赛</option></select>
            </div>
            <div class="section-pill">
              <strong id="odds-drilldown-total">—</strong>
              <span id="odds-drilldown-total-label">场比赛</span>
            </div>
            <button id="odds-drilldown-close" class="drilldown-close-btn" type="button" aria-label="关闭逐场明细">
              ✕ 收起明细
            </button>
          </div>
        </header>
        <div class="table-responsive" style="max-height: 440px;">
          <table class="styled-table">
            <thead>
              <tr>
                <th>联赛</th><th>对阵比赛</th><th>比分</th><th>实际进球</th>
                <th>0球</th><th>1球</th><th>2球</th><th>3球</th><th>4球</th><th>5球</th><th>6球</th><th>7+球</th><th>倍数关系</th>
              </tr>
            </thead>
            <tbody id="odds-drilldown-rows"></tbody>
          </table>
        </div>
        <p id="odds-drilldown-note" class="section-footer-note"></p>
      </section>
    </section>

    <!-- Filter Workbench -->
    <section class="filter-workbench" aria-label="综合筛选条件">
      <div class="toolbar-grid">
        <div class="field-group">
          <label class="field-label" for="search">搜索 (比赛 / 联赛 / 比分)</label>
          <div class="input-wrapper">
            <input id="search" class="field-input" type="search" placeholder="输入球队名、联赛、比分例如 2:1...">
            <button id="search-clear-btn" class="clear-search-btn" type="button" title="清空搜索">✕</button>
          </div>
        </div>
        <div class="field-group">
          <label class="field-label" for="league-filter">赛事联赛</label>
          <select id="league-filter" class="field-select"><option value="all">全部联赛</option></select>
        </div>
        <div class="field-group">
          <label class="field-label" for="band">0球赔率区间</label>
          <select id="band" class="field-select">
            <option value="all">全部区间 (≥11)</option>
            <option value="11-19">11.00～18.99 (高发)</option>
            <option value="19-26">19.00～25.99</option>
            <option value="26-33">26.00～32.99</option>
            <option value="33+">33.00 以上</option>
          </select>
        </div>
        <div class="field-group">
          <label class="field-label" for="actual">实际进球数</label>
          <select id="actual" class="field-select"><option value="all">全部进球</option></select>
        </div>
        <div class="field-group">
          <label class="field-label" for="multiple-filter">整数倍数</label>
          <select id="multiple-filter" class="field-select"><option value="all">全部倍数</option></select>
        </div>
        <div class="field-group">
          <label class="field-label" for="page-size">单页容量</label>
          <select id="page-size" class="field-select">
            <option value="50">50 场 / 页</option>
            <option value="100" selected>100 场 / 页</option>
            <option value="250">250 场 / 页</option>
            <option value="all">显示全部</option>
          </select>
        </div>
      </div>

      <!-- Quick Filter Chips -->
      <div class="quick-chips-bar" aria-label="快捷筛选标签">
        <span class="chips-label">快捷区间:</span>
        <button class="preset-chip active" type="button" data-chip-band="all">全部区间</button>
        <button class="preset-chip" type="button" data-chip-band="11-19">11～18.99 (高发)</button>
        <button class="preset-chip" type="button" data-chip-band="19-26">19～25.99</button>
        <button class="preset-chip" type="button" data-chip-band="26-33">26～32.99</button>
        <button class="preset-chip" type="button" data-chip-band="33+">33以上</button>

        <span class="chips-divider"></span>

        <span class="chips-label">进球直达:</span>
        <button class="preset-chip" type="button" data-chip-goals="2">2球</button>
        <button class="preset-chip" type="button" data-chip-goals="3">3球</button>
        <button class="preset-chip" type="button" data-chip-goals="4">4球</button>
        <button class="preset-chip" type="button" data-chip-goals="5">5球</button>
        <button class="preset-chip" type="button" data-chip-goals="6">6球</button>
        <button class="preset-chip" type="button" data-chip-goals="7+">7+球</button>
      </div>
    </section>

    <!-- Band Summary Grid -->
    <section id="section-band" class="band-summary-container" aria-label="当前0球赔率区间的实际进球占比">
      <header class="section-header">
        <div>
          <p class="section-tag">BAND BREAKDOWN / 实际进球分布</p>
          <h2 class="section-title" id="band-summary-title">当前赔率区间 · 实际进球占比</h2>
        </div>
        <div class="section-pill">
          <span>区间样本量</span>
          <strong id="band-summary-total">—</strong>
          <span>场</span>
        </div>
      </header>
      <div id="band-goal-grid" class="band-cards-grid"></div>
      <p id="band-summary-note" class="section-footer-note"></p>
    </section>

    <!-- Main Matches Table Panel -->
    <section id="section-matches" class="content-section" aria-label="历史比赛明细表">
      <header class="section-header">
        <div>
          <p class="section-tag">DETAILED RECORDS / 比赛明细</p>
          <h2 class="section-title" id="result-title">符合条件的历史比赛</h2>
        </div>
        <div class="section-badge-group">
          <span class="badge-league">全部数据库进球历史 · 按入库批次及记录ID倒序</span>
        </div>
      </header>

      <div class="table-responsive" style="max-height: 68vh;">
        <table class="styled-table">
          <thead>
            <tr>
              <th style="width: 70px;">记录ID</th>
              <th style="width: 120px;">联赛</th>
              <th style="min-width: 260px;">对阵与比分</th>
              <th style="width: 90px; text-align: center;">进球</th>
              <th style="width: 75px; text-align: right;">0球</th>
              <th style="width: 75px; text-align: right;">1球</th>
              <th style="width: 75px; text-align: right;">2球</th>
              <th style="width: 75px; text-align: right;">3球</th>
              <th style="width: 75px; text-align: right;">4球</th>
              <th style="width: 75px; text-align: right;">5球</th>
              <th style="width: 75px; text-align: right;">6球</th>
              <th style="width: 75px; text-align: right;">7+球</th>
              <th style="min-width: 250px;">检出整数倍关系</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>

      <!-- Enhanced Pagination -->
      <div class="pager-container">
        <span class="pager-status" id="page-state">—</span>
        <div class="pager-button-group">
          <button id="first-page" class="pager-btn" type="button">« 首页</button>
          <button id="previous" class="pager-btn" type="button">‹ 上一页</button>
          <button id="next" class="pager-btn" type="button">下一页 ›</button>
          <button id="last-page" class="pager-btn" type="button">尾页 »</button>
          <div class="pager-jump">
            <span>跳至</span>
            <input id="jump-page" type="number" min="1" step="1" aria-label="跳转页码">
            <span>页</span>
          </div>
        </div>
      </div>
    </section>

    <!-- Equal Odds Analysis Section -->
    <section id="section-equality" class="content-section" aria-label="相同赔率组合的实际进球统计">
      <header class="section-header with-accent">
        <div>
          <p class="section-tag">IDENTICAL ODDS ANALYSIS / 数据库同赔全景</p>
          <h2 class="section-title" id="equality-title">相同赔率出现时，实际进了多少球</h2>
        </div>
        <div class="section-pill">
          <span>同赔匹配样本</span>
          <strong id="equality-total">—</strong>
          <span>场</span>
        </div>
      </header>

      <div class="equality-toolbar">
        <div class="equality-tabs-scroll" id="equality-tabs" role="tablist" aria-label="相同赔率组合选项卡"></div>
        <div class="field-group" style="align-self: center;">
          <label class="field-label" for="equality-price">相同赔率的具体数值</label>
          <select id="equality-price" class="field-select"><option value="all">全部相同赔率</option></select>
        </div>
      </div>

      <div id="equality-grid" class="band-cards-grid"></div>
      <p id="equality-note" class="section-footer-note"></p>
    </section>

    <footer class="archive-footer">
      <p>
        数据生成时间：${generatedAt} · 数据库实时比对历史总进球 ${equalityDatabaseRows.toLocaleString("zh-CN")} 场记录。<br>
        本档案工具专门用于研究进球赔率整数倍与相同赔率下的历史赛果离散特征，不构成任何投注诱导。
      </p>
    </footer>
  </main>

  <!-- Back to Top Floating Button -->
  <button id="back-to-top" class="back-to-top" type="button" title="返回顶部" aria-label="返回顶部">↑</button>

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
      equalityPair: "g2-g3", // default to highest sample pair
      selectedZeroOdds: null,
      selectedDrilldownLeague: "all",
    };

    const byId = (id) => document.getElementById(id);
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
    const oddsText = (value) => Number(value).toFixed(2);

    // Theme Switcher with localStorage
    function initTheme() {
      const savedTheme = localStorage.getItem("betwin_goal_multiple_theme") || "dark";
      setTheme(savedTheme);
      byId("theme-toggle")?.addEventListener("click", () => {
        const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
        const nextTheme = currentTheme === "dark" ? "light" : "dark";
        setTheme(nextTheme);
      });
    }

    function setTheme(theme) {
      document.documentElement.setAttribute("data-theme", theme);
      localStorage.setItem("betwin_goal_multiple_theme", theme);
      const isDark = theme === "dark";
      byId("theme-icon").textContent = isDark ? "☀️" : "🌙";
      byId("theme-text").textContent = isDark ? "浅色" : "深色";
    }

    // Populate filter dropdowns
    function populateFilters() {
      const leagueCounts = new Map();
      for (const record of records) {
        const league = String(record.league || "未知联赛");
        leagueCounts.set(league, (leagueCounts.get(league) || 0) + 1);
      }
      const leagueSelect = byId("league-filter");
      leagueSelect.options[0].textContent = "全部联赛 (" + records.length.toLocaleString("zh-CN") + "场)";
      for (const [league, count] of [...leagueCounts.entries()].sort((left, right) => right[1] - left[1])) {
        const option = document.createElement("option");
        option.value = league;
        option.textContent = league + " (" + count.toLocaleString("zh-CN") + "场)";
        leagueSelect.append(option);
      }
      for (const label of goalLabels) {
        const option = document.createElement("option");
        option.value = label;
        option.textContent = label + " 球";
        byId("actual").append(option);
      }
      const multiples = [...new Set(records.flatMap((record) => record.relations.map((item) => item.multiple)))].sort((a, b) => a - b);
      for (const multiple of multiples) {
        const option = document.createElement("option");
        option.value = String(multiple);
        option.textContent = multiple + " 倍";
        byId("multiple-filter").append(option);
      }
    }

    function inBand(value, band) {
      if (band === "11-19") return value >= 11 && value < 19;
      if (band === "19-26") return value >= 19 && value < 26;
      if (band === "26-33") return value >= 26 && value < 33;
      if (band === "33+") return value >= 33;
      return true;
    }

    function bandLabel(band) {
      if (band === "11-19") return "0球赔率 11.00～18.99 (高发)";
      if (band === "19-26") return "0球赔率 19.00～25.99";
      if (band === "26-33") return "0球赔率 26.00～32.99";
      if (band === "33+") return "0球赔率 33.00 以上";
      return "全部0球赔率 (≥11.00)";
    }

    function goalShareCards(counts, total) {
      const maximum = Math.max(0, ...Object.values(counts));
      return goalLabels.map((label) => {
        const count = counts[label] || 0;
        const percentage = total ? (count / total) * 100 : 0;
        const leader = count > 0 && count === maximum ? " leader" : "";
        return '<article class="band-card' + leader + '" data-filter-goal="' + label + '" title="点击筛选实际 ' + label + ' 球的历史比赛">' +
          '<div class="band-card-header">' +
            '<span class="band-card-title">实际 ' + label + ' 球</span>' +
            (leader ? '<span class="band-card-crown">TOP 占比最高</span>' : '') +
          '</div>' +
          '<div class="band-card-percent">' + percentage.toFixed(1) + '%</div>' +
          '<div class="band-card-count">' + count.toLocaleString("zh-CN") + ' 场 / ' + total.toLocaleString("zh-CN") + ' 场</div>' +
          '<div class="band-card-track" aria-hidden="true"><span style="width:' + percentage.toFixed(1) + '%"></span></div>' +
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
      byId("band-summary-title").textContent = leagueLabel + " · " + bandLabel(band) + " · 实际进球分布";
      byId("band-summary-total").textContent = bandRecords.length.toLocaleString("zh-CN");
      byId("band-goal-grid").innerHTML = goalShareCards(counts, bandRecords.length);
      byId("band-summary-note").textContent = leagueLabel + "中，" + bandLabel(band) + "共 " + bandRecords.length.toLocaleString("zh-CN") + " 场；以上卡片为当前联赛与赔率区间内的全部整数倍比赛统计，点击任意进球卡片可快速筛选比赛。";
    }

    function currentEqualityPair() {
      return equalityPairs.find((pair) => pair.id === state.equalityPair) || equalityPairs[0];
    }

    function equalityPairRecords() {
      return equalityRecords.filter((record) => record.pairId === state.equalityPair);
    }

    function renderEqualityTabs() {
      // Sort equality pairs by count descending so tabs with matches are first
      const pairCounts = new Map();
      for (const record of equalityRecords) {
        pairCounts.set(record.pairId, (pairCounts.get(record.pairId) || 0) + 1);
      }
      const sortedPairs = [...equalityPairs].sort((a, b) => {
        return (pairCounts.get(b.id) || 0) - (pairCounts.get(a.id) || 0);
      });

      // Default to highest count pair if current has 0
      if ((pairCounts.get(state.equalityPair) || 0) === 0 && sortedPairs.length && (pairCounts.get(sortedPairs[0].id) || 0) > 0) {
        state.equalityPair = sortedPairs[0].id;
      }

      byId("equality-tabs").innerHTML = sortedPairs.map((pair) => {
        const total = pairCounts.get(pair.id) || 0;
        const active = pair.id === state.equalityPair;
        return '<button class="equality-tab-btn' + (active ? ' active' : '') + '" type="button" role="tab" aria-selected="' + active + '" data-pair="' + pair.id + '">' +
          '<strong>' + pair.label + '</strong>' +
          '<small>' + total.toLocaleString("zh-CN") + ' 场样本</small>' +
        '</button>';
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
      select.innerHTML = '<option value="all">全部相同赔率 (' + equalityPairRecords().length.toLocaleString("zh-CN") + '场)</option>' +
        options.map(([price, count]) => '<option value="' + price + '">' + price + ' (' + count.toLocaleString("zh-CN") + '场)</option>').join("");
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
      byId("equality-title").textContent = pair.label + " · " + priceLabel + " 下的实际进球占比";
      byId("equality-total").textContent = selected.length.toLocaleString("zh-CN");
      byId("equality-grid").innerHTML = goalShareCards(counts, selected.length);
      byId("equality-note").textContent = "直接读取历史总进球表 " + equalityDatabaseRows.toLocaleString("zh-CN") + " 条记录；" + pair.label + " 共有 " + pairRecords.length.toLocaleString("zh-CN") + " 场样本，当前选定“" + priceLabel + "”为 " + selected.length.toLocaleString("zh-CN") + " 场。赔率值完全相同，不依赖预测模型。";
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
      updateQuickChips();
      render();
    }

    function updateQuickChips() {
      const currentBand = byId("band").value;
      document.querySelectorAll("[data-chip-band]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.chipBand === currentBand);
      });
      const currentGoals = byId("actual").value;
      document.querySelectorAll("[data-chip-goals]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.chipGoals === currentGoals);
      });
    }

    function oddsCell(record, index) {
      const relation = record.relations.find((item) => item.index === index);
      const isZero = index === 0;
      const isMultiple = Boolean(relation);

      let content = '<span class="odds-chip ' + (isZero ? 'base-zero' : '') + (isMultiple ? ' is-multiple' : '') + '">' + oddsText(record.odds[index]) + '</span>';
      if (relation) {
        content += ' <span class="mult-tag">×' + relation.multiple + '</span>';
      }
      return '<td class="odds-number-cell"><div class="odds-multiple-cell">' + content + '</div></td>';
    }

    function rowHtml(record) {
      const relationsHtml = record.relations.map((item) =>
        '<span class="relation-badge">0球 ' + oddsText(record.odds[0]) + ' = ' + item.label + '球 ' + oddsText(record.odds[item.index]) + ' × ' + item.multiple + '</span>'
      ).join("");

      return '<tr>' +
        '<td class="odds-number-cell" style="color:var(--text-subtle);" title="' + escapeHtml(record.sourceFile + ' · 原行号 ' + record.sourceRow) + '">' + record.historyId + '</td>' +
        '<td><span class="badge-league">' + escapeHtml(record.league) + '</span></td>' +
        '<td><div class="fixture-teams"><span>' + escapeHtml(record.home) + ' vs ' + escapeHtml(record.away) + '</span><span class="fixture-score-tag">' + escapeHtml(record.score || '比分未记录') + '</span></div></td>' +
        '<td style="text-align:center;"><span class="actual-goals-badge">' + escapeHtml(record.goals) + '球</span></td>' +
        record.odds.map((_, index) => oddsCell(record, index)).join("") +
        '<td><div class="relation-pill-group">' + relationsHtml + '</div></td>' +
      '</tr>';
    }

    function drilldownRowHtml(record) {
      const relationsHtml = record.relations.map((item) =>
        '<span class="relation-badge">0球 ' + oddsText(record.odds[0]) + ' = ' + item.label + '球 ' + oddsText(record.odds[item.index]) + ' × ' + item.multiple + '</span>'
      ).join("");

      return '<tr>' +
        '<td><span class="badge-league">' + escapeHtml(record.league) + '</span></td>' +
        '<td><div class="fixture-teams"><span>' + escapeHtml(record.home) + ' vs ' + escapeHtml(record.away) + '</span><span class="fixture-score-tag">' + escapeHtml(record.score || '比分未记录') + '</span></div></td>' +
        '<td style="text-align:center;"><span class="actual-goals-badge">' + escapeHtml(record.goals) + '球</span></td>' +
        record.odds.map((_, index) => oddsCell(record, index)).join("") +
        '<td><div class="relation-pill-group">' + relationsHtml + '</div></td>' +
      '</tr>';
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
        right[1] - left[1]
      );
      byId("odds-drilldown-league").innerHTML =
        '<option value="all">全部联赛 (' + selectedRecords.length.toLocaleString("zh-CN") + '场)</option>' +
        options.map(([league, count]) =>
          '<option value="' + escapeHtml(league) + '">' + escapeHtml(league) + ' (' + count.toLocaleString("zh-CN") + '场)</option>'
        ).join("");
      byId("odds-drilldown-league").value = state.selectedDrilldownLeague;
    }

    function renderOddsDrilldown({ resetLeague = false, scroll = false } = {}) {
      const panel = byId("odds-drilldown");
      if (state.selectedZeroOdds === null) {
        panel.hidden = true;
        document.querySelectorAll("tr[data-zero-odds]").forEach((r) => {
          r.classList.remove("selected");
          const hint = r.querySelector(".dist-drill-hint");
          if (hint) hint.textContent = "明细 ▾";
        });
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
      byId("odds-drilldown-title").textContent = "0球赔率 " + zeroOdds + " · 历史比赛逐场明细";
      byId("odds-drilldown-total").textContent = visibleRecords.length.toLocaleString("zh-CN");
      byId("odds-drilldown-total-label").textContent = state.selectedDrilldownLeague === "all"
        ? "场比赛"
        : "场 / 该档总 " + selectedRecords.length.toLocaleString("zh-CN") + " 场";
      byId("odds-drilldown-rows").innerHTML = visibleRecords.length
        ? visibleRecords.map(drilldownRowHtml).join("")
        : '<tr><td colspan="13" style="text-align:center; padding:40px; color:var(--text-muted);">该联赛暂无符合当前口径的比赛</td></tr>';
      byId("odds-drilldown-note").textContent = "0球赔率 " + zeroOdds + " 在上方分布表中共有 " + selectedRecords.length.toLocaleString("zh-CN") + " 场；当前明细展示 " + visibleRecords.length.toLocaleString("zh-CN") + " 场。";
      panel.hidden = false;

      document.querySelectorAll("tr[data-zero-odds]").forEach((row) => {
        const isCurrent = row.dataset.zeroOdds === zeroOdds;
        row.classList.toggle("selected", isCurrent);
        const hint = row.querySelector(".dist-drill-hint");
        if (hint) {
          hint.textContent = isCurrent ? "收起 ▴" : "明细 ▾";
        }
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

      byId("rows").innerHTML = visible.length
        ? visible.map(rowHtml).join("")
        : '<tr><td colspan="13" style="text-align:center; padding:60px; color:var(--text-muted); font-size:15px;">当前筛选条件下没有找到匹配比赛</td></tr>';

      byId("result-title").textContent = "符合条件的历史比赛 (" + state.filtered.length.toLocaleString("zh-CN") + " 场)";
      byId("page-state").textContent = state.filtered.length
        ? "第 " + state.page + " / " + pages + " 页 · 显示 " + (start + 1) + "～" + Math.min(start + size, state.filtered.length) + " 场 (共 " + state.filtered.length.toLocaleString("zh-CN") + " 场)"
        : "共 0 场比赛";

      byId("first-page").disabled = state.page <= 1;
      byId("previous").disabled = state.page <= 1;
      byId("next").disabled = state.page >= pages;
      byId("last-page").disabled = state.page >= pages;
      byId("jump-page").value = state.page;
      byId("jump-page").max = pages;
    }

    // Event listeners
    for (const id of ["search", "league-filter", "band", "actual", "multiple-filter", "page-size"]) {
      byId(id).addEventListener(id === "search" ? "input" : "change", applyFilters);
    }

    byId("search-clear-btn")?.addEventListener("click", () => {
      byId("search").value = "";
      applyFilters();
    });

    byId("first-page").addEventListener("click", () => { state.page = 1; render(); });
    byId("previous").addEventListener("click", () => { state.page = Math.max(1, state.page - 1); render(); });
    byId("next").addEventListener("click", () => { state.page += 1; render(); });
    byId("last-page").addEventListener("click", () => {
      const rawSize = byId("page-size").value;
      const size = rawSize === "all" ? state.filtered.length : Number(rawSize);
      state.page = Math.max(1, Math.ceil(state.filtered.length / size));
      render();
    });

    byId("jump-page").addEventListener("change", (event) => {
      const val = Number(event.target.value);
      if (Number.isFinite(val) && val >= 1) {
        state.page = Math.trunc(val);
        render();
      }
    });

    // Quick chip buttons
    document.querySelectorAll("[data-chip-band]").forEach((btn) => {
      btn.addEventListener("click", () => {
        byId("band").value = btn.dataset.chipBand;
        applyFilters();
      });
    });

    document.querySelectorAll("[data-chip-goals]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const goal = btn.dataset.chipGoals;
        byId("actual").value = byId("actual").value === goal ? "all" : goal;
        applyFilters();
      });
    });

    // Click band cards to filter by goals
    byId("band-goal-grid").addEventListener("click", (event) => {
      const card = event.target.closest("[data-filter-goal]");
      if (!card) return;
      const goal = card.dataset.filterGoal;
      byId("actual").value = byId("actual").value === goal ? "all" : goal;
      applyFilters();
      byId("section-matches").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    // Click distribution row to drill down
    document.querySelector("#section-distribution tbody").addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-zero-odds]");
      if (!row) return;
      const odds = Number(row.dataset.zeroOdds);
      if (state.selectedZeroOdds === odds) {
        state.selectedZeroOdds = null;
        renderOddsDrilldown();
      } else {
        state.selectedZeroOdds = odds;
        renderOddsDrilldown({ resetLeague: true, scroll: true });
      }
    });

    byId("odds-drilldown-close")?.addEventListener("click", () => {
      state.selectedZeroOdds = null;
      renderOddsDrilldown();
    });

    byId("odds-drilldown-league").addEventListener("change", (event) => {
      state.selectedDrilldownLeague = event.target.value;
      renderOddsDrilldown();
    });

    byId("reset-all").addEventListener("click", () => {
      byId("search").value = "";
      byId("league-filter").value = "all";
      byId("band").value = "all";
      byId("actual").value = "all";
      byId("multiple-filter").value = "all";
      byId("page-size").value = "100";
      state.selectedZeroOdds = null;
      renderOddsDrilldown();
      applyFilters();
    });

    // Back to top
    const backToTopBtn = byId("back-to-top");
    window.addEventListener("scroll", () => {
      if (window.scrollY > 300) {
        backToTopBtn.classList.add("visible");
      } else {
        backToTopBtn.classList.remove("visible");
      }
    });
    backToTopBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    // Initialize
    initTheme();
    populateFilters();
    initializeEqualityAnalysis();
    render();
  </script>
</body>
</html>`;
}

const store = createDataStore(DATABASE_PATH);
try {
  const equalityHistory = store.getGoalHistory({ includeScores: true });
  const records = buildGoalMultipleRecords(equalityHistory);
  const goalDistribution = buildGoalDistribution(records);
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
  console.log(`倍率统计数据库样本：${equalityHistory.length.toLocaleString()} 场（全部来源）`);
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
