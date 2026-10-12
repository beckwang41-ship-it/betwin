import { GOAL_LABELS, normalizeOdds, selectTopGoalPair } from "./predictor.mjs";
import { selectProductionGoalSimilarity, predictProductionGoals } from "./goal-production.mjs";
import { historyTimelines, batchBoundary, HISTORY_TIMELINE_VERSION } from "./history-timeline.mjs";

export const GOAL_PAIR_RESEARCH_VERSION = "goal-pair-database-blend-v3-expanded-grid";
export const GOAL_PAIR_RESEARCH_POLICIES = [.25, .35, .45, .5, .75].map(modelWeight => ({
  id: `blend-${modelWeight}`, kind: "blend", modelWeight,
}));
export const GOAL_PAIR_DISTANCE_POLICIES = [100, 300, 800].flatMap(k => [
  { id: `full-${k}`, kind: "full", k }, { id: `joint-${k}`, kind: "joint", k },
]);
const validOdds = (odds, size) => Array.isArray(odds) && odds.length === size && odds.every(x=>Number.isFinite(x) && x > 1);
const hellinger = (a,b) => Math.sqrt(a.reduce((s,x,i)=>s+(Math.sqrt(x)-Math.sqrt(b[i]))**2,0)/2);
export function attachGoalContexts(goals, verified) {
  const links=new Map();
  for (const row of verified) {
    if (!Number.isInteger(row.goalHistoryId) || row.goalHistoryId < 1) continue;
    const key=row.goalHistoryId;
    if (!links.has(key)) links.set(key,[]);
    links.get(key).push(row);
  }
  let joined=0, ambiguous=0, inconsistent=0;
  const rows=goals.map(row=>{
    const matches=links.get(row.historyId) || [];
    const match=matches.length===1 ? matches[0] : null;
    if (matches.length>1) ambiguous++;
    // 只复用数据库外键关联；每日文件行号可以重复，不能用于推测身份。
    const compatible=match && validOdds(match.goalMarket?.odds,8) &&
      row.odds.every((x,i)=>x===match.goalMarket.odds[i]);
    if (match && !compatible) inconsistent++;
    if (compatible) joined++;
    return {...row,spf:compatible?{odds:match.spf.odds}:null,
      hhad:compatible?{odds:match.hhad.odds,handicap:match.hhad.handicap}:null};
  });
  return {rows,joined,ambiguous,inconsistent};
}
function features(row) {
  const joint = validOdds(row.spf?.odds,3) && validOdds(row.hhad?.odds,3) && Number.isFinite(row.hhad?.handicap);
  return { ...row, gp: normalizeOdds(row.odds),
    sp: joint ? normalizeOdds(row.spf.odds) : null, hp: joint ? normalizeOdds(row.hhad.odds) : null };
}

export function pairOutcome(probabilities, odds, actualIndex) {
  const pair = selectTopGoalPair(probabilities, odds);
  const hit = pair.indices.includes(actualIndex);
  return { labels: pair.labels, indices: pair.indices, predictedCoverage: pair.probability,
    hit, stakeUnits: 2, profitUnits: (hit ? odds[actualIndex] : 0) - 2 };
}

function prediction(target, samples, bandwidth) {
  if (!samples.length) return null;
  const resolved = { similar: samples, weighting: { bandwidth, method: "research-hellinger-knn" } };
  const p = predictProductionGoals(target.odds,resolved,{blendOptions:{empiricalOnly:true,requireSamples:true}});
  return { probabilities:p.final, samples:p.stats.total, effectiveSamples:p.weighting.effectiveSamples };
}

