import { recentFormFeatures } from "./recent-form.mjs";

const LABELS = { spf: ["胜", "平", "负"], hhad: ["胜", "平", "负"], goals: ["0", "1", "2", "3", "4", "5", "6", "7+"] };
const CONFIG = { minimumTraining: 200, minimumEvaluation: 100, epochs: 120, learningRate: 0.1, l2: 0.05 };
const rank = p => p.map((v,i)=>({v,i})).sort((a,b)=>b.v-a.v || a.i-b.i).map(r=>r.i);
function predict(row, weights) {
  const logits = row.p.map((p,k)=>Math.log(Math.max(1e-8,p)) + weights[k].reduce((sum,w,j)=>sum+w*row.x[j],0));
  const max = Math.max(...logits), exp = logits.map(v=>Math.exp(v-max)), total = exp.reduce((a,b)=>a+b,0);
  return exp.map(v=>v/total);
}
function train(rows, classes) {
  const weights = Array.from({length:classes},()=>Array(14).fill(0));
  for(let epoch=0;epoch<CONFIG.epochs;epoch++) {
    const gradient=weights.map(w=>w.map(v=>CONFIG.l2*v));
    for(const row of rows) {
      const p=predict(row,weights);
      for(let k=0;k<classes;k++) for(let j=0;j<14;j++) gradient[k][j]+=(p[k]-Number(row.y===k))*row.x[j]/rows.length;
    }
    for(let k=0;k<classes;k++) for(let j=0;j<14;j++) weights[k][j]-=CONFIG.learningRate*gradient[k][j];
  }
  return weights;
}
function metrics(cases, key, goals) {
  if(!cases.length) return null;
  return { samples:cases.length,
    accuracy:cases.reduce((s,r)=>s+Number(rank(r[key])[0]===r.y),0)/cases.length,
    logLoss:cases.reduce((s,r)=>s-Math.log(Math.max(1e-8,r[key][r.y])),0)/cases.length,
    brier:cases.reduce((s,r)=>s+r[key].reduce((b,p,k)=>b+(p-Number(r.y===k))**2,0),0)/cases.length,
    ...(goals?{pairHitRate:cases.reduce((s,r)=>s+Number(rank(r[key]).slice(0,2).includes(r.y)),0)/cases.length}:{}) };
}

// 仅使用留档时冻结的战绩；训练赛果必须在目标留档前已结算。
export function compareRecentForm(records) {
  const groups=new Map(), counts={total:records.length,withoutFeatures:0,invalid:0,pending:0,eligibleSettled:0};
  const seen=new Set();
  for(const row of [...records].sort((a,b)=>String(a.captured_at).localeCompare(String(b.captured_at)) || a.id-b.id)) {
    const labels=LABELS[row.market];
    if(!labels) continue;
    const settings=JSON.parse(row.settings_json || "{}");
    const form=settings.recentForm, x=recentFormFeatures(form);
    if(!x){counts.withoutFeatures++;continue;}
    const captured=Date.parse(row.captured_at), imported=Date.parse(form.importedAt);
    if(!row.valid || settings.sameLeague || !row.algorithm_version || !Number.isFinite(captured) ||
      !Number.isFinite(imported) || imported>captured || x.some(v=>!Number.isFinite(v))) {counts.invalid++;continue;}
    if(row.status!=="settled"){counts.pending++;continue;}
    const p=JSON.parse(row.probabilities_json), y=labels.indexOf(String(row.actual_result)), settled=Date.parse(row.settled_at);
    const key=`${row.market}|${row.algorithm_version}`, unique=`${key}|${row.match_id}`;
    if(y<0 || !Number.isFinite(settled) || settled<captured || !Array.isArray(p) || p.length!==labels.length ||
       p.some(v=>!Number.isFinite(v)||v<0) || Math.abs(p.reduce((a,b)=>a+b,0)-1)>0.001 || seen.has(unique)) {counts.invalid++;continue;}
    seen.add(unique);counts.eligibleSettled++;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push({x,p,y,captured,settled,matchId:row.match_id});
  }
  const comparisons=[];
  for(const [key,rows] of groups) {
    const cases=[];
    for(let i=0;i<rows.length;i++) {
      const target=rows[i];
      const training=rows.slice(0,i).filter(r=>r.settled<target.captured && r.matchId!==target.matchId);
      if(training.length<CONFIG.minimumTraining)continue;
      const candidate=predict(target,train(training,target.p.length));
      cases.push({baseline:target.p,candidate,y:target.y});
    }
    const market=key.split("|")[0];
    comparisons.push({market,algorithmVersion:key.slice(market.length+1),settled:rows.length,evaluated:cases.length,
      status:cases.length<CONFIG.minimumEvaluation?"insufficient-data":"research-only",
      baseline:metrics(cases,"baseline",market==="goals"),candidate:metrics(cases,"candidate",market==="goals")});
  }
  return {version:"recent-form-residual-research-v1",config:CONFIG,counts,comparisons,productionChanged:false,
    notes:["仅分析留档内冻结的战绩，不回填旧比赛；同算法版本、全部联赛分别比较。",
      "固定正则化多分类残差模型，以原赔率模型概率为基线；只用此前已结算的样本训练。",
      "每个版本至少200场训练，另积累100场滚动评估再讨论效果；这只是研究样本门槛，不代表验证通过。",
      "总进球比较概率前两项的双选命中率；不等于已验证双选策略或收益提升。",
      "战绩按用户赛前采集约定使用，未核验精确开赛时间；不自动启用，不据此承诺准确率或盈利。"]};
}
