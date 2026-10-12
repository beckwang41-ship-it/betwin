import { createHash } from "node:crypto";
import { CONTEXT_ARMS,prepareContextRows,summarizeContextCases } from "./context-experiment.mjs";
import { PILOT_PROTOCOL,pilotFeatures } from "./context-pilot.mjs";
import { blockBootstrapFixtureMean } from "./significance.mjs";

export const CONTEXT_HISTORY_PROTOCOL=Object.freeze({version:"context-history-walk-forward-v1",
  modelVersion:PILOT_PROTOCOL.version,minimumTraining:45,minimumH2hTraining:35,
  epochs:PILOT_PROTOCOL.epochs,learningRate:PILOT_PROTOCOL.learningRate,l2:PILOT_PROTOCOL.l2,
  bootstrapIterations:2000,bootstrapBlockSize:10,productionChanged:false});
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const top=p=>p.map((v,i)=>({v,i})).sort((a,b)=>b.v-a.v||a.i-b.i).map(x=>x.i);
const featureVector=(row,arm)=>{const f=pilotFeatures(row.features,row.market);
  return arm==="B"?Object.values(f.state):arm==="C"?Object.values(f.history):[...Object.values(f.state),...Object.values(f.history)];};

function probabilities(row,arm,weights){
  if(arm==="C"&&!row.features.quality.hasH2h)return [...row.p];
  const x=featureVector(row,arm),z=row.p.map((p,k)=>Math.log(Math.max(1e-8,p))+weights[k].reduce((s,w,j)=>s+w*x[j],0));
  const max=Math.max(...z),ex=z.map(v=>Math.exp(v-max)),sum=ex.reduce((a,b)=>a+b,0);
  return ex.map(v=>v/sum);
}
function fit(rows,arm){
  const weights=rows[0].p.map(()=>featureVector(rows[0],arm).map(()=>0));
  for(let epoch=0;epoch<CONTEXT_HISTORY_PROTOCOL.epochs;epoch++){
    const gradient=weights.map(ws=>ws.map(w=>w*CONTEXT_HISTORY_PROTOCOL.l2));
    for(const row of rows){
      if(arm==="C"&&!row.features.quality.hasH2h)continue;
      const x=featureVector(row,arm),p=probabilities(row,arm,weights);
      for(let k=0;k<p.length;k++)for(let j=0;j<x.length;j++)gradient[k][j]+=(p[k]-Number(row.y===k))*x[j]/rows.length;
    }
    for(let k=0;k<weights.length;k++)for(let j=0;j<weights[k].length;j++)weights[k][j]-=CONTEXT_HISTORY_PROTOCOL.learningRate*gradient[k][j];
  }
  return weights;
}
const brier=(p,y)=>p.reduce((s,v,i)=>s+(v-Number(i===y))**2,0);
function paired(cases,market,arm){
  const values={accuracy:[],logLoss:[],brier:[],...(market==="goals"?{pairHit:[]}:{})};
  for(const c of cases){const a=c.predictions.A,p=c.predictions[arm],baseTop=top(a),candidateTop=top(p),common={fixtureId:c.matchId,sourceFile:"prediction-ledger",order:c.capture};
    values.accuracy.push({...common,value:Number(candidateTop[0]===c.y)-Number(baseTop[0]===c.y)});
    values.logLoss.push({...common,value:Math.log(Math.max(1e-8,p[c.y]))-Math.log(Math.max(1e-8,a[c.y]))});
    values.brier.push({...common,value:brier(a,c.y)-brier(p,c.y)});
    if(market==="goals")values.pairHit.push({...common,value:Number(candidateTop.slice(0,2).includes(c.y))-Number(baseTop.slice(0,2).includes(c.y))});
  }
  return Object.fromEntries(Object.entries(values).map(([metric,items])=>[metric,blockBootstrapFixtureMean(items,{iterations:CONTEXT_HISTORY_PROTOCOL.bootstrapIterations,blockSize:CONTEXT_HISTORY_PROTOCOL.bootstrapBlockSize})]));
}

export function evaluateContextHistory(records){
  const prepared=prepareContextRows(records),comparisons=[];
  for(const [groupKey,all] of prepared.groups){
    const settled=all.filter(r=>r.status==="settled").sort((a,b)=>a.capture-b.capture||a.id-b.id),cache=new Map(),cases=[];
    for(const target of settled){
      const training=settled.filter(r=>r.capture<target.capture&&r.settled<target.capture&&r.matchId!==target.matchId);
      const h2hTraining=training.filter(r=>r.features.quality.hasH2h).length;
      if(training.length<CONTEXT_HISTORY_PROTOCOL.minimumTraining||h2hTraining<CONTEXT_HISTORY_PROTOCOL.minimumH2hTraining)continue;
      const fitId=hash(training.map(r=>[r.id,r.contextHash,r.p,r.y]));
      if(!cache.has(fitId))cache.set(fitId,{fitId,training:training.length,h2hTraining,
        latestSettlement:new Date(Math.max(...training.map(r=>r.settled))).toISOString(),
        coefficients:Object.fromEntries(["B","C","D"].map(arm=>[arm,fit(training,arm)]))});
      const model=cache.get(fitId),predictions={A:[...target.p]};
      for(const arm of ["B","C","D"]){predictions[arm]=arm==="D"&&!target.features.quality.hasH2h?[...predictions.B]:probabilities(target,arm,model.coefficients[arm]);}
      cases.push({matchId:target.matchId,home:target.home,away:target.away,market:target.market,capture:target.capture,
        capturedAt:target.baselineCapturedAt,settledAt:new Date(target.settled).toISOString(),training:model.training,
        h2hTraining:model.h2hTraining,hasH2h:target.features.quality.hasH2h,y:target.y,predictions,fitId});
    }
    if(!settled.length)continue;
    const market=settled[0].market,metrics=summarizeContextCases(cases,market);
    comparisons.push({groupKey,market,algorithmVersion:settled[0].algorithmVersion,availableSettled:settled.length,
      evaluated:cases.length,firstEvaluatedAt:cases[0]?.capturedAt||null,lastEvaluatedAt:cases.at(-1)?.capturedAt||null,
      fits:[...cache.values()].map(({coefficients,...meta})=>meta),metrics,
      pairedVsA:Object.fromEntries(["B","C","D"].map(arm=>[arm,paired(cases,market,arm)])),cases});
  }
  return {version:CONTEXT_HISTORY_PROTOCOL.version,protocol:CONTEXT_HISTORY_PROTOCOL,arms:CONTEXT_ARMS,
    generatedAt:new Date().toISOString(),counts:prepared.counts,issues:prepared.issues,comparisons,productionChanged:false,
    limitations:["这是逐批时间回放：每场候选只使用其预测时间前已经结算的比赛训练。",
      "近期状态和交锋来自当时账本冻结明细，不使用今天文件回填过去；起始训练门槛固定为45场、含交锋35场。",
      "A/B/C/D规则在本次评估前已存在，但候选并非每批当时实际运行，仍属于回放证据，不等同于真正前瞻验证。",
      "正差表示候选优于A；命中率、LogLoss、Brier和进球双选均用相同比赛成对比较，Bootstrap按时间块重采样。",
      "结果仅用于判断状态信息是否有增量，不自动修改正式概率或串关。"]};
}