export function runGoalPairResearch(rows, {warmup = 1000, policies = GOAL_PAIR_RESEARCH_POLICIES, onProgress = ()=>{}} = {}) {
  if (!Number.isInteger(warmup) || warmup < 1) throw new Error("预热数量必须为正整数");
  const identities = new Set(), legacyPositions = new Set(), cases = [], sources = [];
  for (const policy of policies) {
    const valid = policy.kind === "blend"
      ? Number.isFinite(policy.modelWeight) && policy.modelWeight > 0 && policy.modelWeight < 1
      : ["full", "joint"].includes(policy.kind) && Number.isInteger(policy.k) && policy.k > 0;
    if (!valid || !policy.id || ["baseline", "market"].includes(policy.id)) throw new Error("无效候选匹配参数");
  }
  if (new Set(policies.map(p=>p.id)).size !== policies.length) throw new Error("重复候选名称");
  for (const row of rows) {
    if (!row.sourceFile || !Number.isInteger(row.sourceRow) || row.sourceRow < 1 || !validOdds(row.odds,8) || !GOAL_LABELS.includes(String(row.goals))) throw new Error("进球研究数据存在无效来源、行号、赔率或赛果");
    if (!Number.isInteger(row.historyBatchId ?? 0) || (row.historyBatchId ?? 0) < 0) throw new Error("无效数据库批次");
    if (row.historyId != null && (!Number.isInteger(row.historyId) || row.historyId < 1)) throw new Error("无效数据库ID");
    if ((row.historyBatchId || 0) > 0 && (!Number.isInteger(row.historyId) || row.historyId < 1)) throw new Error("增量记录缺少数据库ID");
    if (!row.historyBatchId) {
      const position=JSON.stringify([row.sourceFile,row.sourceRow]);
      if (legacyPositions.has(position)) throw new Error("旧来源重复行号，无法确定历史顺序");
      legacyPositions.add(position);
    }
    const identity = row.historyId ? `goals:${row.historyId}` : `legacy:${row.sourceFile}:${row.sourceRow}`;
    if (identities.has(identity)) throw new Error("重复数据库记录或旧来源行号");
    identities.add(identity);
  }
  const orderedInput = [...rows].sort((a,b)=>a.sourceFile.localeCompare(b.sourceFile) || a.sourceRow-b.sourceRow || (a.historyId||0)-(b.historyId||0));
  const timelines = historyTimelines(orderedInput.map(features));
  const ordered = timelines.flatMap(t=>t.batches.flat());
  const validationStart = batchBoundary(ordered, Math.floor(ordered.length*.6));
  const tailStart = batchBoundary(ordered, Math.floor(ordered.length*.8));
  let order = 0;
  for (const timeline of timelines) {
    const sourceFile = timeline.sourceFile, group = timeline.batches.flat();
    const pool = [...timeline.seed];
    const before = cases.length;
    for (const batch of timeline.batches) {
      for (const target of batch) {
      const targetOrder = order++;
      if (pool.length>=warmup) {
        const resolved = selectProductionGoalSimilarity(pool,target);
        const base = predictProductionGoals(target.odds,resolved,{blendOptions:{empiricalOnly:true,requireSamples:true}});
        const full = [], joint = [];
        for (const sample of policies.some(p=>p.kind !== "blend") ? pool : []) {
          const d = hellinger(sample.gp,target.gp);
          full.push({row:sample,distance:d});
          if (sample.sp && target.sp && sample.hhad.handicap === target.hhad.handicap) {
            joint.push({row:sample,distance:.7*d+.15*hellinger(sample.sp,target.sp)+.15*hellinger(sample.hp,target.hp)});
          }
        }
        const compare = (a,b)=>a.distance-b.distance || (a.row.historyId||a.row.sourceRow)-(b.row.historyId||b.row.sourceRow);
        full.sort(compare); joint.sort(compare);
        const predictions = {
          baseline:base.available ? {probabilities:base.final,samples:base.stats.total,effectiveSamples:base.weighting.effectiveSamples} : null,
          market:{probabilities:target.gp,samples:0,effectiveSamples:0},
        };
        for (const policy of policies) {
          if (policy.kind === "blend") {
            predictions[policy.id] = predictions.baseline ? {...predictions.baseline,
              probabilities:base.final.map((p,i)=>policy.modelWeight*p+(1-policy.modelWeight)*target.gp[i])} : null;
            continue;
          }
          const nearest = (policy.kind === "joint" ? joint : full).slice(0,policy.k);
          const positives = nearest.filter(x=>x.distance>1e-9);
          const bandwidth = Math.max(.005,positives[Math.floor(positives.length/2)]?.distance || .01);
          predictions[policy.id] = prediction(target,nearest.map(x=>({...x.row,distance:x.distance,similarityWeight:Math.exp(-x.distance/bandwidth)})),bandwidth);
        }
        cases.push({fixtureId:target.historyId?`goals:${target.historyId}`:`legacy:${sourceFile}:${target.sourceRow}`,
          sourceFile:target.sourceFile,sourceRow:target.sourceRow,timeline:sourceFile,order:targetOrder,
          historyId:target.historyId ?? null,historyBatchId:target.historyBatchId || 0,trainingRows:pool.length,
          league:target.league,actualIndex:GOAL_LABELS.indexOf(String(target.goals)),odds:target.odds,
          period:targetOrder<validationStart?"development":targetOrder<tailStart?"validation":"observedTail",
          hasJointFeatures:Boolean(target.sp), predictions});
      }
      if (order%500===0) onProgress({sourceFile,processed:order,total:ordered.length});
      }
      // 整批预测后才允许使用该批赛果；每日文件行号不参与新批次排序。
      pool.push(...batch);
    }
    sources.push({sourceFile,rows:group.length,seedRows:timeline.seed.length,batches:timeline.batches.length,
      jointRows:group.filter(x=>x.sp).length,evaluated:cases.length-before});
  }
  return {cases,sources,split:{timelineVersion:HISTORY_TIMELINE_VERSION,validationStart,tailStart,total:ordered.length}};
}

