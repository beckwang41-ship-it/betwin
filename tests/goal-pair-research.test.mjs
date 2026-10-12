import test from "node:test";
import assert from "node:assert/strict";
import { attachGoalContexts, runGoalPairResearch, pairOutcome, summarizePairs, selectOnDevelopment, fitCoverageCalibration, summarizeCoverageCalibration } from "../lib/goal-pair-research.mjs";
import { selectProductionGoalSimilarity, predictProductionGoals } from "../lib/goal-production.mjs";

const odds = [12, 5, 3.5, 3.6, 6, 10, 20, 30];
const row = (n, goals = "2", sourceFile = "a") => ({ sourceFile, sourceRow: n, odds, initialOdds: odds, goals,
  spf: { odds: [2, 3, 4] }, hhad: { odds: [3, 3, 2], handicap: -1 } });
const policies = [{ id: "full-2", kind: "full", k: 2 }, { id: "joint-2", kind: "joint", k: 2 }];

test("盘口关联只使用数据库外键，重复来源行不会串场", () => {
  const g={...row(1),historyId:10,home:"曼城"};
  const v={...row(1),goalHistoryId:10,home:"曼彻斯特城",goalSourceFile:"a",goalSourceRow:1,goalMarket:{odds}};
  assert.equal(attachGoalContexts([g],[v]).joined,1);
  assert.equal(attachGoalContexts([g],[v,v]).ambiguous,1);
  assert.equal(attachGoalContexts([g],[{...v,goalMarket:{odds:[99,...odds.slice(1)]}}]).inconsistent,1);
  assert.equal(attachGoalContexts([g],[{...v,goalHistoryId:11}]).joined,0);
  assert.equal(attachGoalContexts([g],[{...v,goalHistoryId:undefined}]).joined,0);
  assert.equal(attachGoalContexts([g],[v,{...v,goalHistoryId:11}]).joined,1);
});

test("双选固定两项，并按两注成本结算；7+与并列沿用生产规则", () => {
  const p = [.05,.05,.3,.3,.1,.05,.05,.1];
  const hit = pairOutcome(p, odds, 2);
  assert.deepEqual(hit.labels, ["2","3"]);
  assert.equal(hit.stakeUnits, 2);
  assert.equal(hit.profitUnits, 1.5);
  assert.equal(pairOutcome(p, odds, 4).profitUnits, -2);
  assert.ok(pairOutcome([.01,.01,.01,.01,.01,.01,.01,.93], odds, 7).hit);
  assert.equal(pairOutcome(Array(8).fill(.125), odds, 0).labels.length, 2);
});

test("回测基线精确复用生产概率，排除当前和未来赛果，不混合来源", () => {
  const rows = [row(4,"3"), row(2,"1"), row(1), row(3), row(1,"7+","b")];
  const run = runGoalPairResearch(rows, { warmup: 2, policies });
  const actual = run.cases.find(x => x.sourceRow === 3);
  const expected = predictProductionGoals(odds, selectProductionGoalSimilarity([row(1),row(2,"1")],row(3)),
    { blendOptions: { empiricalOnly: true, requireSamples: true } });
  assert.deepEqual(actual.predictions.baseline.probabilities, expected.final);
  assert.equal(actual.predictions["full-2"].samples, 2);
  const changed = runGoalPairResearch(rows.map(x => x.sourceRow >= 3 ? {...x,goals:"7+"} : x), {warmup:2,policies});
  assert.deepEqual(changed.cases[0].predictions, actual.predictions);
  assert.equal(run.sources.find(x=>x.sourceFile === "b").evaluated,0);
});

test("缺跨盘口数据或让球数不同不伪造联合预测；重复行号显式报错", () => {
  const run = runGoalPairResearch([row(1),{...row(2),hhad:null},{...row(3),hhad:{odds:[3,3,2],handicap:1}}], {warmup:1,policies});
  assert.equal(run.cases[0].predictions["joint-2"], null);
  assert.equal(run.cases[1].predictions["joint-2"], null);
  assert.ok(run.cases[0].predictions["full-2"]);
  assert.throws(()=>runGoalPairResearch([row(1),row(1)],{warmup:1,policies}),/重复/);
});

test("统计展示覆盖率、两注ROI和校准，开发段选参不看末段", () => {
  const p = [.05,.05,.3,.3,.1,.05,.05,.1];
  const cases = [2,4].map(actualIndex=>({period:"development",actualIndex,odds,predictions:{baseline:{probabilities:p,samples:10,effectiveSamples:10},x:{probabilities:p,samples:10,effectiveSamples:10}}}));
  const m = summarizePairs(cases,"x");
  assert.equal(m.pairHitRate,.5);
  assert.equal(m.stakeUnits,4);
  assert.equal(m.roi,-.125);
  assert.equal(m.meanPredictedCoverage,.6);
  assert.ok(Math.abs(m.coverageGap - .1) < 1e-12);
  const a = selectOnDevelopment(cases,[{id:"x"}]);
  assert.deepEqual(selectOnDevelopment([...cases,{period:"observedTail",predictions:{}}],[{id:"x"}]),a);
});

