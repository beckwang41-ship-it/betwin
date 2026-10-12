import test from "node:test";
import assert from "node:assert/strict";
import { extractContextFeatures } from "../lib/context-features.mjs";
import { compareContext,prepareContextRows,summarizeContextCases,evaluateFrozenContext } from "../lib/context-experiment.mjs";
import { RECENT_FORM_VERSION } from "../lib/recent-form.mjs";

function game(i,gf,ga,venue="home",tournament="联赛") {
  return {date:`2024-12-${String(25-i).padStart(2,"0")}`,home:venue==="home"?"甲":"乙",away:venue==="home"?"乙":"甲",gf,ga,venue,tournament};
}
function form(positive=true,h2h=true) {
  return {version:RECENT_FORM_VERSION,importedAt:"2025-01-01T00:00:00Z",timing:"source-prematch-assumed",
    home:{recent:{rows:Array.from({length:5},(_,i)=>game(i,positive?3:0,positive?0:2,i%2?"away":"home",i===0?"杯赛":"联赛"))}},
    away:{recent:{rows:Array.from({length:5},(_,i)=>game(i,positive?0:3,positive?2:0,i%2?"away":"home"))}},
    headToHead:h2h?{rows:[game(8,positive?2:0,positive?0:2),game(9,1,1,"away")]}:null};
}
function row(i,overrides={}) {
  const capture=new Date(Date.UTC(2025,0,2+i));
  return {id:i,match_id:String(i),market:"spf",algorithm_version:"test-v1",valid:1,status:"settled",league:"联赛",handicap:-1,
    home_team:"甲",away_team:"乙",captured_at:capture.toISOString(),settled_at:new Date(+capture+1000).toISOString(),
    actual_result:i%2?"负":"胜",probabilities_json:"[0.4,0.2,0.4]",settings_json:JSON.stringify({sameLeague:false,recentForm:form(i%2===0)}),...overrides};
}

test("近期状态使用胜平负、趋势、主客场和比赛类型，而非仅进失球均值",()=>{
  const f=form(),s=extractContextFeatures(f,{league:"联赛"});
  assert.equal(s.state["home.winRate"],1);assert.equal(s.state["home.winningRun"],1);
  assert.equal(s.state["home.venue.sampleFraction"],3/5);assert.equal(s.state["home.cup.sampleFraction"],1/5);
  assert.equal(s.state["home.sameCompetition.sampleFraction"],4/5);
  const changed=structuredClone(f);changed.home.recent.rows=[game(0,0,2),game(1,0,2),game(2,3,0),game(3,3,0),game(4,3,0)];
  const first=extractContextFeatures(changed).state;
  changed.home.recent.rows=changed.home.recent.rows.map((r,i)=>({...r,gf:i<3?3:0,ga:i<3?0:2}));
  const second=extractContextFeatures(changed).state;
  assert.equal(first["home.goalsFor"],second["home.goalsFor"]);
  assert.notEqual(first["home.pointsTrend"],second["home.pointsTrend"]);
  assert.notEqual(first["home.winningRun"],second["home.winningRun"]);
});
test("交锋使用当前主队视角、时间和场地；让球映射不混淆两队视角",()=>{
  const f=form();f.headToHead.rows=[game(8,2,0,"away"),game(9,0,1,"home")];
  const h=extractContextFeatures(f,{market:"hhad",handicap:-1,league:"联赛"});
  assert.ok(h.history["h2h.winRate"]>h.history["h2h.lossRate"]);
  assert.equal(h.history["h2h.homeVenueWin"],0);
  assert.equal(h.state["home.currentHandicap.win"],1);
  assert.equal(h.state["away.currentHandicap.win"],1);
  const older=structuredClone(f);older.headToHead.rows[0].date="2020-01-01";
  assert.ok(extractContextFeatures(older).history["h2h.winRate"]<extractContextFeatures(f).history["h2h.winRate"]);
  const absent=extractContextFeatures(form(true,false));
  assert.equal(absent.quality.hasH2h,false);assert.ok(absent.historyVector.every(v=>v===0));
});
test("未来/无效/重复明细拒绝使用，不依赖10场汇总或当前文件",()=>{
  const f=form();f.home.sourceSummary={wins:10000};
  assert.deepEqual(extractContextFeatures(f).state,extractContextFeatures(form()).state);
  f.home.recent.rows[0].date="2030-01-01";assert.equal(extractContextFeatures(f).available,false);
  const dup=form();dup.home.recent.rows.push(dup.home.recent.rows[0]);assert.equal(extractContextFeatures(dup).available,false);
  const invalid=form();invalid.home.recent.rows[0].date="2024-02-30";assert.equal(extractContextFeatures(invalid).available,false);
});
test("同赔率但交锋不同会改变C特征，不会改变B；同赔率状态不同会改变B",()=>{
  const a=extractContextFeatures(form());const bform=form();bform.headToHead.rows=[game(8,0,4)];const b=extractContextFeatures(bform);
  assert.deepEqual(a.stateVector,b.stateVector);assert.notDeepEqual(a.historyVector,b.historyVector);
  assert.notDeepEqual(a.stateVector,extractContextFeatures(form(false)).stateVector);
});
test("缺少快照/非法时间/重复记录可审计，缺少训练不伪造三组预测",()=>{
  const base=row(0);const bad=row(1);const s=JSON.parse(bad.settings_json);s.recentForm.importedAt="2030-01-01T00:00:00Z";bad.settings_json=JSON.stringify(s);
  const p=prepareContextRows([base,{...base,id:100},row(2,{settings_json:"{}"}),bad]);
  assert.equal(p.counts.duplicates,1);assert.equal(p.counts.missingContext,1);assert.equal(p.counts.invalid,1);
  const r=compareContext([base,row(4,{status:"pending"})],{generatedAt:"2026-01-01T00:00:00Z",activeMatchIds:["4"]});
  assert.equal(r.comparisons[0].evaluated,0);assert.equal(r.comparisons[0].metrics.A,null);
  assert.equal(r.pendingPredictions[0].predictions.B,null);assert.equal(r.pendingPredictions[0].status,"awaiting-training");
});
test("四组真实拟合、同批比较，未来结算和不同版本不能进入训练",()=>{
  const records=Array.from({length:201},(_,i)=>row(i));
  // 评估目标自身不含交锋，C必须退回原赔率概率。
  records[200].settings_json=JSON.stringify({sameLeague:false,recentForm:form(true,false)});
  const options={generatedAt:"2026-01-01T00:00:00Z",activationAt:"2025-01-01T00:00:00Z"};
  const r=compareContext(records,options),c=r.comparisons[0];
  assert.equal(c.evaluated,1);assert.equal(c.metrics.A.samples,c.metrics.D.samples);
  assert.deepEqual(c.cases[0].predictions.C,c.cases[0].predictions.A);
  assert.notDeepEqual(c.cases[0].predictions.B,c.cases[0].predictions.A);
  assert.notDeepEqual(c.cases[0].predictions.D,c.cases[0].predictions.A);
  for(const p of Object.values(c.cases[0].predictions)){assert.ok(p.every(v=>v>=0&&v<=1));assert.ok(Math.abs(p.reduce((a,b)=>a+b,0)-1)<1e-8);}
  assert.equal(c.fits[0].training,200);assert.ok(!c.fits[0].trainingIds.includes("200"));
  assert.ok(Date.parse(c.fits[0].latestSettlement)<Date.parse(c.cases[0].capturedAt));
  const late=compareContext(records.map(r=>({...r,settled_at:"2025-12-01T00:00:00Z"})),options);
  assert.equal(late.comparisons[0].evaluated,0);
  const split=compareContext(records.map((r,i)=>({...r,algorithm_version:i<150?"a":"b"})),options);
  assert.ok(split.comparisons.every(c=>c.evaluated===0));
});
test("胜平负、让球及进球使用各自标签，双选与单选分开计分",()=>{
  const p=[0.02,0.05,0.3,0.4,0.1,0.05,0.04,0.04],cases=[{y:2,predictions:{A:p,B:p,C:p,D:p}}];
  const m=summarizeContextCases(cases,"goals");assert.equal(m.A.hits,0);assert.equal(m.A.pairHits,1);
  assert.equal(m.A.pairHitRate,1);assert.equal(m.A.pairCoverage,0.7);
  const records=[row(0,{market:"hhad"}),row(1,{market:"goals",actual_result:"2",probabilities_json:JSON.stringify(p)})];
  assert.equal(prepareContextRows(records).counts.settled,2);
});

