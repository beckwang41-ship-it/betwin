import { DatabaseSync } from "node:sqlite";
import { mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { extractContextFeatures } from "../lib/context-features.mjs";
import { PILOT_PROTOCOL as MODEL_PROTOCOL,PILOT_LABELS,predictContextPilot } from "../lib/context-pilot.mjs";
import { currentAlgorithmVersions, runtimeCodeSignature, databaseIdentity, assertRuntimeUnchanged } from "../lib/runtime-configuration.mjs";
import { contextPilotBatchKey,contextPilotRecentFormFingerprint,matchingFrozenReport } from "../lib/context-pilot-freeze.mjs";

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 只升级冻结协议；模型数学与 TypeSafe 所依赖的模型协议保持原样。
const PILOT_PROTOCOL={...MODEL_PROTOCOL,version:"context-pilot-v5-runtime-versions",modelVersion:MODEL_PROTOCOL.version};
const database=process.env.BETWIN_DATABASE_PATH || path.join(root,"betwin.db");
const origin=`http://127.0.0.1:${process.env.PORT || 8765}`;
const outputDir=path.join(root,"data/context-pilot");
const hash=v=>createHash("sha256").update(v).digest("hex");
const protocolFiles=["lib/context-pilot.mjs","lib/context-pilot-freeze.mjs","lib/context-features.mjs","lib/context-experiment.mjs","lib/recent-form.mjs","lib/runtime-configuration.mjs","scripts/predict_context_pilot.mjs"];
const codeHashes=Object.fromEntries(protocolFiles.map(f=>[f,hash(readFileSync(path.join(root,f)))]));
const fingerprint=hash(JSON.stringify({protocol:PILOT_PROTOCOL,codeHashes}));
const db=new DatabaseSync(database,{readOnly:true}),store=createDataStore(database);
const sources=()=>db.prepare("SELECT * FROM source_files ORDER BY file_name").all();
const records=()=>db.prepare("SELECT * FROM prediction_ledger WHERE market IN ('spf','hhad','goals') ORDER BY captured_at,id").all();
const baselineFiles=["server.mjs",...readdirSync(path.join(root,"lib")).filter(f=>f.endsWith(".mjs")).map(f=>`lib/${f}`),
  ...readdirSync(path.join(root,"data")).filter(f=>f.endsWith("-config.json")||f.endsWith("-production.json")).map(f=>`data/${f}`)];
const baselineHashes=()=>Object.fromEntries(baselineFiles.map(f=>[f,hash(readFileSync(path.join(root,f)))]));
async function get(url){
  let r;
  try { r=await fetch(`${origin}${url}`,{signal:AbortSignal.timeout(60000)}); }
  catch(error){throw new Error(`无法连接预测服务 ${origin}。请先运行 npm start，再执行数据更新命令。原始错误：${error.message}`);}
  if(!r.ok)throw new Error(`${url}: HTTP ${r.status}`);return r.json();
}
try {
  const startedAt=new Date().toISOString(),matches=store.getMatches(),inputs=sources(),originalRecords=records();
  if(!matches.length)throw new Error("当前没有比赛");
  if(process.env.BETWIN_TRIAL_EXPECTED_COUNT && matches.length!==Number(process.env.BETWIN_TRIAL_EXPECTED_COUNT))throw new Error("当前场数与预期不符");
  const active=new Set(matches.map(m=>String(m.id)));
  const settledIds=new Set(originalRecords.filter(r=>active.has(String(r.match_id))&&r.status==="settled"&&r.valid).map(r=>String(r.match_id)));
  const eligibleMatches=matches.filter(m=>!settledIds.has(String(m.id)));
  const baselineCodeHashes=baselineHashes();
  if(!eligibleMatches.length) {
    throw new Error("当前批次的比赛均已有赛果，不能事后补做赛前四组预测");
  }
  const eligibleIds=new Set(eligibleMatches.map(m=>String(m.id)));
  const guard=()=>{if(records().some(r=>eligibleIds.has(String(r.match_id))&&r.status==="settled"&&r.valid))throw new Error("冻结期间已有赛果导入，已停止以防赛后信息泄漏");};
  guard();
  const service=await get("/api/runtime");
  if(service.runtime?.codeSignature!==runtimeCodeSignature(root)||service.runtime?.databaseIdentity!==databaseIdentity(database))throw new Error("预测服务代码或数据库不一致，请重启服务后再冻结");
  const algorithmVersions=currentAlgorithmVersions(service.currentAlgorithmSpec);
  const assertRuntime=p=>assertRuntimeUnchanged(service,p);
  const targets=[],fixtures=[],skipped=[...matches.filter(m=>settledIds.has(String(m.id))).map(m=>({matchId:String(m.id),market:"all",reason:"赛果已导入，整场未补做预测"}))];
  for(const match of eligibleMatches){
    const p=await get(`/api/predict?${new URLSearchParams({matchId:match.id,sameLeague:"false"})}`);
    assertRuntime(p);
    if(String(p.match?.id)!==String(match.id)||["had","hhad","goals"].some(k=>JSON.stringify(p.match[k])!==JSON.stringify(match[k]))||
      JSON.stringify(p.recentForm)!==JSON.stringify(store.getRecentForm(match))||p.settings.sameLeague!==false)throw new Error(`${match.id}服务与数据库不一致`);
    const capturedAt=new Date().toISOString();
    fixtures.push({match,settings:p.settings,recentForm:p.recentForm,capturedAt,model:p.model,baseline:Object.fromEntries(Object.keys(PILOT_LABELS).map(m=>[m,p[m]]))});
    for(const market of Object.keys(PILOT_LABELS)){
      const features=extractContextFeatures(p.recentForm,{market,league:match.league,handicap:match.hhad?.goalLine});
      if(p[market]?.available===false||!p[market]?.final||!features.available){skipped.push({matchId:match.id,market,reason:features.reason||"正式基线不可用"});continue;}
      if(Date.parse(p.recentForm.importedAt)>Date.parse(capturedAt))throw new Error("战绩导入时间晚于预测时间");
      targets.push({matchId:match.id,home:match.home,away:match.away,league:match.league,market,
        algorithmVersion:algorithmVersions[market],handicap:match.hhad?.goalLine??null,
        p:p[market].final,features,capture:Date.parse(capturedAt),baselineCapturedAt:capturedAt,contextHash:hash(JSON.stringify(p.recentForm))});
    }
    console.log(`已读取 ${fixtures.length}/${eligibleMatches.length}：${match.home} vs ${match.away}`);
  }
  if(!targets.length)throw new Error("没有可预测的玩法");
  const baselineOutputs=fixtures.map(f=>({matchId:String(f.match.id),
    markets:Object.fromEntries(Object.keys(PILOT_LABELS).map(m=>[m,f.baseline[m]?.final||null])),
    recentFormHash:contextPilotRecentFormFingerprint(f.recentForm)}));
  const batchKey=contextPilotBatchKey({protocolFingerprint:fingerprint,sources:inputs,matches,baselineOutputs});
  assertRuntime(await get("/api/runtime"));
  mkdirSync(outputDir,{recursive:true});
  const existingReports=readdirSync(outputDir).filter(f=>/^pilot-.*\.json$/.test(f)).flatMap(file=>{
    try{return [JSON.parse(readFileSync(path.join(outputDir,file),"utf8"))];}catch{return [];}
  });
  const existing=matchingFrozenReport(existingReports,{batchKey,protocolFingerprint:fingerprint});
  if(existing){
    console.log(`四组预测已冻结：同一批数据不重复生成（${existing.frozenAt}，${existing.pendingPredictions.length}条玩法预测）。`);
  }else{
  const report=predictContextPilot(originalRecords,targets);
  guard();
  if(JSON.stringify(inputs)!==JSON.stringify(sources())||JSON.stringify(baselineCodeHashes)!==JSON.stringify(baselineHashes()))throw new Error("预测期间数据或代码变化，拒绝冻结混合批次");
  Object.assign(report,{version:PILOT_PROTOCOL.version,protocol:PILOT_PROTOCOL,runtime:service.runtime,startedAt,frozenAt:new Date().toISOString(),batchKey,protocolFingerprint:fingerprint,codeHashes,baselineCodeHashes,
    sources:inputs,sourceHash:hash(JSON.stringify(inputs)),ledgerInputHash:hash(JSON.stringify(originalRecords)),fixtures,skipped,
    genuinePrematchValidation:null,limitations:["当前批次尚未导入结算记录，未查询赛果；按用户赛前数据约定使用，精确开赛时间未核验。",
      "小样本减特征、强正则的探索模型，参数预先固定，未经证明为最优；45场训练不能当作独立验证成绩。",
      "A正式赔率，B加近期状态，C加交锋，D加两者；无交锋时C=A、D=B；10场汇总不混入5场明细。",
      "三个玩法独立拟合修正，不是统一比分生成模型；候选跨玩法概率未施加联合一致性约束，不接入正式页面。",
      "交锋按时间衰减且少量交锋收缩；尚未校正对手实力、阵容及赛程差异。",
      "三个玩法均选最高概率单项，总进球另选最高两档；并列按固定标签顺序，估算概率不等于实测命中率。",
      "结算只读本次冻结概率和选择，另存结果；同版本同比赛取最早有效预测，不重算旧预测，不混入旧泊松实验。"]});
  const manifestPath=path.join(outputDir,`${PILOT_PROTOCOL.version}-protocol.json`);
  if(existsSync(manifestPath)){
    if(JSON.parse(readFileSync(manifestPath,"utf8")).fingerprint!==fingerprint)throw new Error("小样本协议代码已变，必须升级版本，不能覆盖原协议");
  }else writeFileSync(manifestPath,JSON.stringify({fingerprint,codeHashes,protocol:PILOT_PROTOCOL,activatedAt:startedAt,
    knownSettledMatchIds:[...new Set(originalRecords.filter(r=>r.status==="settled").map(r=>String(r.match_id)))]},null,2)+"\n",{flag:"wx"});
  const json=JSON.stringify(report,null,2)+"\n",name=`pilot-${eligibleMatches.length}-${report.frozenAt.replace(/[:.]/g,"-")}`;
  const labels={spf:"胜平负",hhad:"让球胜平负",goals:"总进球单选及双选"};
  const pct=p=>`${(p*100).toFixed(1)}%`,choice=p=>`${p.single} ${pct(p.probabilities[p.singleIndex])}${p.tiedTop.length>1?"（并列）":""}${p.pair?`；双选 ${p.pair.join("/")} ${pct(p.pairCoverage)}`:""}`;
  const lines=[`# ${eligibleMatches.length}场小样本四组对比预测`,"",`冻结时间：${report.frozenAt}；正式模型未改。`,"",
    "A 原赔率模型｜B 赔率＋近期状态｜C 赔率＋历史交锋｜D 赔率＋两者。", "",...report.limitations.map(s=>`- ${s}`),"",
    ...report.models.map(m=>`- ${labels[m.trainingRows[0].market]}：训练${m.training}场，其中${m.h2hTraining}场有交锋；状态${Object.keys(m.featureNames.state).length}项、交锋${Object.keys(m.featureNames.history).length}项。`)];
  for(const market of Object.keys(labels)){
    lines.push("",`## ${labels[market]}`,"","| ID | 对阵（主队让球） | A | B | C | D | 交锋场数 |","|---|---|---|---|---|---|---:|");
    for(const p of report.pendingPredictions.filter(p=>p.market===market))lines.push(`| ${p.matchId} | ${p.home} vs ${p.away}（${p.handicap}） | ${Object.keys(report.arms).map(a=>choice(p.predictions[a])).join(" | ")} | ${p.features.quality.h2hSamples} |`);
  }
  if(skipped.length)lines.push("","## 未生成的比赛或玩法","",...skipped.map(r=>`- ${r.matchId} ${labels[r.market]||"整场"}：${r.reason}`));
  lines.push("",`JSON SHA-256：${hash(json)}`,"");
  const jsonPath=path.join(outputDir,`${name}.json`),mdPath=path.join(outputDir,`${name}.md`);
  writeFileSync(jsonPath,json,{flag:"wx"});writeFileSync(mdPath,lines.join("\n"),{flag:"wx"});
  console.log(JSON.stringify({fixtures:eligibleMatches.length,predictions:targets.length,skipped,jsonPath,mdPath,sha256:hash(json)},null,2));
  }
}finally{store.close();db.close();}
