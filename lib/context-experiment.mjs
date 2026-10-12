import { createHash } from "node:crypto";
import { extractContextFeatures, CONTEXT_FEATURE_VERSION, CONTEXT_FEATURE_RULES } from "./context-features.mjs";

export const CONTEXT_PROTOCOL = Object.freeze({version:"context-ablation-v1",featureVersion:CONTEXT_FEATURE_VERSION,
  minimumTraining:200,minimumH2hTraining:50,minimumEvaluation:100,
  epochs:100,learningRate:0.1,l2:0.1,refitEvery:20,featureRules:CONTEXT_FEATURE_RULES});
export const CONTEXT_ARMS = Object.freeze({A:"原赔率模型",B:"赔率＋近期状态",C:"赔率＋历史交锋",D:"赔率＋近期状态＋历史交锋"});
const LABELS={spf:["胜","平","负"],hhad:["让胜","让平","让负"],goals:["0","1","2","3","4","5","6","7+"]};
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const order=p=>p.map((v,i)=>({v,i})).sort((a,b)=>b.v-a.v||a.i-b.i).map(r=>r.i);
const vector=(row,arm)=>arm==="B"?row.features.stateVector:arm==="C"?row.features.historyVector:[...row.features.stateVector,...row.features.historyVector];

function probabilities(row,arm,weights) {
  // 无交锋时C严格退回基线；缺失不会被当作0胜0平0负的观察。
  if(arm==="C"&&!row.features.quality.hasH2h)return [...row.p];
  const x=vector(row,arm);
  const z=row.p.map((p,k)=>Math.log(Math.max(1e-8,p))+weights[k].reduce((s,w,j)=>s+w*x[j],0));
  const max=Math.max(...z),exp=z.map(v=>Math.exp(v-max)),sum=exp.reduce((a,b)=>a+b,0);
  return exp.map(v=>v/sum);
}

// 固定训练规则，三候选共享训练比赛；不同玩法分别拟合，不沿用进球泊松的胜负推导。
function fit(training,arm) {
  const width=vector(training[0],arm).length,classes=training[0].p.length;
  const weights=Array.from({length:classes},()=>Array(width).fill(0));
  for(let epoch=0;epoch<CONTEXT_PROTOCOL.epochs;epoch++) {
    const gradient=weights.map(ws=>ws.map(w=>CONTEXT_PROTOCOL.l2*w));
    for(const row of training){
      if(arm==="C"&&!row.features.quality.hasH2h)continue;
      const x=vector(row,arm),p=probabilities(row,arm,weights);
      for(let k=0;k<classes;k++)for(let j=0;j<width;j++)gradient[k][j]+=(p[k]-Number(row.y===k))*x[j]/training.length;
    }
    for(let k=0;k<classes;k++)for(let j=0;j<width;j++)weights[k][j]-=CONTEXT_PROTOCOL.learningRate*gradient[k][j];
  }
  return weights;
}

export function summarizeContextCases(cases,market) {
  if(!cases.length)return Object.fromEntries(Object.keys(CONTEXT_ARMS).map(a=>[a,null]));
  return Object.fromEntries(Object.keys(CONTEXT_ARMS).map(arm=>{
    const sum={samples:cases.length,hits:0,logLoss:0,brier:0,...(market==="goals"?{pairHits:0,pairCoverage:0}:{})};
    for(const c of cases){const p=c.predictions[arm],indices=order(p);sum.hits+=Number(indices[0]===c.y);
      sum.logLoss-=Math.log(Math.max(1e-8,p[c.y]));sum.brier+=p.reduce((s,v,i)=>s+(v-Number(i===c.y))**2,0);
      if(market==="goals"){sum.pairHits+=Number(indices.slice(0,2).includes(c.y));sum.pairCoverage+=p[indices[0]]+p[indices[1]];}}
    sum.accuracy=sum.hits/sum.samples;sum.logLoss/=sum.samples;sum.brier/=sum.samples;
    if(market==="goals"){sum.pairHitRate=sum.pairHits/sum.samples;sum.pairCoverage/=sum.samples;}
    return [arm,sum];
  }));
}

