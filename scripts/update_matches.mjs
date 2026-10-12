import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { findPilotReportFromOutput } from "../lib/typesafe-workflow.mjs";
import { runtimeCodeSignature, databaseIdentity } from "../lib/runtime-configuration.mjs";
import { auditPaths, recordPredictionAttempt } from "../lib/prediction-audit-store.mjs";

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const database=process.env.BETWIN_DATABASE_PATH||path.join(root,"betwin.db");
const preferredPort=Number(process.env.PORT||8765);
const verbose=process.env.BETWIN_VERBOSE==="1";
const expectedCode=runtimeCodeSignature(root),expectedDatabase=databaseIdentity(database);
const run=(command,args,{env=process.env,capture=false}={})=>new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd:root,env,stdio:capture?["ignore","pipe","pipe"]:"inherit"});
  let output="";
  if(capture){
    const collect=chunk=>{output+=chunk.toString();};
    child.stdout.on("data",collect);child.stderr.on("data",collect);
  }
  child.once("error",reject);child.once("exit",(code,signal)=>code===0?resolve(output):reject(new Error(
    `${command} 执行失败（${signal||`退出码 ${code}`}）${output.trim()?`\n${output.trim()}`:""}`)));
});
async function reachable(port){try{const r=await fetch(`http://127.0.0.1:${port}/api/runtime`,{signal:AbortSignal.timeout(1500)});if(!r.ok)return false;const {runtime}=await r.json();return runtime?.codeSignature===expectedCode&&runtime?.databaseIdentity===expectedDatabase;}catch{return false;}}
const freePort=()=>new Promise((resolve,reject)=>{const probe=createServer();probe.once("error",reject);probe.listen(0,"127.0.0.1",()=>{const port=probe.address().port;probe.close(error=>error?reject(error):resolve(port));});});
function summary(output){
  const progress=[...output.matchAll(/已读取\s+\d+\/(\d+)/g)],fixtures=Number(progress.at(-1)?.[1]||0);
  const existing=/四组预测已冻结：同一批数据不重复生成（[^，]+，(\d+)条玩法预测）/.exec(output);
  if(existing)return `比赛信息更新完成：${fixtures} 场；状态对照已有 ${existing[1]} 项，本次未重复生成。`;
  const start=output.lastIndexOf('\n{\n  "fixtures"'),end=output.lastIndexOf("\n}");
  try{
    const result=JSON.parse(output.slice(start+1,end+2));
    const skippedMatches=new Set(result.skipped.map(item=>String(item.matchId))).size;
    return `比赛信息更新完成：${result.fixtures} 场；状态对照冻结 ${result.predictions} 项${skippedMatches?`，${skippedMatches} 场资料不足已跳过`:""}。`;
  }catch{return `比赛信息更新完成${fixtures?`：${fixtures} 场`:""}。`;}
}

await run(process.env.PYTHON||"python3",["scripts/import_sqlite.py","--json-only"],{capture:!verbose});
let port=preferredPort,temporary=null,output="",predictionOutput="";
try{
  if(!await reachable(port)){
    port=await freePort();
    const env={...process.env,PORT:String(port),BETWIN_DATABASE_PATH:database};
    temporary=spawn(process.execPath,["--disable-warning=ExperimentalWarning","server.mjs"],{cwd:root,env,stdio:["ignore","pipe","pipe"]});
    const collect=chunk=>{output=(output+chunk.toString()).slice(-4000);};temporary.stdout.on("data",collect);temporary.stderr.on("data",collect);
    for(let attempt=0;attempt<100&&!await reachable(port);attempt++){
      if(temporary.exitCode!==null)break;await wait(100);
    }
    if(!await reachable(port))throw new Error(`临时预测服务启动失败。${output.trim()}`);
    if(verbose)console.log(`没有可复用的当前版本服务，已临时启动于 127.0.0.1:${port}`);
  }
  predictionOutput=await run(process.execPath,["--disable-warning=ExperimentalWarning","scripts/predict_context_pilot.mjs"],{
    env:{...process.env,PORT:String(port),BETWIN_DATABASE_PATH:database},
    capture:true,
  });
  if(verbose)process.stdout.write(predictionOutput);
  if(temporary){
    for(let attempt=0;attempt<600&&!output.includes("赛前账本：");attempt++){
      if(temporary.exitCode!==null)break;await wait(100);
    }
    if(!output.includes("赛前账本："))throw new Error(`临时服务未完成正式账本留档。${output.trim()}`);
  }
}catch(error){
  recordPredictionAttempt(auditPaths(root).outputDir,{stage:"A/B/C/D冻结",error});
  throw error;
}finally{
  if(temporary?.exitCode===null){temporary.kill("SIGTERM");await Promise.race([new Promise(resolve=>temporary.once("exit",resolve)),wait(5000)]);if(verbose)console.log("临时预测服务已关闭");}
}
let typesafeSummary="";
try {
  if(process.env.BETWIN_TYPESAFE_ENABLED==="0")typesafeSummary="TypeSafe E已关闭";
  else {
    const parent=findPilotReportFromOutput(predictionOutput,path.join(root,"data/context-pilot"));
    typesafeSummary=(await run(process.execPath,["--disable-warning=ExperimentalWarning","scripts/typesafe_pilot.mjs",`--parent=${parent}`],{capture:true})).trim();
  }
}catch(error){recordPredictionAttempt(auditPaths(root).outputDir,{stage:"E组冻结",error});typesafeSummary=`TypeSafe E未生成，原预测保留：${error.message}`;}
if(!verbose)console.log(`${summary(predictionOutput)} ${typesafeSummary}`);
else console.log(typesafeSummary);
