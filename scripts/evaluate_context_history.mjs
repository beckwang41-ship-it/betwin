import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync,writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateContextHistory,CONTEXT_HISTORY_PROTOCOL } from "../lib/context-history-evaluation.mjs";

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),database=process.env.BETWIN_DATABASE_PATH||path.join(root,"betwin.db");
const jsonPath=path.join(root,"data","context-history-report.json"),mdPath=path.join(root,"data","context-history-report.md");
const hash=value=>createHash("sha256").update(value).digest("hex"),db=new DatabaseSync(database,{readOnly:true});
try{
 const records=db.prepare("SELECT * FROM prediction_ledger WHERE market IN ('spf','hhad','goals') ORDER BY captured_at,id").all();
 const report=evaluateContextHistory(records),sources=db.prepare("SELECT * FROM source_files ORDER BY file_name").all();
 Object.assign(report,{sourceHash:hash(JSON.stringify(sources)),sources,ledgerHash:hash(JSON.stringify(records)),
  codeHashes:Object.fromEntries(["lib/context-features.mjs","lib/context-pilot.mjs","lib/context-history-evaluation.mjs","lib/context-experiment.mjs"].map(f=>[f,hash(readFileSync(path.join(root,f)))]))});
 const json=JSON.stringify(report,null,2)+"\n",pct=v=>v==null?"—":`${(v*100).toFixed(1)}%`,number=v=>v==null?"—":v.toFixed(4);
 const labels={spf:"胜平负",hhad:"让球胜平负",goals:"总进球"},lines=["# 近期状态与历史交锋时间顺序回放","",`生成时间：${report.generatedAt}`,"",...report.limitations.map(x=>`- ${x}`),"",
  "| 玩法 | 组别 | 回放场次 | 单选命中率 | 进球双选 | LogLoss↓ | Brier↓ |", "|---|---|---:|---:|---:|---:|---:|"];
 for(const c of report.comparisons)for(const [arm,m] of Object.entries(c.metrics))lines.push(`| ${labels[c.market]} | ${arm} ${report.arms[arm]} | ${m?.samples||0} | ${pct(m?.accuracy)} | ${pct(m?.pairHitRate)} | ${number(m?.logLoss)} | ${number(m?.brier)} |`);
 lines.push("","## 相对A的成对时间块检验","","正值表示候选更好；区间跨0表示目前不能排除随机波动。","",
  "| 玩法 | 候选 | 命中率差（95%区间） | LogLoss改善（95%区间） | Brier改善（95%区间） | 双选差（95%区间） |","|---|---|---|---|---|---|");
 const interval=x=>x?`${pct(x.mean)} [${pct(x.lower)}, ${pct(x.upper)}] ${x.status}`:"—";
 for(const c of report.comparisons)for(const arm of ["B","C","D"]){const p=c.pairedVsA[arm];lines.push(`| ${labels[c.market]} | ${arm} ${report.arms[arm]} | ${interval(p.accuracy)} | ${interval(p.logLoss)} | ${interval(p.brier)} | ${interval(p.pairHit)} |`);}
 lines.push("",`协议：${CONTEXT_HISTORY_PROTOCOL.version}`,`JSON SHA-256：${hash(json)}`,"");
 writeFileSync(jsonPath,json);writeFileSync(mdPath,lines.join("\n"));
 console.log(JSON.stringify({jsonPath,mdPath,sha256:hash(json),comparisons:report.comparisons.map(c=>({market:c.market,available:c.availableSettled,evaluated:c.evaluated,metrics:c.metrics,pairedVsA:c.pairedVsA}))},null,2));
}finally{db.close();}