function select(p,market){const indices=order(p);return {probabilities:p,single:LABELS[market][indices[0]],singleIndex:indices[0],
  ...(market==="goals"?{pair:indices.slice(0,2).map(i=>LABELS.goals[i]),pairIndices:indices.slice(0,2),pairCoverage:p[indices[0]]+p[indices[1]]}:{})};}

export function prepareContextRows(records) {
  const counts={input:records.length,outOfScope:0,missingContext:0,invalid:0,duplicates:0,settled:0,pending:0,withH2h:0};
  const issues=[],groups=new Map(),seen=new Set();
  for(const r of [...records].sort((a,b)=>Date.parse(a.captured_at)-Date.parse(b.captured_at)||a.id-b.id)){
    if(!LABELS[r.market]||!r.valid){counts.outOfScope++;continue;}
    let settings,p;
    try{settings=JSON.parse(r.settings_json||"{}");p=JSON.parse(r.probabilities_json||"null");}
    catch(error){counts.invalid++;issues.push({id:r.id,reason:`快照JSON损坏：${error.message}`});continue;}
    if(settings.sameLeague){counts.outOfScope++;continue;}
    const capture=Date.parse(r.captured_at),imported=Date.parse(settings.recentForm?.importedAt),settled=Date.parse(r.settled_at);
    if(!settings.recentForm){counts.missingContext++;continue;}
    const features=extractContextFeatures(settings.recentForm,{league:r.league,market:r.market,handicap:r.handicap});
    if(!features.available){counts.missingContext++;issues.push({id:r.id,matchId:r.match_id,reason:features.reason});continue;}
    if(!r.algorithm_version||!Number.isFinite(capture)||!Number.isFinite(imported)||imported>capture ||
      !Array.isArray(p)||p.length!==LABELS[r.market].length||p.some(v=>!Number.isFinite(v)||v<0)||
      Math.abs(p.reduce((a,b)=>a+b,0)-1)>1e-6 || !["settled","pending"].includes(r.status)){
      counts.invalid++;issues.push({id:r.id,reason:"概率、模型版本、状态或导入时间无效"});continue;
    }
    const y=r.market==="hhad"?["胜","平","负"].indexOf(r.actual_result):LABELS[r.market].indexOf(String(r.actual_result));
    if(r.status==="settled" && (y<0||!Number.isFinite(settled)||settled<capture)){
      counts.invalid++;issues.push({id:r.id,reason:"结算标签或时间无效"});continue;
    }
    const groupKey=`${r.market}|${r.algorithm_version}`,unique=`${groupKey}|${r.match_id}`;
    if(seen.has(unique)){counts.duplicates++;continue;}seen.add(unique);
    const row={id:r.id,matchId:String(r.match_id),market:r.market,algorithmVersion:r.algorithm_version,
      home:r.home_team,away:r.away_team,league:r.league,handicap:r.handicap,status:r.status,capture,settled,
      p,y:r.status==="settled"?y:null,features,contextHash:hash(settings.recentForm),baselineCapturedAt:r.captured_at};
    if(!groups.has(groupKey))groups.set(groupKey,[]);groups.get(groupKey).push(row);
    counts[r.status]++;counts.withH2h+=Number(features.quality.hasH2h);
  }
  return {groups,counts,issues};
}

function readiness(training){const h2h=training.filter(r=>r.features.quality.hasH2h).length;
  return {training:training.length,h2hTraining:h2h,ready:training.length>=CONTEXT_PROTOCOL.minimumTraining&&h2h>=CONTEXT_PROTOCOL.minimumH2hTraining,
    neededTraining:Math.max(0,CONTEXT_PROTOCOL.minimumTraining-training.length),neededH2h:Math.max(0,CONTEXT_PROTOCOL.minimumH2hTraining-h2h)};}