export function summarizePairs(rows,id) {
  const evaluated = rows.filter(x=>x.predictions[id]);
  const n = evaluated.length;
  if (!n) return {evaluated:0,targets:rows.length,availability:0,pairHitRate:null,logLoss:null};
  let hits=0, firstHits=0, secondHits=0, coverage=0, profit=0, pairBrier=0, logLoss=0,brier=0,samples=0,effective=0;
  const bins = [{from:0,to:.4},{from:.4,to:.45},{from:.45,to:.5},{from:.5,to:.55},{from:.55,to:1.000001}]
    .map(x=>({...x,count:0,hits:0,predictedSum:0}));
  for (const row of evaluated) {
    const p=row.predictions[id], outcome=pairOutcome(p.probabilities,row.odds,row.actualIndex);
    hits+=Number(outcome.hit); coverage+=outcome.predictedCoverage; profit+=outcome.profitUnits;
    firstHits+=Number(outcome.indices[0]===row.actualIndex);
    secondHits+=Number(outcome.indices[1]===row.actualIndex);
    pairBrier+=(outcome.predictedCoverage-Number(outcome.hit))**2;
    logLoss-=Math.log(Math.max(1e-15,p.probabilities[row.actualIndex]));
    brier+=p.probabilities.reduce((s,v,i)=>s+(v-Number(i===row.actualIndex))**2,0);
    samples+=p.samples; effective+=p.effectiveSamples;
    const bin=bins.find(x=>outcome.predictedCoverage>=x.from && outcome.predictedCoverage<x.to);
    bin.count++;bin.hits+=Number(outcome.hit);bin.predictedSum+=outcome.predictedCoverage;
  }
  const calibration=bins.map(({predictedSum,...x})=>({...x,actualCoverage:x.count?x.hits/x.count:null,meanPrediction:x.count?predictedSum/x.count:null}));
  return {evaluated:n,targets:rows.length,availability:n/rows.length,hits,pairHitRate:hits/n,
    firstChoiceHits:firstHits,secondChoiceHits:secondHits,secondChoiceContribution:secondHits/n,
    meanPredictedCoverage:coverage/n,coverageGap:(coverage-hits)/n,pairBrier:pairBrier/n,
    logLoss:logLoss/n,brier:brier/n,stakeUnits:2*n,profitUnits:profit,roi:profit/(2*n),
    meanSamples:samples/n,meanEffectiveSamples:effective/n,
    pairECE:calibration.reduce((s,x)=>s+(x.count?Math.abs(x.meanPrediction-x.actualCoverage)*x.count/n:0),0),calibration};
}

