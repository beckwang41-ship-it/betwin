import { createHash } from "node:crypto";
import { normalizeTeamName } from "./fixture-name.mjs";

export const RECENT_FORM_VERSION = "recent-form-v1-five-matches";
// 当前赔率与详情同一 matchId 下已核对的简称，仅用于战绩关联，不改变历史结算匹配。
const FORM_ALIASES = new Map(Object.entries({ "名古屋鲸": "名古屋鲸八", "町田泽维": "町田泽维亚", "伍尔弗": "伍尔弗汉普顿", "弗洛西诺": "弗洛西诺内", "AIK索尔纳": "索尔纳", "胡巴尔卡德西亚": "胡巴卡德",
  "里斯本竞技": "里斯本", "加拉塔萨雷": "加拉塔萨", "布拉迪斯拉发": "布拉迪斯",
  "女王公园巡游者": "女王巡游", "帕尔梅拉斯": "帕梅拉斯", "基多体育大学": "基多体大",
  "拉普拉塔大学生": "拉普大学", "芝加哥火焰": "芝加哥", "迈阿密国际": "迈国际" }));
const formTeam = value => normalizeTeamName(FORM_ALIASES.get(value) || value);
const empty = () => ({ matches: 0, wins: 0, draws: 0, losses: 0, points: 0,
  goalsFor: 0, goalsAgainst: 0, goalDifference: 0, totalGoals: 0,
  cleanSheets: 0, failedToScore: 0, winsByTwoPlus: 0, lossesByTwoPlus: 0,
  goalsDistribution: Array(8).fill(0), outcomes: [], rows: [] });
const day = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value ? value : null;
};
function summarize(rows) {
  if (!rows.length) return null;
  const s=empty();
  for (const r of rows) {
    s.matches++; s.goalsFor+=r.gf; s.goalsAgainst+=r.ga; s.totalGoals+=r.gf+r.ga;
    s.wins+=Number(r.gf>r.ga);s.draws+=Number(r.gf===r.ga);s.losses+=Number(r.gf<r.ga);
    s.cleanSheets+=Number(r.ga===0);s.failedToScore+=Number(r.gf===0);
    s.winsByTwoPlus+=Number(r.gf-r.ga>=2);s.lossesByTwoPlus+=Number(r.ga-r.gf>=2);
    s.goalsDistribution[Math.min(7,r.gf+r.ga)]++;
    s.outcomes.push(r.gf>r.ga?"胜":r.gf===r.ga?"平":"负");s.rows.push(r);
  }
  s.points=s.wins*3+s.draws;s.goalDifference=s.goalsFor-s.goalsAgainst;
  return {...s,pointsPerGame:s.points/s.matches,goalsForPerGame:s.goalsFor/s.matches,
    goalsAgainstPerGame:s.goalsAgainst/s.matches,totalGoalsPerGame:s.totalGoals/s.matches};
}

function parseRows(input,team,cutoff,opponent=null) {
  const accepted=[], seen=new Set(), issues=[];
  for (const row of Array.isArray(input)?input:[]) {
    const date=day(row?.date), score=/^(\d{1,2})\s*[:：-]\s*(\d{1,2})$/.exec(String(row?.score || "").trim());
    const home=formTeam(row?.homeTeam),away=formTeam(row?.awayTeam);
    if (!date || !score || !home || !away || home===away) {issues.push("日期、比分或球队信息不完整");continue;}
    if (cutoff && date>cutoff) {issues.push("已排除晚于本次数据日期的战绩");continue;}
    const isHome=home===team, isAway=away===team;
    if (!isHome && !isAway) {issues.push("球队名称未匹配，未计入统计");continue;}
    if (opponent && (isHome?away:home)!==opponent) {issues.push("交锋对手未匹配，未计入统计");continue;}
    const key=`${date}|${home}|${away}`;
    if(seen.has(key)){issues.push("重复比赛已排除");continue;}seen.add(key);
    const h=Number(score[1]),a=Number(score[2]);
    accepted.push({date,home:row.homeTeam,away:row.awayTeam,score:row.score,
      tournament:String(row.tournament || ""),venue:isHome?"home":"away",gf:isHome?h:a,ga:isHome?a:h});
  }
  accepted.sort((a,b)=>b.date.localeCompare(a.date));
  return {rows:accepted,issues:[...new Set(issues)]};
}

