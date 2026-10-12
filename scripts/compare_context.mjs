import { DatabaseSync } from "node:sqlite";
import { mkdirSync,readFileSync,writeFileSync,readdirSync,existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { compareContext,CONTEXT_PROTOCOL,CONTEXT_ARMS,evaluateFrozenContext } from "../lib/context-experiment.mjs";

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const database=process.env.BETWIN_DATABASE_PATH || path.join(root,"betwin.db");
const outputDir=process.env.BETWIN_CONTEXT_OUTPUT_DIR || path.join(root,"data","context-experiments");
const hash=value=>createHash("sha256").update(value).digest("hex");
const codeHashes=Object.fromEntries(["lib/context-features.mjs","lib/context-experiment.mjs"].map(f=>[f,hash(readFileSync(path.join(root,f)))]));
const fingerprint=hash(JSON.stringify({protocol:CONTEXT_PROTOCOL,codeHashes}));
const db=new DatabaseSync(database,{readOnly:true}),store=createDataStore(database);
try {
  const records=db.prepare("SELECT * FROM prediction_ledger WHERE market IN ('spf','hhad','goals') ORDER BY captured_at,id").all();
  const generatedAt=new Date().toISOString();
  mkdirSync(outputDir,{recursive:true});
  const manifestPath=path.join(outputDir,`${CONTEXT_PROTOCOL.version}-protocol.json`);
  const manifest=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,"utf8")):
    {version:CONTEXT_PROTOCOL.version,activatedAt:generatedAt,fingerprint,codeHashes,protocol:CONTEXT_PROTOCOL,
      knownSettledMatchIds:[...new Set(records.filter(r=>r.status==="settled").map(r=>String(r.match_id)))]};
  if(manifest.fingerprint!==fingerprint)throw new Error("实验代码或配置已变化：请升级实验版本，不能覆盖原协议继续累计成绩");
  if(!existsSync(manifestPath))writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n",{flag:"wx"});
  const current=store.getMatches();
  const report=compareContext(records,{generatedAt,activationAt:manifest.activatedAt,activeMatchIds:current.map(r=>r.id)});
  report.protocolFingerprint=fingerprint;
  report.activeFixtures=current.length;
  report.activeWithoutUsableLedger=current.filter(m=>!report.pendingPredictions.some(p=>p.matchId===m.id)).map(m=>({matchId:m.id,home:m.home,away:m.away}));
  // 只结算先前已写出的四组预测，不调用新模型替代旧预测。
  const previousReports=readdirSync(outputDir).filter(f=>f.startsWith("comparison-")&&f.endsWith(".json")).map(file=>({
    ...JSON.parse(readFileSync(path.join(outputDir,file),"utf8")),sourceReport:file}));
  report.frozenValidation=evaluateFrozenContext(previousReports,records,{fingerprint,activationAt:manifest.activatedAt,knownSettledMatchIds:manifest.knownSettledMatchIds});
  const pct=value=>value==null?"—":`${(100*value).toFixed(1)}%`;
  const labels={spf:"胜平负",hhad:"让球胜平负",goals:"总进球"};
  const lines=["# 近期状态与历史交锋四组对照", "",`生成时间：${generatedAt}`,"",
    "A 原赔率；B 赔率＋近期状态；C 赔率＋历史交锋；D 赔率＋两者。四组分玩法、同基线版本、同批比赛比较。", "",
    "近期状态包含胜平负、积分、近3场相对前2场趋势、连胜/不败、主客场、同赛事/杯赛/友谊赛、净胜球及进球档位。交锋包含时间衰减、当前主队视角胜平负、相同主客场、净胜球、进球档位及当前让球数映射。", "",
    "缺少可靠对手实力评分，不能声称已校正对手强弱；10场汇总与5场明细不混算。历史交锋缺失明确记录，不阻断全样本比较。", "",
    `有效留档：已结算 ${report.counts.settled} 条、待结算 ${report.counts.pending} 条（按玩法计）；有交锋 ${report.counts.withH2h} 条。`, "",
    "## 样本与训练准备", "", "| 玩法 | 已结算训练样本 | 含交锋 | 距200场训练还需 | 滚动评估 | 状态 |", "|---|---:|---:|---:|---:|---|"];
  for(const c of report.comparisons)lines.push(`| ${labels[c.market]} | ${c.training} | ${c.h2hTraining} | ${c.neededTraining} | ${c.evaluated} | ${c.status} |`);
  lines.push("", "## 四组滚动对照（回放诊断，不能当作真正提前冻结验证）", "",
    "| 玩法 | 组别 | 评估场次 | 单选命中率 | 双选命中率 | LogLoss↓ | Brier↓ |", "|---|---|---:|---:|---:|---:|---:|");
  for(const c of report.comparisons)for(const [arm,m] of Object.entries(c.metrics))lines.push(`| ${labels[c.market]} | ${arm} ${CONTEXT_ARMS[arm]} | ${m?.samples || 0} | ${pct(m?.accuracy)} | ${pct(m?.pairHitRate)} | ${m?.logLoss.toFixed(4) || "—"} | ${m?.brier.toFixed(4) || "—"} |`);
  lines.push("", "## 启动后提前冻结的对照", "");
  if(!report.frozenValidation.length)lines.push("暂无已结算的四组提前冻结预测；没有用历史回算结果冒充验证成绩。");
  for(const c of report.frozenValidation)for(const [arm,m] of Object.entries(c.metrics))lines.push(`- ${labels[c.market]} ${arm}：${m.samples}场，单选${pct(m.accuracy)}${c.market==="goals"?`，双选${pct(m.pairHitRate)}`:""}`);
  lines.push("", "## 当前未结算记录", "", "| 对阵 | 玩法 | A | B | C | D |", "|---|---|---|---|---|---|");
  const choice=p=>p?`${p.single}${p.pair?`；双选${p.pair.join("/")}球`:""}`:"待训练，未生成";
  for(const p of report.pendingPredictions)lines.push(`| ${p.home} vs ${p.away} | ${labels[p.market]} | ${Object.keys(CONTEXT_ARMS).map(a=>choice(p.predictions[a])).join(" | ")} |`);
  if(!report.pendingPredictions.length)lines.push("| 暂无可用未结算记录 | — | — | — | — | — |");
  lines.push("",...report.limitations.map(s=>`- ${s}`));
  const name=`comparison-${generatedAt.replace(/[:.]/g,"-")}`;
  const json=JSON.stringify(report,null,2)+"\n",jsonPath=path.join(outputDir,`${name}.json`),mdPath=path.join(outputDir,`${name}.md`);
  lines.push("",`JSON SHA-256：${hash(json)}`, "");
  writeFileSync(jsonPath,json,{flag:"wx"});writeFileSync(mdPath,lines.join("\n"),{flag:"wx"});
  console.log(`有效快照：已结算 ${report.counts.settled} 条，待结算 ${report.counts.pending} 条（按玩法计）。`);
  for(const c of report.comparisons)console.log(`${labels[c.market]}：训练 ${c.training}/200，含交锋 ${c.h2hTraining}/50，评估 ${c.evaluated} 场；${c.status}`);
  console.log(`四组预测已生成 ${report.pendingPredictions.filter(p=>p.status==="experimental-not-production").length} 条；样本不足的不生成候选概率。\n报告：${mdPath}\n原始数据：${jsonPath}\n正式模型与旧盲测文件均未修改。`);
} finally {store.close();db.close();}
