import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import {
  GOAL_PAIR_RESEARCH_VERSION, GOAL_PAIR_RESEARCH_POLICIES, attachGoalContexts,
  runGoalPairResearch, summarizePairs, pairOutcome, selectOnDevelopment,
  fitCoverageCalibration, summarizeCoverageCalibration,
} from "../lib/goal-pair-research.mjs";
import { blockBootstrapFixtureMean } from "../lib/significance.mjs";

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const generatedAt=new Date().toISOString();
const arg=(key,fallback)=>process.argv.find(x=>x.startsWith(`--${key}=`))?.slice(key.length+3) ?? fallback;
const output=path.resolve(arg("output",path.join(root,"data/goal-pair-research",generatedAt.replace(/[:.]/g,"-"),"report.json")));
const prefix=output.replace(/\.json$/,"");
const casesPath=`${prefix}.cases.jsonl`, mdPath=`${prefix}.md`;
// 重跑不能覆盖旧研究或冻结档案，包括显式指定输出路径时。
for (const file of [output,casesPath,mdPath]) if (existsSync(file)) throw new Error(`输出已存在，请使用新路径：${file}`);
const warmup=Number(arg("warmup","1000"));
const store=createDataStore(process.env.BETWIN_DATABASE_PATH || path.join(root,"betwin.db"));
let rows,dataUpdatedAt,joined,ambiguous,inconsistent;
try {
  ({rows,joined,ambiguous,inconsistent}=attachGoalContexts(store.getGoalHistory(),store.getVerifiedHistory()));
  dataUpdatedAt=store.getHistoricalSourceUpdatedAt();
} finally {store.close();}

const fingerprint=value=>createHash("sha256").update(value).digest("hex");
const policies=GOAL_PAIR_RESEARCH_POLICIES;
const run=runGoalPairResearch(rows,{warmup,policies,onProgress:s=>console.log(`已回放 ${s.processed}/${s.total} 场`)});
const ranking=selectOnDevelopment(run.cases,policies);
if (!ranking[0]?.metrics.evaluated) throw new Error("共同开发样本不足，未生成研究结论");
const chosen=ranking[0].id;
const ids=["baseline","market",chosen];
const comparisonIds=["baseline","market",...policies.map(p=>p.id)];
const common=run.cases.filter(x=>comparisonIds.every(id=>x.predictions[id]));
const fits=Object.fromEntries(ids.map(id=>[id,fitCoverageCalibration(common,id)]));

function compare(cases,candidate,reference) {
  const values=cases.filter(x=>x.predictions[candidate] && x.predictions[reference]).map(row=>{
    const a=row.predictions[candidate].probabilities,b=row.predictions[reference].probabilities;
    const oa=pairOutcome(a,row.odds,row.actualIndex),ob=pairOutcome(b,row.odds,row.actualIndex);
    return {...row,delta:Number(oa.hit)-Number(ob.hit),roiDelta:(oa.profitUnits-ob.profitUnits)/2,
      lossImprovement:Math.log(Math.max(1e-15,a[row.actualIndex]))-Math.log(Math.max(1e-15,b[row.actualIndex]))};
  });
  // 增量批次整体抽样，旧来源使用连续记录块；短时间线不采用整段大小的块。
  const clusters=new Map();
  for (const row of values) {
    if (!clusters.has(row.timeline)) clusters.set(row.timeline,new Set());
    clusters.get(row.timeline).add(row.historyBatchId?`batch:${row.historyBatchId}`:row.fixtureId);
  }
  const minClusters=clusters.size?Math.min(...[...clusters.values()].map(x=>x.size)):0;
  const interval=field=>({
    ...blockBootstrapFixtureMean(values.map(x=>({
      fixtureId:x.historyBatchId?`batch:${x.historyBatchId}`:x.fixtureId,
      sourceFile:x.timeline,order:x.order,market:"goals",value:x[field],
    })),{iterations:2000,blockSize:Math.max(1,Math.min(20,Math.floor(Math.sqrt(minClusters))))}),
    sufficientClusters:minClusters>=5,
  });
  return {common:values.length,candidate:summarizePairs(values,candidate),reference:summarizePairs(values,reference),
    pairHitLift:interval("delta"),roiLift:interval("roiDelta"),logLossImprovement:interval("lossImprovement")};
}