test("完整赔率候选不会沿用0球硬窗口，仍然只预测两个档位", () => {
  const rows=[{...row(1,"7+"),odds:[30,5,3.5,3.6,6,10,20,30]},row(2)];
  const result=runGoalPairResearch(rows,{warmup:1,policies}).cases[0];
  assert.equal(result.predictions.baseline,null);
  assert.equal(result.predictions["full-2"].samples,1);
  assert.equal(pairOutcome(result.predictions["full-2"].probabilities,odds,7).labels.length,2);
  assert.equal(result.predictions["joint-2"].samples,1);
});

test("开发段优胜者不会因后段成绩反转而被重新选择", () => {
  const a={probabilities:[.01,.01,.45,.45,.02,.02,.02,.02],samples:10,effectiveSamples:10};
  const b={probabilities:[.45,.45,.01,.01,.02,.02,.02,.02],samples:10,effectiveSamples:10};
  const development={period:"development",actualIndex:2,odds,predictions:{baseline:a,a,b}};
  const tail={...development,period:"observedTail",actualIndex:0};
  assert.equal(selectOnDevelopment([development,...Array(100).fill(tail)],[{id:"a"},{id:"b"}])[0].id,"a");
});

test("每日同文件重复行号按批次回放，同批赛果不泄漏且不拆分验证段", () => {
  const legacy=Array.from({length:5},(_,i)=>({...row(i+1),historyId:i+1,historyBatchId:0}));
  const daily=Array.from({length:5},(_,i)=>({...row(2,i%2?"3":"2","history.xlsx"),historyId:i+6,historyBatchId:i<3?1:2}));
  const rows=[...legacy,...daily], run=runGoalPairResearch(rows,{warmup:2});
  const batch1=run.cases.filter(x=>x.historyBatchId===1);
  assert.equal(batch1.length,3);
  assert.ok(batch1.every(x=>x.trainingRows===5 && x.period==="validation"));
  assert.ok(run.cases.filter(x=>x.historyBatchId===2).every(x=>x.trainingRows===8 && x.period==="observedTail"));
  assert.equal(run.split.validationStart,5);
  const changed=runGoalPairResearch(rows.map(x=>x.historyBatchId===1?{...x,goals:"7+"}:x),{warmup:2});
  assert.deepEqual(changed.cases.filter(x=>x.historyBatchId===1).map(x=>x.predictions),batch1.map(x=>x.predictions));
  assert.deepEqual(runGoalPairResearch([...rows].reverse(),{warmup:2}),run);
  assert.throws(()=>runGoalPairResearch([...rows,rows[6]],{warmup:2}),/重复/);
  assert.throws(()=>runGoalPairResearch([{...daily[0],historyId:undefined}],{warmup:2}),/数据库ID/);
});

test("融合保留归一化概率且缺基线时不回退伪造，包含新增35%和45%权重", () => {
  const run=runGoalPairResearch([row(1),row(2),{...row(3),odds:[99,...odds.slice(1)]}],{warmup:1});
  const p=run.cases[0].predictions;
  assert.deepEqual(Object.keys(p),["baseline","market","blend-0.25","blend-0.35","blend-0.45","blend-0.5","blend-0.75"]);
  for (const weight of [.25,.35,.45,.5,.75]) {
    const id=`blend-${weight}`;
    assert.deepEqual(p[id].probabilities,p.baseline.probabilities.map((v,i)=>weight*v+(1-weight)*p.market.probabilities[i]));
    assert.ok(Math.abs(p[id].probabilities.reduce((a,b)=>a+b,0)-1)<1e-12);
    assert.equal(run.cases[1].predictions[id],null);
  }
  assert.throws(()=>runGoalPairResearch([row(1)],{policies:[{id:"bad",kind:"blend",modelWeight:1.1}]}),/无效/);
});

test("覆盖率校准只拟合开发段，不改变选择和命中，不足样本不启用", () => {
  const p={probabilities:[.05,.05,.3,.3,.1,.05,.05,.1],samples:10,effectiveSamples:10};
  const development=Array.from({length:100},(_,i)=>({period:"development",actualIndex:i%2?2:4,odds,predictions:{baseline:p}}));
  const tail=development.map(x=>({...x,period:"observedTail"}));
  const fit=fitCoverageCalibration([...development,...tail],"baseline");
  assert.equal(fit.trainingRows,100);
  assert.ok(fit.offset<0);
  assert.deepEqual(fitCoverageCalibration([...development,...tail.map(x=>({...x,actualIndex:7}))],"baseline"),fit);
  const before=structuredClone(tail), result=summarizeCoverageCalibration(tail,"baseline",fit);
  assert.equal(result.hits,50);
  assert.equal(result.selectionsChanged,0);
  assert.ok(result.brierAfter<result.brierBefore);
  assert.ok(Math.abs(result.meanAfter-.5)<1e-12);
  assert.deepEqual(tail,before);
  assert.equal(fitCoverageCalibration(development.slice(0,10),"baseline").available,false);
  assert.equal(summarizeCoverageCalibration([],"baseline",fit).available,false);
});
