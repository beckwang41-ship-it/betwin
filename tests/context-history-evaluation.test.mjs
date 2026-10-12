import test from "node:test";
import assert from "node:assert/strict";
import { buildRecentForm } from "../lib/recent-form.mjs";
import { evaluateContextHistory,CONTEXT_HISTORY_PROTOCOL } from "../lib/context-history-evaluation.mjs";

const game=(date,positive)=>({date,homeTeam:"甲",awayTeam:"乙",score:positive?"3:0":"0:2",tournament:"联赛"});
function form(positive=true,h2h=true){const rows=Array.from({length:5},(_,i)=>game(`2025-01-${String(10-i).padStart(2,"0")}`,positive));
 return buildRecentForm({matchId:1,homeTeam:"甲",awayTeam:"乙",history:h2h?rows:[],results:{home:{matches:rows},away:{matches:rows}}},{importedAt:"2025-01-11T00:00:00Z"});}
function row(i,{status="settled",settledOffset=1,positive=i%2===0}={}){const capture=new Date(Date.UTC(2025,0,12+i));
 return {id:i,match_id:String(i),market:"spf",algorithm_version:"v",valid:1,status,league:"联赛",handicap:-1,home_team:"甲",away_team:"乙",
  captured_at:capture.toISOString(),settled_at:status==="settled"?new Date(+capture+settledOffset).toISOString():null,actual_result:status==="settled"?(positive?"胜":"负"):null,
  probabilities_json:"[0.4,0.2,0.4]",settings_json:JSON.stringify({sameLeague:false,recentForm:form(positive)})};}
test("历史状态回放只用目标预测前已结算记录，并保持四组共同样本",()=>{
 const records=Array.from({length:48},(_,i)=>row(i));const r=evaluateContextHistory(records),c=r.comparisons[0];
 assert.equal(CONTEXT_HISTORY_PROTOCOL.minimumTraining,45);assert.equal(c.evaluated,3);assert.equal(c.cases[0].training,45);
 assert.ok(c.cases.every(x=>Date.parse(x.capturedAt)>Date.parse(c.fits.find(f=>f.fitId===x.fitId).latestSettlement)));
 assert.deepEqual(Object.values(c.metrics).map(x=>x.samples),[3,3,3,3]);
});
test("预测后才结算的记录不能提前进入训练",()=>{
 const records=Array.from({length:48},(_,i)=>row(i));records[0]=row(0,{settledOffset:100*86400000});
 const c=evaluateContextHistory(records).comparisons[0];assert.equal(c.evaluated,2);assert.equal(c.cases[0].training,45);
});
