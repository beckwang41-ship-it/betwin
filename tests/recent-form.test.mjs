import test from "node:test";
import assert from "node:assert/strict";
import { buildRecentForm,recentFormFeatures } from "../lib/recent-form.mjs";
const game=(date,home,away,score,tournament="英超")=>({date,homeTeam:home,awayTeam:away,score,tournament});
const detail={matchId:1,homeTeam:"曼城",awayTeam:"阿森纳",league:"英超",history:[],results:{
  home:{stats:{totalLegCnt:10,goalCnt:20,lossGoalCnt:10,winGoalMatchCnt:6,drawMatchCnt:2},matches:[
    game("2026-09-01","曼彻斯特城","切尔西","3:0"),game("2026-09-02","利物浦","曼城","2:1"),
    game("2026-09-03","曼城","曼联","1:1","英联赛杯")]},
  away:{matches:[game("2026-09-01","阿森纳","切尔西","1:0"),game("2026-09-02","利物浦","阿森纳","1:2"),game("2026-09-03","阿森纳","曼联","0:0")]}}};
test("按球队视角计算近况，主队近期战绩不等同于主场战绩，10场汇总分开",()=>{
 const r=buildRecentForm(detail,{importedAt:"2026-09-04T00:00:00Z"});
 assert.equal(r.available,true);assert.equal(r.home.recent.goalsFor,5);assert.equal(r.home.recent.goalsAgainst,3);
 assert.deepEqual(r.home.recent.outcomes,["平","负","胜"]);
 assert.equal(r.home.homeVenue.matches,2);assert.equal(r.home.awayVenue.matches,1);
 assert.equal(r.home.sameLeague.matches,2);assert.equal(r.home.sourceSummary.reportedMatches,10);
 assert.equal(r.home.recent.winsByTwoPlus,1);assert.equal(recentFormFeatures(r).length,14);
});
test("排除未来、无效、其他球队和重复记录；缺失不补零或制造概率",()=>{
 const d=structuredClone(detail);d.results.home.matches.push(d.results.home.matches[0],game("2027-01-01","曼城","切尔西","7:0"),game("2026-09-03","利物浦","切尔西","2:0"),game("2026-02-30","曼城","切尔西","2:0"));
 const r=buildRecentForm(d,{importedAt:"2026-09-04T00:00:00Z"});assert.equal(r.home.recent.matches,3);assert.equal(r.home.issues.length,4);
 assert.equal(buildRecentForm(null).available,false);assert.equal(recentFormFeatures(buildRecentForm({matchId:1,homeTeam:"曼城",awayTeam:"阿森纳"})),null);
 assert.equal(r.affectsProduction,false);
});
test("对阵错配拒绝使用；只有双方交锋才计入交锋样本",()=>{
 assert.equal(buildRecentForm(detail,{match:{id:1,home:"阿森纳",away:"曼城"}}).available,false);
 const d={...detail,history:[game("2026-08-01","阿森纳","曼城","1:2"),game("2026-08-02","曼城","切尔西","7:0")]};
 const r=buildRecentForm(d);assert.equal(r.headToHead.matches,1);assert.equal(r.headToHead.goalsFor,2);
});

test("已核对的当前赔率简称可关联详情，但matchId仍必须一致",()=>{
 const d={...detail,homeTeam:"名古屋鲸八",awayTeam:"町田泽维亚",results:{home:{matches:[game("2026-09-01","名古屋鲸","町田泽维","1:0")]}}};
 const match={id:1,home:"名古屋鲸",away:"町田泽维"};
 assert.equal(buildRecentForm(d,{match}).home.recent.wins,1);
 assert.equal(buildRecentForm(d,{match:{...match,id:2}}).available,false);
});

test("AIK索尔纳详情与索尔纳赔率、战绩明细关联一致",()=>{
 const d={matchId:9,homeTeam:"马尔默",awayTeam:"AIK索尔纳",history:[],results:{away:{matches:[game("2026-09-01","索尔纳","哈马比","3:2")]}}};
 const r=buildRecentForm(d,{match:{id:9,home:"马尔默",away:"索尔纳"}});
 assert.equal(r.available,true);assert.equal(r.away.recent.wins,1);assert.equal(r.away.recent.goalsFor,3);
});

test("胡巴尔卡德西亚详情与胡巴卡德赔率、战绩明细关联一致",()=>{
 const d={matchId:12,homeTeam:"胡巴尔卡德西亚",awayTeam:"吉达国民",history:[],results:{home:{matches:[game("2026-09-04","Draih","胡巴卡德","0:2")]}}};
 const match={id:12,home:"胡巴卡德",away:"吉达国民"};
 const r=buildRecentForm(d,{match});assert.equal(r.available,true);assert.equal(r.home.recent.wins,1);assert.equal(r.home.recent.goalsFor,2);
 assert.equal(buildRecentForm(d,{match:{...match,id:13}}).available,false);
});

test("新批次六场对阵的简称在详情、近期与交锋中一致关联",()=>{
 const pairs=[["里斯本","里斯本竞技","加拉塔萨","加拉塔萨雷"],
  ["巴黎圣曼","巴黎圣日尔曼","布拉迪斯","布拉迪斯拉发"],
  ["查尔顿","查尔顿","女王巡游","女王公园巡游者"],
  ["帕梅拉斯","帕尔梅拉斯","基多体大","基多体育大学"],
  ["拉普大学","拉普拉塔大学生","科林蒂安","科林蒂安"],
  ["芝加哥","芝加哥火焰","迈国际","迈阿密国际"]];
 for(const [home,fullHome,away,fullAway] of pairs){
  const g=game("2026-09-01",home,away,"2:1");
  const d={matchId:20,homeTeam:fullHome,awayTeam:fullAway,history:[g],results:{home:{matches:[g]},away:{matches:[g]}}};
  const match={id:20,home,away},r=buildRecentForm(d,{match});
  assert.equal(r.home.recent.wins,1,home);assert.equal(r.away.recent.losses,1,away);assert.equal(r.headToHead.matches,1);
  assert.equal(buildRecentForm(d,{match:{...match,id:21}}).available,false);
 }
});