const stages={};
for (const stage of ["development","validation","observedTail"]) {
  const cases=run.cases.filter(x=>x.period===stage), shared=common.filter(x=>x.period===stage);
  stages[stage]={targets:cases.length,commonTargets:shared.length,
    dailyBatchTargets:shared.filter(x=>x.historyBatchId>0).length,
    allAvailable:Object.fromEntries(ids.map(id=>[id,summarizePairs(cases,id)])),
    common:Object.fromEntries(ids.map(id=>[id,summarizePairs(shared,id)])),
    candidateDiagnostics:Object.fromEntries(comparisonIds.map(id=>[id,summarizePairs(shared,id)])),
    comparisons:{baseline:compare(shared,chosen,"baseline"),market:compare(shared,chosen,"market")},
    coverageCalibration:Object.fromEntries(ids.map(id=>[id,summarizeCoverageCalibration(shared,id,fits[id])])),
    fixedCoverageFilters:Object.fromEntries(ids.map(id=>[id,[.5,.55].map(threshold=>{
      const subset=shared.filter(x=>pairOutcome(x.predictions[id].probabilities,x.odds,x.actualIndex).predictedCoverage>=threshold);
      return {threshold,retained:shared.length?subset.length/shared.length:0,metrics:summarizePairs(subset,id)};
    })]))};
}
const lines=run.cases.map(row=>JSON.stringify(row)).join("\n")+"\n";
const codeFiles=["scripts/compare_goal_pairs.mjs","lib/goal-pair-research.mjs","lib/history-timeline.mjs","lib/database.mjs","lib/goal-production.mjs","lib/goal-zero-odds.mjs","lib/predictor.mjs","lib/smoothing.mjs","lib/significance.mjs"];
const passed=["validation","observedTail"].every(stage=>["baseline","market"].every(ref=>{
  const c=stages[stage].comparisons[ref];
  return c.pairHitLift.sufficientClusters && c.pairHitLift.lower>0 && c.logLossImprovement.mean>=0;
}));
const report={version:GOAL_PAIR_RESEARCH_VERSION,generatedAt,reportOnly:true,affectsProduction:false,
  methodology:{primaryMetric:"pairHitRate",choicesPerMatch:2,stakeUnits:2,
    ordering:"只读数据库；旧累加来源按库内保留的来源顺序独立回放；每日增量按入库批次/记录ID，整批预测后才纳入历史池",
    split:"确定性时间线前60%（扣除预热）开发、中间20%验证、末20%已观察尾段；批次边界向前对齐，整批不拆分",
    baseline:"复用正式全联赛进球历史匹配、加权与防零函数；不启用生产中关闭的平滑",
    market:"八档赔率倒数归一化，每场仍只选概率最高两项；并列按进球档位从小到大",
    blend:`固定候选历史权重${policies.map(p=>`${p.modelWeight*100}%`).join("/")}，其余为去水市场概率；原模型无样本时不伪造融合预测`,
    selection:"只在共同开发样本上以双选命中率优先、LogLoss次之选权重；后续验证/尾段不重新选参",
    calibration:"只用共同开发段拟合固定logit截距（至少50场），后段验证；不改变八档概率、选择或排序",
    confidence:"成对时间块bootstrap；每日批次整体作为抽样簇，任一时间线不足5簇不通过历史门槛",
    fixedCoverageFilters:"50%/55%预先固定，仅诊断排名有效性；不同方案筛选子集不同，不能据此宣称提高全量命中率"},
  limitations:["本轮按用户要求在已观察后段结果后增加35%/45%候选；属于追加探索，不视为新的独立验证，不按后段最优值替换开发段选择",
    "没有完整真实比赛日期；入库批次是可审计的先后代理，不代表严格比赛时间，不能消除晚补旧赛果的影响",
    "旧来源之间无可靠时间对应；独立回放后按来源名拼接划段，不声称跨来源真实日历顺序",
    "历史结果此前已反复观察，本报告不是独立未来验证，不根据尾段反向调整候选或门槛",
    "使用历史终赔，与赛前即时赔率可能不同；仍需新比赛冻结验证",
    "校准只能修正覆盖率表达，不能增加命中数；命中率提升不等于盈利或串关收益提升"],
  data:{updatedAt:dataUpdatedAt,rows:rows.length,joined,ambiguous,inconsistent,sources:run.sources,
    dailyRows:rows.filter(x=>x.historyBatchId>0).length,sha256:fingerprint(JSON.stringify(rows))},
  codeFingerprint:fingerprint(codeFiles.map(file=>readFileSync(path.join(root,file),"utf8")).join("\n")),
  settings:{warmup,policies},split:run.split,ranking,selectedOnDevelopmentOnly:chosen,calibrationFits:fits,stages,
  decision:{productionChanged:false,requiresFutureValidation:true,historicalReviewPassed:passed,
    note:"只作历史候选检查，不自动上线、不改旧冻结、不构成盈利证明"},
  futureValidation:{enabled:false,requiresFrozenPrematchPredictions:true,
    candidate:ranking[0],calibrationFits:fits,
    lastHistoryId:Math.max(0,...rows.map(x=>x.historyId||0)),lastHistoryBatchId:Math.max(0,...rows.map(x=>x.historyBatchId||0))},
  cases:{file:path.basename(casesPath),rows:run.cases.length,sha256:fingerprint(lines)}};