export function compareContext(records,{generatedAt=new Date().toISOString(),activationAt=generatedAt,activeMatchIds=[]}={}) {
  const now=Date.parse(generatedAt),activation=Date.parse(activationAt);
  if(!Number.isFinite(now)||!Number.isFinite(activation))throw new Error("实验时间无效");
  const {groups,counts,issues}=prepareContextRows(records),comparisons=[],pendingPredictions=[];
  const active=new Set(activeMatchIds.map(String));
  for(const [groupKey,all] of groups){
    const settledRows=all.filter(r=>r.status==="settled"&&r.settled<=now),cases=[],fits=[];
    let currentFit=null;
    const getFit=training=>{
      const id=hash(training.map(r=>[r.id,r.contextHash,r.p,r.y]));
      const model={id,training:training.length,trainingIds:training.map(r=>r.matchId),
        latestSettlement:new Date(Math.max(...training.map(r=>r.settled))).toISOString(),
        coefficients:Object.fromEntries(["B","C","D"].map(arm=>[arm,fit(training,arm)]))};
      fits.push(model);return model;
    };
    for(const target of settledRows){
      const training=settledRows.filter(r=>r.capture<target.capture&&r.settled<target.capture&&r.matchId!==target.matchId);
      if(!readiness(training).ready)continue;
      if(!currentFit||training.length-currentFit.training>=CONTEXT_PROTOCOL.refitEvery)currentFit=getFit(training);
      const predictions={A:target.p,...Object.fromEntries(["B","C","D"].map(arm=>[arm,probabilities(target,arm,currentFit.coefficients[arm])]))};
      cases.push({matchId:target.matchId,capturedAt:target.baselineCapturedAt,settledAt:new Date(target.settled).toISOString(),
        y:target.y,contextHash:target.contextHash,fitId:currentFit.id,predictions,hasH2h:target.features.quality.hasH2h,
        cohort:target.capture<activation?"retrospective-diagnostic":"post-activation-replay"});
    }
    const first=all[0],ready=readiness(settledRows);
    const before=cases.filter(c=>c.cohort==="retrospective-diagnostic"),after=cases.filter(c=>c.cohort!=="retrospective-diagnostic");
    comparisons.push({groupKey,market:first.market,algorithmVersion:first.algorithmVersion,...ready,
      featureNames:{state:Object.keys(first.features.state),history:Object.keys(first.features.history)},
      baselineObserved:summarizeContextCases(settledRows.map(r=>({y:r.y,predictions:{A:r.p,B:r.p,C:r.p,D:r.p}})),first.market).A,
      evaluated:cases.length,metrics:summarizeContextCases(cases,first.market),
      retrospectiveMetrics:summarizeContextCases(before,first.market),postActivationReplayMetrics:summarizeContextCases(after,first.market),
      hasH2hMetrics:summarizeContextCases(cases.filter(c=>c.hasH2h),first.market),
      noH2hMetrics:summarizeContextCases(cases.filter(c=>!c.hasH2h),first.market),
      status:cases.length<CONTEXT_PROTOCOL.minimumEvaluation?"insufficient-data":"research-only",cases,fits});
    const pending=all.filter(r=>r.status==="pending"&&active.has(r.matchId)&&r.capture<=now);
    const futureFit=pending.length&&ready.ready?getFit(settledRows):null;
    for(const r of pending){
      const predictions={A:select(r.p,r.market),...Object.fromEntries(["B","C","D"].map(arm=>[arm,futureFit?select(probabilities(r,arm,futureFit.coefficients[arm]),r.market):null]))};
      pendingPredictions.push({matchId:r.matchId,home:r.home,away:r.away,market:r.market,algorithmVersion:r.algorithmVersion,
        forecastAt:generatedAt,baselineCapturedAt:r.baselineCapturedAt,handicap:r.handicap,contextHash:r.contextHash,
        features:r.features,fitId:futureFit?.id || null,readiness:ready,predictions,
        status:futureFit?"experimental-not-production":"awaiting-training",actualResult:null});
    }
  }
  return {version:CONTEXT_PROTOCOL.version,protocol:CONTEXT_PROTOCOL,arms:CONTEXT_ARMS,generatedAt,activationAt,
    counts,issues,comparisons,pendingPredictions,productionChanged:false,
    limitations:["A为原概率；B、C、D是在原概率上学习的修正，不是原进失球泊松实验。",
      "同一玩法、同一基线算法版本、同一训练池及评估比赛比较四组；无交锋时C退回A，D保留状态特征。",
      "仅从随预测冻结的明细提取特征，训练赛果必须在目标预测时间前已结算；不以今天近况回填过去。",
      "10场汇总不混入5场明细；按比赛类型分列并限制极端值影响，固定规则未验证为最优。",
      "缺少对手实力评分、球员阵容及精确开赛时间；不能声称已校正对手强弱或完成严格赛前认证。",
      "上线前历史回放属于诊断，不是未见样本验证；需优先看启动后提前冻结的真实新预测。",
      "200场训练与100场评估只是研究门槛，不是自动通过标准；不自动选最佳模型或修改正式概率。"]};
}

