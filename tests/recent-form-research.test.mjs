import test from "node:test";
import assert from "node:assert/strict";
import { compareRecentForm } from "../lib/recent-form-research.mjs";
import { RECENT_FORM_VERSION } from "../lib/recent-form.mjs";
const stats={matches:5,pointsPerGame:1.5,goalsForPerGame:1.5,goalsAgainstPerGame:1,winsByTwoPlus:1,lossesByTwoPlus:1,cleanSheets:2,failedToScore:1};
function row(i,overrides={}) {
 const captured=new Date(Date.UTC(2025,0,2+i));
 return {id:i,match_id:String(i),market:"spf",algorithm_version:"test-v1",valid:1,status:"settled",captured_at:captured.toISOString(),settled_at:new Date(+captured+1000).toISOString(),
 actual_result:["胜","平","负"][i%3],probabilities_json:"[0.5,0.3,0.2]",settings_json:JSON.stringify({sameLeague:false,recentForm:{version:RECENT_FORM_VERSION,importedAt:"2025-01-01T00:00:00Z",home:{recent:stats},away:{recent:stats}}}),...overrides};
}
test("旧账本不回填战绩，待结算不当作训练样本",()=>{
 const r=compareRecentForm([row(1,{settings_json:"{}"}),row(2,{status:"pending"}),row(3)]);
 assert.equal(r.counts.withoutFeatures,1);assert.equal(r.counts.pending,1);assert.equal(r.counts.eligibleSettled,1);
 assert.equal(r.comparisons[0].baseline,null);assert.equal(r.productionChanged,false);
});
test("滚动对照必须有200条此前已结算样本，不跨版本训练",()=>{
 const rows=Array.from({length:202},(_,i)=>row(i));
 const r=compareRecentForm(rows).comparisons[0];
 assert.equal(r.evaluated,2);assert.equal(r.baseline.samples,r.candidate.samples);assert.ok(Number.isFinite(r.candidate.logLoss));
 const late=compareRecentForm(rows.map(r=>({...r,settled_at:"2027-01-01T00:00:00Z"})));
 assert.equal(late.comparisons[0].evaluated,0);
 const split=compareRecentForm(rows.map((r,i)=>({...r,algorithm_version:i<150?"a":"b"})));
 assert.ok(split.comparisons.every(r=>r.evaluated===0));
});
test("让球使用账本原始标签；双选对照按前两项统计；未来导入被拒绝",()=>{
 const rows=Array.from({length:201},(_,i)=>row(i,{market:"goals",actual_result:"2",probabilities_json:"[0.05,0.1,0.35,0.3,0.1,0.05,0.03,0.02]"}));
 assert.equal(compareRecentForm(rows).comparisons[0].baseline.pairHitRate,1);
 assert.equal(compareRecentForm([row(0,{market:"hhad"})]).counts.eligibleSettled,1);
 const bad=row(0);const settings=JSON.parse(bad.settings_json);settings.recentForm.importedAt="2030-01-01T00:00:00Z";
 assert.equal(compareRecentForm([{...bad,settings_json:JSON.stringify(settings)}]).counts.invalid,1);
});
