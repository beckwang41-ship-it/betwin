import { RECENT_FORM_VERSION } from "./recent-form.mjs";

export const CONTEXT_FEATURE_VERSION = "state-h2h-features-v1";
export const CONTEXT_FEATURE_RULES = Object.freeze({ maxRecent: 5, minimumRecent: 3,
  maxHeadToHead: 10, headToHeadHalfLifeDays: 730, goalScale: 5, extremeTotal: 8 });
const clip = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const mean = (rows, fn) => rows.length ? rows.reduce((s,r)=>s+fn(r),0)/rows.length : 0;
const points = r => r.gf > r.ga ? 3 : r.gf === r.ga ? 1 : 0;
const win = r => Number(r.gf > r.ga), draw = r => Number(r.gf === r.ga);
const goalBin = r => Math.min(7,r.gf+r.ga);

function validatedRows(input, cutoff) {
  const seen = new Set(), rows = [];
  for (const r of Array.isArray(input) ? input : []) {
    const time = Date.parse(`${r?.date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r?.date || "") || !Number.isFinite(time) ||
        new Date(time).toISOString().slice(0,10) !== r.date || r.date > cutoff ||
        ![r.gf,r.ga].every(v=>Number.isInteger(v)&&v>=0&&v<=99) ||
        !["home","away"].includes(r.venue) || !r.home || !r.away) {
      throw new Error("冻结战绩含无效日期、比分、场地或晚于导入日期的记录");
    }
    const key = `${r.date}|${r.home}|${r.away}`;
    if (seen.has(key)) throw new Error("冻结战绩含重复比赛，需检查来源");
    seen.add(key); rows.push(r);
  }
  return rows.sort((a,b)=>b.date.localeCompare(a.date));
}

function stateFeatures(rows, side, league, handicap) {
  const f = {}, put = (key,value) => { f[`${side}.${key}`] = value; };
  put("available",Number(rows.length>=3)); put("sampleFraction",rows.length/5);
  put("winRate",mean(rows,win)); put("drawRate",mean(rows,draw));
  put("lossRate",mean(rows,r=>Number(r.gf<r.ga)));
  put("points",mean(rows,points)/3);
  put("goalsFor",mean(rows,r=>clip(r.gf/5,0,1)));
  put("goalsAgainst",mean(rows,r=>clip(r.ga/5,0,1)));
  put("margin",mean(rows,r=>clip((r.gf-r.ga)/5)));
  put("twoPlusWin",mean(rows,r=>Number(r.gf-r.ga>=2)));
  put("twoPlusLoss",mean(rows,r=>Number(r.ga-r.gf>=2)));
  put("cleanSheet",mean(rows,r=>Number(r.ga===0)));
  put("failedToScore",mean(rows,r=>Number(r.gf===0)));
  put("extremeScore",mean(rows,r=>Number(r.gf+r.ga>=8)));
  const latest=rows.slice(0,3), earlier=rows.slice(3);
  put("trendAvailable",Number(earlier.length>0));
  put("pointsTrend",earlier.length?(mean(latest,points)-mean(earlier,points))/3:0);
  put("attackTrend",earlier.length?clip((mean(latest,r=>r.gf)-mean(earlier,r=>r.gf))/5):0);
  put("defenceTrend",earlier.length?clip((mean(latest,r=>r.ga)-mean(earlier,r=>r.ga))/5):0);
  let unbeaten=0, winning=0;
  for(const r of rows){if(r.gf<r.ga)break;unbeaten++;}
  for(const r of rows){if(r.gf<=r.ga)break;winning++;}
  put("unbeatenRun",unbeaten/5); put("winningRun",winning/5);
  const subsets={venue:rows.filter(r=>r.venue===side), sameCompetition:rows.filter(r=>r.tournament===league),
    cup:rows.filter(r=>/杯/.test(r.tournament)), friendly:rows.filter(r=>/友谊|友誼|俱乐部赛|球会友谊|friendly/i.test(r.tournament))};
  for(const [name,rs] of Object.entries(subsets)) {
    put(`${name}.available`,Number(rs.length>0)); put(`${name}.sampleFraction`,rs.length/5);
    put(`${name}.points`,mean(rs,points)/3); put(`${name}.margin`,mean(rs,r=>clip((r.gf-r.ga)/5)));
  }
  put("unknownCompetition",mean(rows,r=>Number(!r.tournament)));
  for(let i=0;i<8;i++)put(`goals.${i}`,mean(rows,r=>Number(goalBin(r)===i)));
  if(handicap!==null) {
    const margin=r=>(side==="home"?r.gf-r.ga:r.ga-r.gf)+handicap;
    put("currentHandicap.win",mean(rows,r=>Number(margin(r)>0)));
    put("currentHandicap.draw",mean(rows,r=>Number(margin(r)===0)));
    put("currentHandicap.loss",mean(rows,r=>Number(margin(r)<0)));
  }
  return f;
}

function h2hFeatures(rows, referenceTime, league, handicap) {
  const f={"h2h.available":Number(rows.length>0),"h2h.sampleFraction":Math.min(rows.length,10)/10};
  const weights=rows.map(r=>2**(-Math.max(0,(referenceTime-Date.parse(`${r.date}T00:00:00Z`))/86400000)/730));
  const mass=weights.reduce((a,b)=>a+b,0);
  const weighted=fn=>mass?rows.reduce((s,r,i)=>s+weights[i]*fn(r),0)/mass:0;
  f["h2h.recencyMass"]=mass/10;
  f["h2h.latestRecency"]=weights[0] || 0;
  f["h2h.winRate"]=weighted(win); f["h2h.drawRate"]=weighted(draw);
  f["h2h.lossRate"]=weighted(r=>Number(r.gf<r.ga));
  f["h2h.margin"]=weighted(r=>clip((r.gf-r.ga)/5));
  f["h2h.goalsFor"]=weighted(r=>clip(r.gf/5,0,1));
  f["h2h.goalsAgainst"]=weighted(r=>clip(r.ga/5,0,1));
  f["h2h.twoPlusWin"]=weighted(r=>Number(r.gf-r.ga>=2));
  f["h2h.twoPlusLoss"]=weighted(r=>Number(r.ga-r.gf>=2));
  f["h2h.sameCompetition"]=weighted(r=>Number(r.tournament===league));
  f["h2h.homeVenueFraction"]=weighted(r=>Number(r.venue==="home"));
  const sameVenue=rows.filter(r=>r.venue==="home");
  f["h2h.homeVenueAvailable"]=Number(sameVenue.length>0);
  const venueMass=rows.reduce((s,r,i)=>s+(r.venue==="home"?weights[i]:0),0);
  f["h2h.homeVenueWin"]=venueMass?rows.reduce((s,r,i)=>s+(r.venue==="home"?weights[i]*win(r):0),0)/venueMass:0;
  f["h2h.homeVenueDraw"]=venueMass?rows.reduce((s,r,i)=>s+(r.venue==="home"?weights[i]*draw(r):0),0)/venueMass:0;
  for(let i=0;i<8;i++)f[`h2h.goals.${i}`]=weighted(r=>Number(goalBin(r)===i));
  if(handicap!==null){
    f["h2h.currentHandicap.win"]=weighted(r=>Number(r.gf-r.ga+handicap>0));
    f["h2h.currentHandicap.draw"]=weighted(r=>Number(r.gf-r.ga+handicap===0));
    f["h2h.currentHandicap.loss"]=weighted(r=>Number(r.gf-r.ga+handicap<0));
  }
  return f;
}

// 只从当时冻结的明细提取；不读当前JSON，不用已知本场赛果，不混入上游10场汇总。
export function extractContextFeatures(form, {league="",market="spf",handicap=null}={}) {
  if(form?.version!==RECENT_FORM_VERSION) return {available:false,reason:"缺少已冻结的近期战绩版本"};
  const imported=Date.parse(form.importedAt);
  if(!Number.isFinite(imported))return {available:false,reason:"缺少战绩导入时间"};
  const cutoff=new Date(imported+8*3600000).toISOString().slice(0,10);
  const line=market==="hhad" && handicap!==null && handicap!=="" && Number.isInteger(Number(handicap))?Number(handicap):null;
  if(market==="hhad" && line===null)return {available:false,reason:"缺少有效让球数"};
  try {
    const home=validatedRows(form.home?.recent?.rows,cutoff).slice(0,5);
    const away=validatedRows(form.away?.recent?.rows,cutoff).slice(0,5);
    const h2h=validatedRows(form.headToHead?.rows,cutoff).slice(0,10);
    if(home.length<3||away.length<3)return {available:false,reason:"双方各需至少3场有效冻结明细"};
    const state={...stateFeatures(home,"home",league,line),...stateFeatures(away,"away",league,line)};
    const history=h2hFeatures(h2h,imported,league,line);
    return {available:true,version:CONTEXT_FEATURE_VERSION,state,history,
      stateVector:Object.values(state),historyVector:Object.values(history),
      quality:{homeSamples:home.length,awaySamples:away.length,h2hSamples:h2h.length,
        hasH2h:h2h.length>0,trendComplete:home.length===5&&away.length===5,
        opponentStrengthAvailable:false,sourceTiming:form.timing || "unknown"}};
  } catch(error){return {available:false,reason:error.message};}
}
