import { createHash } from "node:crypto";
import { prepareContextRows, CONTEXT_ARMS } from "./context-experiment.mjs";

// 独立的小样本探索协议，不降低旧实验门槛，不输出训练集成绩作为验证。
export const PILOT_PROTOCOL = Object.freeze({version:"context-pilot-v4-stable-source-freeze",
  minimumTraining:20,minimumH2hTraining:10,epochs:100,learningRate:0.1,l2:0.5,
  missingH2h:"C=A,D=B",selection:"top-probability; ties by label index",
  productionChanged:false});
export const PILOT_LABELS={spf:["胜","平","负"],hhad:["让胜","让平","让负"],goals:["0","1","2","3","4","5","6","7+"]};
export const pilotHash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function pilotFeatures(features,market) {
  if(!features?.available)throw new Error("缺少有效状态明细");
  const s=features.state,h=features.history;
  const delta=key=>s[`home.${key}`]-s[`away.${key}`];
  const avg=key=>(s[`home.${key}`]+s[`away.${key}`])/2;
  const subset=key=>s[`home.${key}.points`]*s[`home.${key}.sampleFraction`]-s[`away.${key}.points`]*s[`away.${key}.sampleFraction`];
  const state={pointsDifference:delta("points"),drawRate:avg("drawRate"),
    attackDifference:delta("goalsFor"),defenceDifference:delta("goalsAgainst"),
    totalGoals:(avg("goalsFor")+avg("goalsAgainst"))/2,
    pointsTrendDifference:delta("pointsTrend"),unbeatenDifference:delta("unbeatenRun"),
    venuePointsDifference:subset("venue"),competitionPointsDifference:subset("sameCompetition"),
    cupFraction:avg("cup.sampleFraction"),friendlyFraction:avg("friendly.sampleFraction"),
    extremeScores:avg("extremeScore")};
  // 少量或久远交锋整体收缩，避免一场交锋与十场交锋同等影响。
  const mass=h["h2h.recencyMass"];
  const history={mass,winLoss:mass*(h["h2h.winRate"]-h["h2h.lossRate"]),
    draw:mass*h["h2h.drawRate"],margin:mass*h["h2h.margin"],
    totalGoals:mass*(h["h2h.goalsFor"]+h["h2h.goalsAgainst"])/2,
    venueWinLoss:mass*h["h2h.homeVenueFraction"]*(2*h["h2h.homeVenueWin"]+h["h2h.homeVenueDraw"]-1)};
  if(market==="hhad"){
    state.handicapWin=avg("currentHandicap.win");state.handicapDraw=avg("currentHandicap.draw");
    history.handicapWin=mass*h["h2h.currentHandicap.win"];history.handicapDraw=mass*h["h2h.currentHandicap.draw"];
  }
  if([...Object.values(state),...Object.values(history)].some(v=>!Number.isFinite(v)))throw new Error("小样本特征字段无效");
  return {state,history};
}
const vector=(row,arm)=>{
  const f=pilotFeatures(row.features,row.market);
  return arm==="B"?Object.values(f.state):arm==="C"?Object.values(f.history):[...Object.values(f.state),...Object.values(f.history)];
};
function adjust(row,arm,weights) {
  if(arm==="C"&&!row.features.quality.hasH2h)return [...row.p];
  const x=vector(row,arm),z=row.p.map((p,k)=>Math.log(Math.max(1e-8,p))+weights[k].reduce((v,w,j)=>v+w*x[j],0));
  const max=Math.max(...z),ex=z.map(v=>Math.exp(v-max)),total=ex.reduce((a,b)=>a+b,0);
  return ex.map(v=>v/total);
}
function fit(rows,arm){
  const weights=rows[0].p.map(()=>vector(rows[0],arm).map(()=>0));
  for(let epoch=0;epoch<PILOT_PROTOCOL.epochs;epoch++){
    const gradient=weights.map(ws=>ws.map(w=>w*PILOT_PROTOCOL.l2));
    for(const row of rows){
      if(arm==="C"&&!row.features.quality.hasH2h)continue;
      const x=vector(row,arm),p=adjust(row,arm,weights);
      for(let k=0;k<p.length;k++)for(let j=0;j<x.length;j++)gradient[k][j]+=(p[k]-Number(row.y===k))*x[j]/rows.length;
    }
    for(let k=0;k<weights.length;k++)for(let j=0;j<weights[k].length;j++)weights[k][j]-=PILOT_PROTOCOL.learningRate*gradient[k][j];
  }
  return weights;
}
export function pilotSelect(p,market){
  if(!PILOT_LABELS[market]||!Array.isArray(p)||p.length!==PILOT_LABELS[market].length||
    p.some(v=>!Number.isFinite(v)||v<0)||Math.abs(p.reduce((a,b)=>a+b,0)-1)>1e-6)throw new Error("基线概率无效");
  const indices=p.map((_,i)=>i).sort((a,b)=>p[b]-p[a]||a-b),labels=PILOT_LABELS[market];
  return {probabilities:[...p],single:labels[indices[0]],singleIndex:indices[0],
    tiedTop:indices.filter(i=>Math.abs(p[i]-p[indices[0]])<1e-12).map(i=>labels[i]),
    ...(market==="goals"?{pair:indices.slice(0,2).map(i=>labels[i]),pairIndices:indices.slice(0,2),pairCoverage:p[indices[0]]+p[indices[1]]}:{})};
}
export function predictContextPilot(records,targets,{generatedAt=new Date().toISOString()}={}){
  const now=Date.parse(generatedAt);if(!Number.isFinite(now))throw new Error("预测时间无效");
  const excluded=new Set(targets.map(t=>String(t.matchId))),{groups,counts,issues}=prepareContextRows(records);
  const models=[],pendingPredictions=[],cache=new Map();
  for(const target of targets){
    pilotSelect(target.p,target.market);
    if(!target.algorithmVersion||!Number.isFinite(target.capture)||target.capture>now||!target.features?.available)throw new Error("目标版本、时间或战绩无效");
    const key=`${target.market}|${target.algorithmVersion}`;
    if(!cache.has(key)){
      const training=(groups.get(key)||[]).filter(r=>r.status==="settled"&&r.settled<now&&!excluded.has(r.matchId));
      const h2hTraining=training.filter(r=>r.features.quality.hasH2h).length;
      if(training.length<PILOT_PROTOCOL.minimumTraining||h2hTraining<PILOT_PROTOCOL.minimumH2hTraining)throw new Error(`${key}训练不足：${training.length}场，交锋${h2hTraining}场`);
      const coefficients=Object.fromEntries(["B","C","D"].map(a=>[a,fit(training,a)]));
      const model={groupKey:key,id:pilotHash(training),training:training.length,h2hTraining,
        featureNames:pilotFeatures(training[0].features,target.market),trainingRows:training,coefficients};
      cache.set(key,model);models.push(model);
    }
    const model=cache.get(key),ps={A:target.p};
    for(const a of ["B","C","D"])ps[a]=a==="D"&&!target.features.quality.hasH2h?[...ps.B]:adjust(target,a,model.coefficients[a]);
    pendingPredictions.push({...target,forecastAt:generatedAt,fitId:model.id,status:"experimental-not-production",actualResult:null,
      predictions:Object.fromEntries(Object.keys(CONTEXT_ARMS).map(a=>[a,pilotSelect(ps[a],target.market)]))});
  }
  return {version:PILOT_PROTOCOL.version,protocol:PILOT_PROTOCOL,arms:CONTEXT_ARMS,generatedAt,
    counts,issues,models,pendingPredictions,productionChanged:false};
}