// 使用旧报告中的概率结算，按最早有效冻结记录去重；不重算候选，不认领启动前已知赛果。
export function evaluateFrozenContext(reports,records,{fingerprint,activationAt,knownSettledMatchIds=[]}) {
  const {groups}=prepareContextRows(records),settled=new Map();
  for(const [key,rows] of groups)for(const r of rows)if(r.status==="settled")settled.set(`${key}|${r.matchId}`,r);
  const frozenGroups=new Map(),seen=new Set(),known=new Set(knownSettledMatchIds.map(String));
  const activated=Date.parse(activationAt);
  if(!Number.isFinite(activated))throw new Error("冻结对照启动时间无效");
  const predictions=reports.filter(r=>r.protocolFingerprint===fingerprint).flatMap(r=>(r.pendingPredictions||[]).map(p=>({...p,sourceReport:r.sourceReport})))
    .sort((a,b)=>Date.parse(a.forecastAt)-Date.parse(b.forecastAt));
  for(const p of predictions){
    if(p.status!=="experimental-not-production"||!Object.keys(CONTEXT_ARMS).every(a=>p.predictions[a]))continue;
    const groupKey=`${p.market}|${p.algorithmVersion}`,key=`${groupKey}|${p.matchId}`,result=settled.get(key),forecast=Date.parse(p.forecastAt);
    if(!result||seen.has(key)||known.has(String(p.matchId))||!Number.isFinite(forecast)||forecast<activated||forecast>=result.settled)continue;
    const probabilities=Object.fromEntries(Object.keys(CONTEXT_ARMS).map(a=>[a,p.predictions[a].probabilities]));
    for(const ps of Object.values(probabilities))if(!Array.isArray(ps)||ps.length!==LABELS[p.market].length||ps.some(v=>!Number.isFinite(v)||v<0)||Math.abs(ps.reduce((a,b)=>a+b,0)-1)>1e-6)throw new Error(`冻结报告概率损坏：${p.sourceReport} ${p.matchId}`);
    seen.add(key);if(!frozenGroups.has(groupKey))frozenGroups.set(groupKey,[]);
    frozenGroups.get(groupKey).push({matchId:p.matchId,sourceReport:p.sourceReport,forecastAt:p.forecastAt,y:result.y,predictions:probabilities});
  }
  return [...frozenGroups].map(([key,cases])=>({groupKey:key,market:key.split("|")[0],cases,
    metrics:summarizeContextCases(cases,key.split("|")[0]),
    status:cases.length<CONTEXT_PROTOCOL.minimumEvaluation?"insufficient-data":"research-only"}));
}