test("样本满足后会输出实际四组预测与训练系数，C确实利用交锋",()=>{
 const records=Array.from({length:200},(_,i)=>row(i));records.push(row(205,{status:"pending"}));
 const r=compareContext(records,{generatedAt:"2026-01-01T00:00:00Z",activeMatchIds:["205"]});
 const p=r.pendingPredictions[0];assert.equal(p.status,"experimental-not-production");
 for(const arm of ["B","C","D"])assert.notDeepEqual(p.predictions[arm].probabilities,p.predictions.A.probabilities);
 assert.equal(r.comparisons[0].fits.at(-1).id,p.fitId);
 assert.equal(r.comparisons[0].fits.at(-1).trainingIds.includes("205"),false);
});

test("提前冻结结算取最早版本，不使用结算后预测、坏时间或启动前已知结果",()=>{
 const r=row(1,{settled_at:"2025-01-05T00:00:00Z"});
 const p={matchId:"1",market:"spf",algorithmVersion:"test-v1",forecastAt:"2025-01-03T12:00:00Z",status:"experimental-not-production",
   predictions:Object.fromEntries(["A","B","C","D"].map(a=>[a,{probabilities:[0.1,0.1,0.8]}]))};
 const report={protocolFingerprint:"p1",sourceReport:"first.json",pendingPredictions:[p]};
 const later={...report,sourceReport:"later.json",pendingPredictions:[{...p,forecastAt:"2025-01-04T00:00:00Z",predictions:Object.fromEntries(["A","B","C","D"].map(a=>[a,{probabilities:[0.8,0.1,0.1]}]))}]};
 const options={fingerprint:"p1",activationAt:"2025-01-01T00:00:00Z"};
 const result=evaluateFrozenContext([later,report],[r],options);
 assert.equal(result[0].metrics.B.hits,1);assert.equal(result[0].metrics.B.samples,1);assert.equal(result[0].cases[0].sourceReport,"first.json");
 assert.equal(evaluateFrozenContext([report],[r],{...options,knownSettledMatchIds:["1"]}).length,0);
 assert.equal(evaluateFrozenContext([{...report,pendingPredictions:[{...p,forecastAt:"2025-01-06T00:00:00Z"}]}],[r],options).length,0);
 assert.equal(evaluateFrozenContext([{...report,pendingPredictions:[{...p,forecastAt:"invalid"}]}],[r],options).length,0);
});