function summaryStats(stats) {
  const keys=["totalLegCnt","goalCnt","lossGoalCnt","winGoalMatchCnt","drawMatchCnt"];
  if (!stats || keys.some(k=>!Number.isInteger(stats[k]) || stats[k]<0) || stats.totalLegCnt<1 ||
      stats.winGoalMatchCnt+stats.drawMatchCnt>stats.totalLegCnt) return null;
  return {reportedMatches:stats.totalLegCnt,goalsFor:stats.goalCnt,goalsAgainst:stats.lossGoalCnt,
    wins:stats.winGoalMatchCnt,draws:stats.drawMatchCnt,
    losses:stats.totalLegCnt-stats.winGoalMatchCnt-stats.drawMatchCnt,
    sourceSummary:true,independentlyVerified:false};
}

export function buildRecentForm(detail, {match=null, importedAt=null, sourceHash=null}={}) {
  const base={version:RECENT_FORM_VERSION,source:"match_data1.json",importedAt,sourceHash,
    affectsProduction:false,available:false,home:null,away:null,headToHead:null,
    timing:"source-prematch-assumed",notes:[]};
  if (!detail || typeof detail!=="object") return {...base,notes:["当前导入批次没有这场比赛的战绩资料"]};
  const home=formTeam(detail.homeTeam),away=formTeam(detail.awayTeam);
  if (!home || !away || home===away || (match && (String(detail.matchId)!==String(match.id) ||
      home!==formTeam(match.home) || away!==formTeam(match.away)))) {
    return {...base,notes:["对阵身份与当前赔率比赛不一致，未使用战绩资料"]};
  }
  const importedDate=importedAt && Number.isFinite(Date.parse(importedAt))
    ? new Date(Date.parse(importedAt)+8*3600000).toISOString().slice(0,10):null;
  const result={...base,detailHash:createHash("sha256").update(JSON.stringify(detail)).digest("hex")};
  for (const [side,team] of [["home",home],["away",away]]) {
    const parsed=parseRows(detail.results?.[side]?.matches,team,importedDate);
    const rows=parsed.rows.slice(0,5), summary=summaryStats(detail.results?.[side]?.stats);
    result[side]={team:detail[`${side}Team`],recent:summarize(rows),
      sameLeague:summarize(rows.filter(r=>r.tournament===detail.league)),
      homeVenue:summarize(rows.filter(r=>r.venue==="home")),awayVenue:summarize(rows.filter(r=>r.venue==="away")),
      sourceSummary:summary,issues:parsed.issues};
    if (rows.length<5) result.notes.push(`${side==="home"?"主队":"客队"}有效近期战绩不足5场`);
    if (summary && summary.reportedMatches!==rows.length) result.notes.push(`${side==="home"?"主队":"客队"}${summary.reportedMatches}场汇总与${rows.length}场明细分开使用`);
    result.notes.push(...parsed.issues);
  }
  const h2h=parseRows(detail.history,home,importedDate,away);
  result.headToHead=summarize(h2h.rows);
  result.notes.push(...h2h.issues);
  result.notes.push("近期战绩仅作状态观察，尚未用于修正正式概率；主客场子样本来自这5场，可能很少");
  result.notes=[...new Set(result.notes)];
  result.available=Boolean(result.home.recent || result.away.recent);
  return result;
}

// 固定小特征集；10场上游汇总和交锋不混进5场模型，也不把缺失当作0。
export function recentFormFeatures(context) {
  if(context?.version!==RECENT_FORM_VERSION) return null;
  const sides=[context.home?.recent,context.away?.recent];
  if(sides.some(s=>!s || s.matches<3))return null;
  return sides.flatMap(s=>[s.pointsPerGame/3,s.goalsForPerGame/5,s.goalsAgainstPerGame/5,
    s.winsByTwoPlus/s.matches,s.lossesByTwoPlus/s.matches,s.cleanSheets/s.matches,s.failedToScore/s.matches]);
}
