import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeWorkflowJson as atomic} from './workflowStorage.js';
import {assertLibrary} from './libraryValidation.js';
import {readJournalLibrary} from './journalLibrary.js';
import {ACTIVE_CATALOG_TASKS,articleUrl} from '../../tools/browser-abstract-extension/catalog-core.js';
import {ALLOWED_HOSTS} from '../../tools/browser-abstract-extension/core.js';
import {readCatalogDocument} from '../../tools/browser-abstract-extension/catalog-extractor.js';
import {readArticleDocument} from '../../tools/browser-abstract-extension/extractor.js';
import {makeReviewJobs,reviewedArticleRecords} from '../../tools/browser-abstract-extension/review-core.js';
import {prepareReviewPlan,canRetryReview} from '../../tools/browser-abstract-extension/review-client.js';
import {verifiedPages} from './browserImport.js';
import {catalogRepairJobs} from '../../tools/browser-abstract-extension/catalog-engine.js';
import {reviewJob} from './sourceReview.js';
import {normalizeOupControlLabel} from '../../tools/local-collector/workflow-compat.mjs';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function json(file,fallback=null){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export async function findLocalPython(repo,env=process.env){
  const candidates=[env.PAPER_PYTHON_EXECUTABLE,env.LOCALAPPDATA&&path.join(env.LOCALAPPDATA,'PaperDailyWorkflow/python/Scripts/python.exe'),
    path.join(repo,'data/selenium-pilot/venv/Scripts/python.exe'),path.resolve(repo,'../selenium-pilot/venv/Scripts/python.exe')].filter(Boolean);
  for(const file of candidates)try{if((await fs.stat(file)).isFile())return file;}catch{}
  return null;
}
export function localReviewRequest(extensionId,{fetchImpl=fetch}={}){
  assertLibrary(/^[a-p]{32}$/.test(extensionId),'扩展身份无效');
  return async(input,{retryAttempt}={})=>{
    const response=await fetchImpl('http://127.0.0.1:17327/review',{method:'POST',
      headers:{Origin:`chrome-extension://${extensionId}`,'Content-Type':'application/json','X-Paper-Review':'1',...(retryAttempt?{'X-Paper-Retry':String(retryAttempt)}:{})},
      body:JSON.stringify(input),signal:AbortSignal.timeout(70000)});
    if(!response.ok)throw Error(response.status===409?'REVIEW_BUSY':response.status===429?'REVIEW_LIMIT':'REVIEW_SERVICE_UNAVAILABLE');
    return response.json();
  };
}
export function createLocalCollector({repositoryRoot,stateDir,config,coordinator,requestReview,pythonExecutable,spawnImpl=spawn}){
  const base=path.join(stateDir,'python'),indexFile=path.join(base,'active.json');let child=null,processing=false,starting=false;
  const directory=id=>{assertLibrary(/^[a-f0-9-]{36}$/.test(id),'Python 任务 ID 无效');return path.join(base,id);};
  async function current(){const index=await json(indexFile);return index?.id?{id:index.id,dir:directory(index.id)}:null;}
  async function status(){
    const c=await current();if(!c)return {available:!!pythonExecutable,phase:'idle',running:false};
    const state=await json(path.join(c.dir,'state.json'),{phase:'starting',queue:[],items:[],cursor:0});
    const review=await json(path.join(c.dir,'review-status.json'),{});
    return {available:!!pythonExecutable,id:c.id,phase:child?state.phase:['starting','running'].includes(state.phase)?'interrupted':state.phase,
      running:!!child,reviewing:processing,current:state.current||null,completed:state.cursor||0,total:state.queue?.length||0,
      remaining:state.remaining?.length||0,...review};
  }
  async function launch(c){
    assertLibrary(pythonExecutable,'Python 环境尚未配置');assertLibrary(!child,'Python 已在运行');
    await atomic(path.join(c.dir,'control.json'),{pause:false});
    const out=await fs.open(path.join(c.dir,'worker.log'),'a');
    const env={...process.env,PYTHONUTF8:'1'};delete env.DEEPSEEK_API_KEY;delete env.SEMANTIC_SCHOLAR_API_KEY;
    try{
      child=spawnImpl(pythonExecutable,['-X','utf8',path.join(repositoryRoot,'tools/local-collector/worker.py'),
        '--plan',path.join(c.dir,'plan.json'),'--state',path.join(c.dir,'state.json'),'--control',path.join(c.dir,'control.json'),
        '--profile',path.join(base,'browser-profile'),'--node',process.execPath],{cwd:repositoryRoot,env,windowsHide:true,stdio:['ignore',out.fd,out.fd]});
      const owned=child;child.on('error',()=>{if(child===owned)child=null;});child.on('exit',()=>{if(child===owned)child=null;});
    }finally{await out.close();}
  }
  async function start({mode='daily'}={}){
    assertLibrary(!starting&&!child,'已有 Python 任务正在启动或运行');starting=true;
    try{
      const old=await status();assertLibrary(!old.id||['captured','idle'].includes(old.phase),'请先继续或处理现有 Python 任务');
      const {run}=await coordinator.start(mode),dir=directory(run.id);await fs.mkdir(dir,{recursive:true});
      const library=await readJournalLibrary({root:path.join(repositoryRoot,'data/journal-store'),config});
      const pending=run.pending_field_tasks||[];
      const known=run.known_papers;
      const jobs=run.jobs.filter(j=>!run.direct_pages?.some(p=>p.task_id===j.catalog_id&&p.requested_url===j.url))
        .map(j=>({kind:'catalog',catalog_id:j.catalog_id,journal:ACTIVE_CATALOG_TASKS.find(t=>t.id===j.catalog_id).journal,url:j.url,depth:0}));
      for(const page of run.direct_pages||[])for(const p of page.items||[]){
        if(p.doi&&p.type!=='other')jobs.push({kind:'article',catalog_id:page.task_id,journal:page.journal,doi:p.doi,title:p.title,url:p.url});
      }
      // Previously reviewed metadata may exist before any directory succeeds.
      // Revisit its actual publisher URL independently when it is available.
      for(const job of pending){
        const p=library.papers.find(p=>p.id===job.id);
        if(!p)continue;
        for(const task of ACTIVE_CATALOG_TASKS.filter(t=>t.journal===p.journal_key)){
          const url=[p.url,...p.source_records.map(r=>r.url)].find(u=>articleUrl(u,task));
          if(url){jobs.push({kind:'article',catalog_id:task.id,journal:p.journal_key,doi:p.doi,title:p.title_original,url});break;}
        }
      }
      await atomic(path.join(dir,'plan.json'),{version:1,run_id:run.id,interval_seconds:3,settle_seconds:3,max_catalog_pages:50,
        allowed_hosts:[...ALLOWED_HOSTS],known_papers:known,jobs,scripts:{catalog:`return (${readCatalogDocument.toString()})();`,article:`return (${readArticleDocument.toString()})();`}});
      await atomic(path.join(dir,'run.json'),run);await atomic(indexFile,{id:run.id});await launch({id:run.id,dir});return status();
    }finally{starting=false;}
  }
  async function pause(){const c=await current();assertLibrary(c,'没有 Python 任务');await atomic(path.join(c.dir,'control.json'),{pause:true});return {phase:'pausing'};}
  async function resume(){assertLibrary(!starting&&!child,'任务尚未暂停');starting=true;
    try{const c=await current();assertLibrary(c,'没有 Python 任务');await launch(c);return status();}finally{starting=false;}}
  async function snapshot(c){
    const run=await json(path.join(c.dir,'run.json')),state=await json(path.join(c.dir,'state.json'),{items:[],queue:[],cursor:0});
    const pages=structuredClone(run.direct_pages||[]),records=[],captures=[];
    for(const row of state.items||[]){
      assertLibrary(/^[a-f0-9]{64}$/.test(row.key)&&row.file==='captures/'+row.key+'.json','采集文件引用无效');
      const capture=await json(path.join(c.dir,row.file));if(!capture)continue;captures.push(capture);
      if(row.kind==='catalog'&&capture.result?.task_id){const old=pages.findIndex(p=>p.task_id===capture.result.task_id&&p.requested_url===capture.result.requested_url);
        if(old>=0)pages[old]=capture.result;else pages.push(capture.result);}
      else if(row.kind==='article')records.push({...capture.task,...capture.result});
    }
    for(const record of records){const capture=captures.find(x=>x.task.kind==='article'&&x.task.doi===record.doi)?.capture;
      if(capture)normalizeOupControlLabel(record,pages,capture);}
    const capturedQueue=pages.map(p=>({task_id:p.task_id,url:p.requested_url||p.source_url,depth:0}));
    const pendingQueue=state.queue.filter(t=>t.kind==='catalog'&&!pages.some(p=>p.task_id===t.catalog_id&&p.requested_url===t.url))
      .map(t=>({task_id:t.catalog_id,url:t.url,depth:t.depth||0}));
    const catalog={schema_version:1,run_started_at:run.created_at,scope_task_ids:run.jobs.map(j=>j.catalog_id),pages,
      queue:[...capturedQueue,...pendingQueue],cursor:capturedQueue.length,history:[],mode:'paused'};
    return {run,state,data:{kind:'paper_project',workflow_run_id:c.id,collector:'local_python',records,catalog,
      ai_review_results:{},catalog_review_results:{}}};
  }
  async function reviewCapture(c){
    try{
      const {data}=await snapshot(c),cache=await json(path.join(c.dir,'reviews.json'),{});
      const plan=await prepareReviewPlan(makeReviewJobs({pages:verifiedPages(data)},data),cache);
      let processed=0,reviewError=null;
      for(const job of [...plan.jobs].sort((a,b)=>Number(b.input.kind==='article')-Number(a.input.kind==='article'))){
        if(cache[job.hash]&&!canRetryReview(cache[job.hash])||processed>=3)continue;
        try{const {result}=await reviewJob(job.input,requestReview,{cached:cache[job.hash],retry:true});cache[job.hash]=result;processed++;
          await atomic(path.join(c.dir,'reviews.json'),cache);}
        catch(e){reviewError=['REVIEW_BUSY','REVIEW_LIMIT','REVIEW_SERVICE_UNAVAILABLE'].includes(e.message)?e.message:'REVIEW_SERVICE_UNAVAILABLE';break;}
      }
      for(const job of plan.jobs)if(cache[job.hash])(job.input.kind==='catalog'?data.catalog_review_results:data.ai_review_results)[job.hash]=cache[job.hash];
      const reviewed=await reviewedArticleRecords(data,plan,cache);
      const ready=new Set(reviewed.filter(r=>['source_checked_candidate','needs_attention'].includes(r.review_status)).map(r=>r.doi));
      data.records=data.records.filter(r=>ready.has(r.doi));
      const fingerprint=digest(data),last=await json(path.join(c.dir,'submitted.json'));
      const settled=plan.jobs.every(j=>cache[j.hash]&&!canRetryReview(cache[j.hash]));
      if(last?.fingerprint!==fingerprint&&(settled||!last?.at||Date.now()-Date.parse(last.at)>=120000)&&Object.values(cache).some(r=>r.verdict?.status==='source_checked_candidate')){
        try{await coordinator.checkpointCapture(c.id,data);await atomic(path.join(c.dir,'submitted.json'),{fingerprint,at:new Date().toISOString()});}catch{/* Another writer is publishing; retry saved proof on the next pulse. */}
      }
      await atomic(path.join(c.dir,'review-status.json'),{review_total:plan.jobs.length,review_done:plan.jobs.filter(j=>cache[j.hash]?.verdict?.status==='source_checked_candidate').length,
        review_pending:plan.jobs.filter(j=>!cache[j.hash]).length,review_attention:plan.jobs.filter(j=>cache[j.hash]?.error).length,review_error:reviewError,review_service_ready:!reviewError});
    }finally{}
  }
  async function pulse(){
    if(processing||starting)return;processing=true;
    try{
      const active=await current();if(!active)return;
      const others=(await fs.readdir(base)).filter(id=>/^[a-f0-9-]{36}$/.test(id)&&id!==active.id);
      // A new capture run must not strand the review queue of an older run.
      for(const c of [active,...others.map(id=>({id,dir:directory(id)}))])await reviewCapture(c);
    }finally{processing=false;}
  }
  async function fallback(){
    const c=await current();assertLibrary(c&&!child,'请先暂停本地 Python');
    const {run,data}=await snapshot(c),results=await json(path.join(c.dir,'reviews.json'),{});
    const latest=(await coordinator.status()).workflow;
    const known=latest.known_papers.map(p=>latest.field_tasks.some(f=>f.journal===p.journal&&f.doi&&f.doi===p.doi)?{...p,complete:false,next_retry_at:null}:p);
    const catalog={...data.catalog,queue:catalogRepairJobs(data.catalog),cursor:0,reason:'继续处理 Python 剩余目录；已有证据与核对结果保留。'};
    return {run:{...run,known_papers:known,browser_snapshot:{catalog,records:data.records,review_results:results},catalog_review_results:results}};
  }
  return {start,pause,resume,fallback,status,pulse,snapshot,current};
}
