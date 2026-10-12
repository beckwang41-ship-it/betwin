import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataStore } from "../lib/database.mjs";
import { predictFormPoisson, trialSelection, FORM_POISSON_TRIAL_VERSION } from "../lib/form-poisson-trial.mjs";

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const database=process.env.BETWIN_DATABASE_PATH || path.join(root,"betwin.db");
const origin=`http://127.0.0.1:${process.env.PORT || 8765}`;
const expectedCount=Number(process.env.BETWIN_TRIAL_EXPECTED_COUNT || 24);
const trialMode=process.env.BETWIN_TRIAL_MODE || "post-event";
if (!Number.isInteger(expectedCount) || expectedCount<1 || !["post-event","current"].includes(trialMode)) {
  throw new Error("盲测参数无效：场数必须为正整数，模式必须是post-event或current");
}
const timingNote=trialMode==="post-event"
  ? "用户说明比赛已结束，本次未查询赛果；不计为真正赛前验证。"
  : "当前批次赛果尚未导入，本次未查询赛果；未核验精确开赛时间。";
const db=new DatabaseSync(database,{readOnly:true}), store=createDataStore(database);
const hash=value=>createHash("sha256").update(value).digest("hex");
const startedAt=new Date().toISOString();
const sources=()=>db.prepare("SELECT * FROM source_files ORDER BY file_name").all();
const inputs=sources(), inputHash=hash(JSON.stringify(inputs));
const matches=store.getMatches();
const rows=[];
try {
  if(matches.length!==expectedCount) throw new Error(`预期本次${expectedCount}场，数据库实际${matches.length}场，停止以免纳入其他批次`);
  if (trialMode==="current") {
    const settled=db.prepare("SELECT COUNT(*) AS n FROM prediction_ledger WHERE match_id=? AND status='settled' AND valid=1");
    if(matches.some(m=>settled.get(m.id).n>0)) throw new Error("当前批次已含结算记录，不作为未结算批次冻结");
  }
  for(const match of matches) {
    const params=new URLSearchParams({matchId:match.id,sameLeague:"false"});
    const response=await fetch(`${origin}/api/predict?${params}`);
    if(!response.ok)throw new Error(`${match.id}: HTTP ${response.status}`);
    const payload=await response.json();
    if(payload.match?.id!==match.id || ["had","hhad","goals"].some(k=>JSON.stringify(payload.match[k])!==JSON.stringify(match[k])) || JSON.stringify(payload.recentForm)!==JSON.stringify(store.getRecentForm(match))) {
      throw new Error(`${match.id} 服务和数据库数据不一致`);
    }
    const baseline=Object.fromEntries(["spf","hhad","goals"].map(market=>[market,
      payload[market]?.available===false?null:trialSelection(payload[market]?.final,market)]));
    rows.push({matchId:match.id,league:match.league,home:match.home,away:match.away,
      handicap:match.hhad?.goalLine ?? null, odds:{spf:match.had,hhad:match.hhad,goals:match.goals},
      settings:payload.settings,recentForm:payload.recentForm,baseline,
      formOnly:predictFormPoisson(payload.recentForm,match.hhad?.goalLine),actualResult:null});
    console.log(`已计算 ${rows.length}/${expectedCount}：${match.home} vs ${match.away}`);
  }
  if(hash(JSON.stringify(sources()))!==inputHash)throw new Error("计算期间源数据发生更新，停止冻结混合批次");
  const report={version:"current-matches-unseen-results-trial-v2",startedAt,frozenAt:new Date().toISOString(),
    evaluationType:trialMode==="post-event"?"post-event-results-not-consulted":"current-unsettled-results-not-consulted",
    genuinePrematchValidation:trialMode==="post-event"?false:null,timingNote,
    baseline:"当前正式赔率历史模型，全部联赛、默认生产参数，仅GET读取",
    candidate:FORM_POISSON_TRIAL_VERSION,
    rules:["实验主队进球均值=(主队近5场场均进球+客队近5场场均失球)/2；客队对称计算。",
      "每队至少3场有效比分，使用当前文件可用的至多5场；独立泊松比分分布同时计算胜平负、让球和0至7+球。",
      "实验版不使用赔率、交锋、10场汇总，不手工混合两模型；未校正对手强弱与杯赛差异。",
      "单选取概率最大项，进球双选取概率最高两档，不强制相邻；完全并列按标签索引顺序固定选择。",
      "只评价两模型均有预测的同一批比赛；缺失赛果保留待核对；主指标为进球双选命中率，另报胜平负、让球和概率误差。",
      `${timingNote}本次不导入新数据、不改正式概率；本批次不用于调参后重报成绩。`,
      "结果更新后只结算本文件冻结的选择，不重新调用预测覆盖；不能据单批小样本认定长期提升或盈利。"],
    inputHash,sources:inputs,
    codeHashes:Object.fromEntries(["server.mjs","lib/form-poisson-trial.mjs","lib/recent-form.mjs","lib/predictor.mjs","lib/goal-zero-odds.mjs"].map(f=>[f,hash(readFileSync(path.join(root,f)))])),
    fixtures:rows};
  const dir=path.join(root,"data","prediction-trials");mkdirSync(dir,{recursive:true});
  const name=`blind-${expectedCount}-${startedAt.replace(/[:.]/g,"-")}`;
  const json=JSON.stringify(report,null,2)+"\n";
  const percent=p=>`${(p*100).toFixed(1)}%`;
  const single=m=>m?`${m.single.label} ${percent(m.single.probability)}${m.tiedTop.length>1?"（并列）":""}`:"—";
  const pair=m=>m?.pair?`${m.pair.labels.join("/")}球 ${percent(m.pair.coverage)}`:"—";
  const md=[`# ${expectedCount}场固定预测对照`, "",`冻结时间：${report.frozenAt}。${timingNote}`,"",
    "A：现有赔率模型。B：近期进失球独立泊松实验；尚未训练或验证，不替换正式模型。", "",
    ...report.rules.map(r=>`- ${r}`), "", `JSON SHA-256：${hash(json)}`, "",
    "| ID | 对阵 | 主队让球 | A 胜平负 | B 胜平负 | A 让球 | B 让球 | A 进球双选 | B 进球双选 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map(r=>`| ${r.matchId} | ${r.home} vs ${r.away} | ${r.handicap ?? "—"} | ${single(r.baseline.spf)} | ${single(r.formOnly.spf)} | ${single(r.baseline.hhad)} | ${single(r.formOnly.hhad)} | ${pair(r.baseline.goals)} | ${pair(r.formOnly.goals)} |`),""].join("\n");
  const jsonPath=path.join(dir,`${name}.json`), mdPath=path.join(dir,`${name}.md`);
  writeFileSync(jsonPath,json,{flag:"wx"});writeFileSync(mdPath,md,{flag:"wx"});
  console.log(JSON.stringify({json:jsonPath,markdown:mdPath,sha256:hash(json),fixtures:rows.length,
    experimentAvailable:rows.filter(r=>r.formOnly.available).length,
    changedGoalPairs:rows.filter(r=>r.formOnly.goals && r.baseline.goals && [...r.formOnly.goals.pair.indices].sort().join()!==[...r.baseline.goals.pair.indices].sort().join()).length},null,2));
} finally {store.close();db.close();}
