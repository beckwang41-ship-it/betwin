// 本次盲测固定规则：近期进失球的独立泊松模型；不训练、不混合正式赔率概率。
export const FORM_POISSON_TRIAL_VERSION = "form-poisson-blind-trial-v1";
export const TRIAL_LABELS = {
  spf: ["胜", "平", "负"], hhad: ["让胜", "让平", "让负"],
  goals: ["0", "1", "2", "3", "4", "5", "6", "7+"],
};

export function trialSelection(probabilities, market) {
  if (!Array.isArray(probabilities) || probabilities.length !== TRIAL_LABELS[market]?.length ||
      probabilities.some(p => !Number.isFinite(p) || p < 0) ||
      Math.abs(probabilities.reduce((a,b)=>a+b,0)-1) > 1e-6) return null;
  const order = probabilities.map((p,i)=>({p,i})).sort((a,b)=>b.p-a.p || a.i-b.i);
  return { probabilities: [...probabilities], labels: TRIAL_LABELS[market],
    single: { index: order[0].i, label: TRIAL_LABELS[market][order[0].i], probability: order[0].p },
    tiedTop: order.filter(r=>Math.abs(r.p-order[0].p)<1e-12).map(r=>r.i),
    ...(market === "goals" ? { pair: { indices: order.slice(0,2).map(r=>r.i),
      labels: order.slice(0,2).map(r=>TRIAL_LABELS[market][r.i]),
      coverage: order[0].p+order[1].p } } : {}) };
}

function poisson(mean) {
  const limit = Math.ceil(mean + 12*Math.sqrt(mean+1) + 12), p=[Math.exp(-mean)];
  for (let k=1;k<=limit;k++) p.push(p[k-1]*mean/k);
  return p;
}

export function predictFormPoisson(form, handicap) {
  const home=form?.home?.recent, away=form?.away?.recent;
  if (![home,away].every(s=>s?.matches>=3 && [s.goalsForPerGame,s.goalsAgainstPerGame].every(v=>Number.isFinite(v)&&v>=0&&v<=99))) {
    return { available:false, version:FORM_POISSON_TRIAL_VERSION, reason:"双方至少各需3场有效近期比分，不足时不补预测" };
  }
  const meanHome=(home.goalsForPerGame+away.goalsAgainstPerGame)/2;
  const meanAway=(away.goalsForPerGame+home.goalsAgainstPerGame)/2;
  const ph=poisson(meanHome),pa=poisson(meanAway);
  const spf=[0,0,0],hhad=[0,0,0],goals=Array(8).fill(0);
  const hasHandicap=handicap!==null && handicap!==undefined && handicap!=="" && Number.isInteger(Number(handicap));
  let mass=0;
  for(let h=0;h<ph.length;h++) for(let a=0;a<pa.length;a++) {
    const p=ph[h]*pa[a];mass+=p;
    spf[h>a?0:h===a?1:2]+=p;
    if(hasHandicap){const margin=h-a+Number(handicap);hhad[margin>0?0:margin===0?1:2]+=p;}
    goals[Math.min(7,h+a)]+=p;
  }
  if(Math.abs(mass-1)>1e-9) throw new Error("泊松截断概率质量不足，停止本次预测");
  return {available:true,version:FORM_POISSON_TRIAL_VERSION,meanHome,meanAway,
    homeSamples:home.matches,awaySamples:away.matches,
    spf:trialSelection(spf.map(p=>p/mass),"spf"),
    hhad:hasHandicap?trialSelection(hhad.map(p=>p/mass),"hhad"):null,
    goals:trialSelection(goals.map(p=>p/mass),"goals")};
}
