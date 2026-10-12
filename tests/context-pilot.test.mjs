import test from "node:test";
import assert from "node:assert/strict";
import { buildRecentForm } from "../lib/recent-form.mjs";
import { extractContextFeatures } from "../lib/context-features.mjs";
import { PILOT_PROTOCOL,pilotFeatures,pilotSelect,predictContextPilot } from "../lib/context-pilot.mjs";
import { contextPilotBatchKey,contextPilotRecentFormFingerprint,matchingFrozenReport } from "../lib/context-pilot-freeze.mjs";
import { CONTEXT_PROTOCOL } from "../lib/context-experiment.mjs";
const now="2026-09-09T12:00:00Z";
function form(positive=true,h2h=true){
 const games=Array.from({length:5},(_,i)=>({date:`2026-09-0${5-i}`,homeTeam:"甲",awayTeam:"乙",score:positive?"3:0":"0:3",tournament:"联赛"}));
 return buildRecentForm({matchId:1,homeTeam:"甲",awayTeam:"乙",history:h2h?games:[],results:{home:{matches:games},away:{matches:games}}},{importedAt:"2026-09-06T00:00:00Z"});
}
function records(market="spf"){
 return Array.from({length:40},(_,i)=>({id:i,match_id:String(i),market,algorithm_version:"test",valid:1,status:"settled",league:"联赛",handicap:-1,
  home_team:"甲",away_team:"乙",captured_at:"2026-09-07T00:00:00Z",settled_at:"2026-09-08T00:00:00Z",
  actual_result:market==="goals"?"3":i%2?"负":"胜",probabilities_json:JSON.stringify(market==="goals"?Array(8).fill(0.125):[0.4,0.2,0.4]),
  settings_json:JSON.stringify({sameLeague:false,recentForm:form(i%2===0)})}));
}
function target(market="spf",positive=true,h2h=true){
 return {matchId:"new",market,algorithmVersion:"test",capture:Date.parse(now),
  p:market==="goals"?Array(8).fill(0.125):[0.4,0.2,0.4],features:extractContextFeatures(form(positive,h2h),{market,league:"联赛",handicap:-1})};
}
test("小样本独立版本、少特征、强正则，三个玩法实际拟合且不修改A",()=>{
 assert.equal(CONTEXT_PROTOCOL.minimumTraining,200);assert.ok(PILOT_PROTOCOL.l2>CONTEXT_PROTOCOL.l2);
 for(const market of ["spf","hhad","goals"]){
  const t=target(market),original=structuredClone(t),r=predictContextPilot(records(market),[t],{generatedAt:now});
  const p=r.pendingPredictions[0].predictions;
  assert.deepEqual(p.A.probabilities,t.p);assert.deepEqual(t,original);assert.equal(r.models[0].training,40);
  for(const a of ["B","C","D"]){assert.notDeepEqual(p[a].probabilities,p.A.probabilities);assert.ok(Math.abs(p[a].probabilities.reduce((a,b)=>a+b)-1)<1e-12);}
  assert.equal(Object.keys(pilotFeatures(t.features,market).state).length,market==="hhad"?14:12);
 }
});
test("状态与交锋分别改变相应候选，无交锋严格C=A、D=B",()=>{
 const predict=t=>predictContextPilot(records(),[t],{generatedAt:now}).pendingPredictions[0].predictions;
 const a=target(),b=target("spf",false),changed=structuredClone(a);changed.features.history=b.features.history;
 assert.deepEqual(predict(a).B,predict(changed).B);assert.notDeepEqual(predict(a).C,predict(changed).C);
 const absent=predict(target("spf",true,false));assert.deepEqual(absent.C,absent.A);assert.deepEqual(absent.D,absent.B);
});
test("只用已结算同版本训练，排除整个目标批次及未来结算",()=>{
 const rows=records();rows.push({...rows[0],id:100,match_id:"new"},
  {...rows[0],id:101,match_id:"future",settled_at:"2027-01-01T00:00:00Z"},
  {...rows[0],id:102,match_id:"other",algorithm_version:"other"});
 const r=predictContextPilot(rows,[target(),{...target(),matchId:"0"}],{generatedAt:now});
 assert.equal(r.models[0].training,39);assert.ok(r.models[0].trainingRows.every(r=>r.matchId!=="0"&&r.matchId!=="new"));
 assert.throws(()=>predictContextPilot(rows.slice(0,5),[target()],{generatedAt:now}),/训练不足/);
 assert.throws(()=>predictContextPilot(rows,[{...target(),capture:Date.parse(now)+1000}],{generatedAt:now}),/时间/);
});
test("非法概率拒绝，选择和并列顺序确定且双选用同一分布",()=>{
 assert.throws(()=>pilotSelect([1,1,1],"spf"),/概率/);
 const p=pilotSelect(Array(8).fill(0.125),"goals");assert.deepEqual(p.pair,["0","1"]);assert.equal(p.pairCoverage,0.25);assert.equal(p.tiedTop.length,8);
});
test("自动冻结按稳定批次指纹去重，导入时间变化不造成重复",()=>{
 const base={protocolFingerprint:"p",sources:[{file_name:"match_data1.json",sha256:"x",record_count:2,file_size:3,imported_at:"old"},{file_name:"history.xlsx",sha256:"y"}],
  matches:[{id:2,league:"甲",home:"主",away:"客",had:{odds:[1,2,3]}}],baselineOutputs:[{matchId:"2",markets:{spf:[0.4,0.3,0.3]}}]};
 const key=contextPilotBatchKey(base),again=contextPilotBatchKey({...base,sources:base.sources.map(s=>({...s,imported_at:"new"}))});
 assert.equal(key,again);assert.notEqual(key,contextPilotBatchKey({...base,matches:[{...base.matches[0],home:"新主"}]}));
 assert.notEqual(key,contextPilotBatchKey({...base,baselineOutputs:[{matchId:"2",markets:{spf:[0.5,0.2,0.3]}}]}));
 assert.equal(matchingFrozenReport([{batchKey:key,protocolFingerprint:"p",pendingPredictions:[{}]}],{batchKey:key,protocolFingerprint:"p"})?.batchKey,key);
 assert.equal(matchingFrozenReport([{batchKey:key,protocolFingerprint:"old",pendingPredictions:[{}]}],{batchKey:key,protocolFingerprint:"p"}),null);
});
test("相同战绩重复导入不会只因 importedAt 变化而生成新批次",()=>{
 const first={version:"recent-form-v1-five-matches",importedAt:"2026-09-20T01:00:00.000Z",sourceHash:"same",home:{recent:{rows:[{date:"2026-09-19"}]}}};
 const second={...first,importedAt:"2026-09-20T02:00:00.000Z"};
 assert.equal(contextPilotRecentFormFingerprint(first),contextPilotRecentFormFingerprint(second));
 assert.notEqual(contextPilotRecentFormFingerprint(first),contextPilotRecentFormFingerprint({...second,sourceHash:"changed"}));
});