const percent=x=>x==null?"—":`${(x*100).toFixed(2)}%`;
const stageNames={development:"开发段（用于选参）",validation:"验证段",observedTail:"已观察末段"};
const table=Object.entries(stages).map(([stage,v])=>{
  const cells=ids.map(id=>`${v.common[id].hits??0}/${v.common[id].evaluated} (${percent(v.common[id].pairHitRate)})`);
  return `| ${stageNames[stage]} | ${cells.join(" | ")} | ${v.dailyBatchTargets} |`;
}).join("\n");
const calibrationTable=Object.entries(stages).filter(([stage])=>stage!=="development").map(([stage,v])=>{
  const c=v.coverageCalibration.baseline;
  return `| ${stageNames[stage]} | ${percent(c.meanBefore)} | ${percent(c.meanAfter)} | ${percent(c.pairHitRate)} | ${c.brierBefore?.toFixed(5)??"—"} → ${c.brierAfter?.toFixed(5)??"—"} |`;
}).join("\n");
const weightTable=comparisonIds.map(id=>{
  const policy=policies.find(p=>p.id===id);
  const label=policy?`历史${Math.round(policy.modelWeight*100)}%＋赔率${Math.round((1-policy.modelWeight)*100)}%`:id==="baseline"?"原模型":"纯赔率基准";
  const cells=Object.values(stages).map(stage=>{
    const m=stage.candidateDiagnostics[id];
    return `${m.hits??0}/${m.evaluated} (${percent(m.pairHitRate)})`;
  });
  return `| ${label} | ${cells.join(" | ")} |`;
}).join("\n");
const weightSection=`\n## 全部权重对照（追加探索）\n\n所有方案使用同一批可预测比赛。只按开发段选参，不能看后段哪个最好就更换权重。\n\n| 方案 | 开发段 | 验证段 | 已观察末段 |\n| --- | --- | --- | --- |\n${weightTable}\n`;
const markdown=`# 进球双选数据库对照研究\n\n生成时间：${generatedAt}\n\n只读数据库 ${rows.length} 场，其中每日批次 ${report.data.dailyRows} 场。候选仅开发段选择：历史权重 ${percent(ranking[0].modelWeight)}，市场权重 ${percent(1-ranking[0].modelWeight)}。正式预测与旧冻结未修改。\n\n扣除预热共回放 ${run.cases.length} 场，三方案共同可预测 ${common.length} 场；原模型缺少相似样本的 ${run.cases.length-common.length} 场不计入共同对比，保留在逐场档案中。\n\n| 阶段 | 原模型 | 赔率基准 | 融合候选 | 共同样本中每日增量 |\n| --- | --- | --- | --- | --- |\n${table}\n\n## 原模型覆盖率校准检查\n\n| 阶段 | 校准前平均预测 | 校准后平均预测 | 实际双选命中率 | 覆盖事件 Brier（越低越好） |\n| --- | --- | --- | --- | --- |\n${calibrationTable}\n\n历史门槛：${passed?"通过候选检查，仍须独立未来验证":"未通过，不替换正式模型"}。\n\n${report.limitations.map(x=>`- ${x}`).join("\n")}\n\n详细分箱、共同样本、置信区间及固定权重见 JSON 报告；逐场结果见 cases.jsonl。每次运行保存新目录，不覆盖旧报告。\n`;
mkdirSync(path.dirname(output),{recursive:true});
writeFileSync(casesPath,lines,{flag:"wx"});
writeFileSync(output,JSON.stringify(report,null,2)+"\n",{flag:"wx"});
writeFileSync(mdPath,markdown+weightSection,{flag:"wx"});
console.log(`完成：${rows.length} 场数据库历史，${run.cases.length} 场回放；开发段候选 ${chosen}。\n历史门槛：${passed?"通过，仍待未来验证":"未通过，保留正式模型"}。\n报告：${mdPath}`);