export function selectOnDevelopment(cases,policies) {
  // 所有候选在共同可预测的开发样本上选参，后续段不得改选参数。
  const common=cases.filter(x=>x.period==="development" && x.predictions.baseline && policies.every(p=>x.predictions[p.id]));
  return policies.map(p=>({...p,metrics:summarizePairs(common,p.id)}))
    .sort((a,b)=>(b.metrics.pairHitRate ?? -1)-(a.metrics.pairHitRate ?? -1) ||
      (a.metrics.logLoss ?? Infinity)-(b.metrics.logLoss ?? Infinity) || a.id.localeCompare(b.id));
}

const logit = p => Math.log(Math.max(1e-9,p)/Math.max(1e-9,1-p));
const logistic = x => 1/(1+Math.exp(-x));

// 只校准两项合计的覆盖率，不改变八档概率、选择、排序或命中数。
export function fitCoverageCalibration(cases, id, {minSamples=50}={}) {
  const training = cases.filter(row=>row.period === "development" && row.predictions[id])
    .map(row=>pairOutcome(row.predictions[id].probabilities,row.odds,row.actualIndex));
  if (training.length < minSamples) return {available:false,trainingRows:training.length,offset:0,reason:"开发样本不足"};
  const hits = training.filter(x=>x.hit).length;
  // 固定半个成功/失败的弱先验，避免全中或全错时截距无穷大。
  const rate = (hits+.5)/(training.length+1);
  let low=-30,high=30;
  for (let i=0;i<80;i++) {
    const mid=(low+high)/2;
    const mean=training.reduce((s,x)=>s+logistic(logit(x.predictedCoverage)+mid),0)/training.length;
    if (mean<rate) low=mid; else high=mid;
  }
  return {available:true,trainingRows:training.length,offset:(low+high)/2,method:"development-only-logit-offset"};
}

export function summarizeCoverageCalibration(cases,id,fit) {
  if (!fit.available) return {available:false,reason:fit.reason};
  const rows=cases.filter(row=>row.predictions[id]);
  if (!rows.length) return {available:false,reason:"无评估样本"};
  const bins=[0,.4,.45,.5,.55].map((from,i,starts)=>({from,to:starts[i+1]??1.000001,count:0,hits:0,sum:0}));
  let raw=0,calibrated=0,beforeBrier=0,afterBrier=0,hits=0;
  for (const row of rows) {
    const outcome=pairOutcome(row.predictions[id].probabilities,row.odds,row.actualIndex);
    const p=logistic(logit(outcome.predictedCoverage)+fit.offset), hit=Number(outcome.hit);
    raw+=outcome.predictedCoverage; calibrated+=p; hits+=hit;
    beforeBrier+=(outcome.predictedCoverage-hit)**2; afterBrier+=(p-hit)**2;
    const bin=bins.find(x=>p>=x.from && p<x.to);
    bin.count++;bin.hits+=hit;bin.sum+=p;
  }
  const calibration=bins.map(({sum,...bin})=>({...bin,meanPrediction:bin.count?sum/bin.count:null,actualCoverage:bin.count?bin.hits/bin.count:null}));
  return {available:true,evaluated:rows.length,hits,pairHitRate:hits/rows.length,
    meanBefore:raw/rows.length,meanAfter:calibrated/rows.length,
    brierBefore:beforeBrier/rows.length,brierAfter:afterBrier/rows.length,
    pairECE:calibration.reduce((s,x)=>s+(x.count?x.count*Math.abs(x.meanPrediction-x.actualCoverage)/rows.length:0),0),
    selectionsChanged:0,calibration};
}
