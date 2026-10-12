import test from "node:test";
import assert from "node:assert/strict";
import { predictFormPoisson,trialSelection } from "../lib/form-poisson-trial.mjs";
const form=(gf=2,ga=1)=>({home:{recent:{matches:5,goalsForPerGame:gf,goalsAgainstPerGame:ga}},away:{recent:{matches:5,goalsForPerGame:gf,goalsAgainstPerGame:ga}}});
test("固定近期泊松实验保持概率归一、主客对称和-1让球关系",()=>{
 const r=predictFormPoisson(form(),-1);
 assert.equal(r.meanHome,1.5);assert.equal(r.meanAway,1.5);
 for(const market of ["spf","hhad","goals"])assert.ok(Math.abs(r[market].probabilities.reduce((a,b)=>a+b,0)-1)<1e-12);
 assert.ok(Math.abs(r.spf.probabilities[0]-r.spf.probabilities[2])<1e-12);
 assert.ok(Math.abs(r.hhad.probabilities[0]+r.hhad.probabilities[1]-r.spf.probabilities[0])<1e-12);
 assert.deepEqual(r.goals.pair.indices,[2,3]);
});
test("缺少战绩不填预测，无让球不造盘口，零均值有效",()=>{
 assert.equal(predictFormPoisson(null,-1).available,false);
 const sparse=form();sparse.home.recent.matches=2;assert.equal(predictFormPoisson(sparse,0).available,false);
 assert.equal(predictFormPoisson(form(),null).hhad,null);
 assert.deepEqual(predictFormPoisson(form(0,0),0).spf.probabilities,[0,1,0]);
 assert.equal(trialSelection([0.6,0.6,0.1],"spf"),null);
});
