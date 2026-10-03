import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {writeWorkflowJson as atomic} from './workflowStorage.js';
import {emptyWorkflow,readWorkflow,saveWorkflow,publicWorkflow,createCollectionRun,applyCollectionReceipt,checkedCatalogPapers} from './collectionWorkflow.js';
import {readJournalLibrary} from './journalLibrary.js';
import {readBrowserExport,prepareBrowserImport,importBrowserExport} from './browserImport.js';
import {assertLibrary} from './libraryValidation.js';
import {enqueuePublication,readCloudQueue} from './cloudPublication.js';
import {readFieldTasks,reconcileFieldTasks} from './collectionFieldTasks.js';
import {ACTIVE_CATALOG_TASKS} from '../../tools/browser-abstract-extension/catalog-core.js';

const idOK=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
async function optional(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function createCollectionCoordinator({repositoryRoot,stateDir,config,sync,checkpoint=async()=>{},publish,checkPublication,onFailure=()=>{},prepareRun=async r=>r}){
  const root=path.join(repositoryRoot,'data/journal-store');let busy=false,lastWorkflow=null;
  const runFile=id=>{assertLibrary(idOK(id),'任务 ID 无效');return path.join(stateDir,id,'run.json');};
  async function load(id){const r=await optional(runFile(id));assertLibrary(r?.run?.id===id,'任务未找到');return r;}
  const store=r=>atomic(runFile(r.run.id),r);
  async function status(){if(!busy){const lib=await readJournalLibrary({root,config});lastWorkflow=publicWorkflow(await readWorkflow(repositoryRoot),{papers:lib.papers});}
    const workflow={...(lastWorkflow||publicWorkflow(emptyWorkflow())),field_tasks:(await readFieldTasks(repositoryRoot)).papers.filter(p=>p.status==='pending')};
    let dirs=[];try{dirs=await fs.readdir(stateDir);}catch(e){if(e.code!=='ENOENT')throw e;}
    const runs=[];for(const id of dirs.filter(idOK)){const r=await load(id);runs.push({id,mode:r.run.mode,created_at:r.run.created_at,phase:r.phase,message:r.message||'',has_export:!!r.export_hash,pending_translation_fields:r.pending_translation_fields??null,failed_stage:r.failed_stage||null});}
    return {version:2,busy,workflow,runs:runs.sort((a,b)=>b.created_at.localeCompare(a.created_at))};}
  async function exclusive(fn){assertLibrary(!busy,'另一个正式任务正在处理');busy=true;try{return await fn();}finally{busy=false;}}
  async function start(mode){return exclusive(async()=>{
    await sync();const lib=await readJournalLibrary({root,config}),baseRun=createCollectionRun(await readWorkflow(repositoryRoot),lib.papers,{mode});
    const fields=(await readFieldTasks(repositoryRoot)).papers.filter(p=>p.status==='pending'&&(mode==='full'||!p.next_retry_at||Date.parse(p.next_retry_at)<=Date.now()));
    for(const p of fields)for(const task of ACTIVE_CATALOG_TASKS.filter(t=>t.journal===p.journal))
      if(!baseRun.jobs.some(j=>j.catalog_id===task.id&&j.url===task.url))baseRun.jobs.push({catalog_id:task.id,url:task.url,signal_at:null});
    baseRun.pending_field_tasks=fields;
    baseRun.known_papers=baseRun.known_papers.map(p=>fields.some(f=>f.journal===p.journal&&f.doi===p.doi)?{...p,complete:false,next_retry_at:null}:p);
    const run=await prepareRun(baseRun);
    lastWorkflow=publicWorkflow(await readWorkflow(repositoryRoot),{papers:lib.papers});
    await store({run,phase:'collecting',message:'等待插件采集；网站提醒未清除。'});return {run};});}
  async function submit(id,data){const result=await exclusive(async()=>{
    const record=await load(id);assertLibrary(data?.workflow_run_id===id&&Array.isArray(data.catalog?.pages)&&Array.isArray(data.records),'结果不是当前批次');
    assertLibrary(data.catalog.pages.every(p=>record.run.jobs.some(j=>j.catalog_id===p.task_id)),'结果包含本批次以外目录');
    const text=JSON.stringify(data),digest=createHash('sha256').update(text+'\n').digest('hex');
    assertLibrary(Buffer.byteLength(text)<=150*1024*1024,'导出过大');
    if(record.export_hash===digest)return {phase:record.phase,duplicate:true};
    assertLibrary(record.phase!=='published','已发布批次请建立新任务');
    // Validate proof shape before accepting; formal data is not modified here.
    await prepareBrowserImport(data,config,digest,{knownPapers:(await readJournalLibrary({root,config})).papers});
    await atomic(path.join(stateDir,id,'export.json'),data);
    await store({...record,phase:'ready',export_hash:digest,message:'结果已安全保存；自动核验、去重、上传，GitHub 翻译后发布。'});
    return {phase:'ready'};});
    if(result.phase==='ready')await finish(id);
    return result;
  }
  async function checkpointCapture(id,data){
    const result=await exclusive(async()=>{
      const parent=await load(id);
      assertLibrary(data?.workflow_run_id===id&&Array.isArray(data.catalog?.pages)&&Array.isArray(data.records),'增量结果不是当前采集任务');
      assertLibrary(data.catalog.pages.every(p=>parent.run.jobs.some(j=>j.catalog_id===p.task_id)),'增量结果超出目录范围');
      // A stable content ID ignores wall-clock export time and never freezes the
      // parent capture. Later partial results become independent publication jobs.
      const material={records:data.records,catalog:data.catalog,ai_review_results:data.ai_review_results||{},catalog_review_results:data.catalog_review_results||{}};
      const fingerprint=createHash('sha256').update(JSON.stringify(material)).digest('hex');
      const key=createHash('sha256').update(id+fingerprint).digest('hex'),batchId=[key.slice(0,8),key.slice(8,12),key.slice(12,16),key.slice(16,20),key.slice(20,32)].join('-');
      const old=await optional(runFile(batchId));if(old)return {id:batchId,phase:old.phase,duplicate:true};
      const exportData={...data,workflow_run_id:batchId,parent_run_id:id};
      const text=JSON.stringify(exportData),digest=createHash('sha256').update(text+'\n').digest('hex');
      assertLibrary(Buffer.byteLength(text)<=150*1024*1024,'增量导出过大');
      await prepareBrowserImport(exportData,config,digest,{knownPapers:(await readJournalLibrary({root,config})).papers});
      await atomic(path.join(stateDir,batchId,'export.json'),exportData);
      await store({run:{...parent.run,id:batchId,parent_run_id:id},phase:'ready',export_hash:digest,message:'已保存本次取得的内容；独立核验、上传和发布。'});
      return {id:batchId,phase:'ready'};
    });
    if(result.phase==='ready')await finish(result.id);
    return result;
  }
  async function finish(id){
    assertLibrary(!busy,'另一个正式任务正在处理');busy=true;let record;
    try{record=await load(id);assertLibrary(record.export_hash,'尚无采集结果');}
    catch(e){busy=false;throw e;}
    if(['published','awaiting_publication'].includes(record.phase)){busy=false;return {phase:record.phase};}
    const advance=async(phase,message)=>{record.phase=phase;record.message=message;await store(record);};
    // Local work contains no translator. Submission and restart are idempotent;
    // only GitHub may issue translation requests using its durable ledger.
    void (async()=>{try{
      await advance('syncing','正在同步远端正式库。');await sync();
      const input=await readBrowserExport(path.join(stateDir,id,'export.json'));
      assertLibrary(input.sha256===record.export_hash,'导出文件校验失败');
      const prepared=await prepareBrowserImport(input.data,config,input.sha256,{knownPapers:(await readJournalLibrary({root,config})).papers});
      await advance('importing','按原始证据核验并合并；已有内容不覆盖。');
      const imported=await importBrowserExport(config,{root,prepared,save:true});
      record.import_stats=imported.stats;await store(record);
      const captured=await checkedCatalogPapers(input.data),current=await readJournalLibrary({root,config});
      const accepted=imported.decisions.filter(d=>['added','abstract_filled','metadata_filled','unchanged'].includes(d.action));
      const paperIds=record.paper_ids||current.papers.filter(p=>accepted.some(d=>p.journal_key===d.journal_key&&(d.doi?p.doi===d.doi:p.title_original===d.title))||
        captured.some(c=>c.review_status==='source_checked_candidate'&&c.journal===p.journal_key&&(c.doi?c.doi===p.doi:c.title===p.title_original))).map(p=>p.id);
      record.paper_ids=paperIds;await store(record);
      await advance('receipting','保存目录回执和未完成论文清单。');
      const lib=await readJournalLibrary({root,config});
      await reconcileFieldTasks(repositoryRoot,lib.papers,{paperIds,branch:input.data.collector==='local_python'?'python':'plugin'});
      const state=await applyCollectionReceipt(await readWorkflow(repositoryRoot),record.run,input.data,prepared,lib);
      const oldCloud=(await readCloudQueue(repositoryRoot)).requests.find(r=>r.id===id);
      record.publication_id=oldCloud?.publication_id||randomUUID();
      const receipt=state.receipts.find(r=>r.id===record.run.id);
      receipt.publication_id=record.publication_id;
      receipt.pending_translation_fields=null;receipt.translation_status='pending';
      await saveWorkflow(repositoryRoot,state);
      await enqueuePublication(repositoryRoot,{id,inputHash:record.export_hash,publicationId:record.publication_id,paperIds,maxRequests:record.run.max_requests});
      await advance('uploading','上传核验后的论文和翻译任务；原始浏览器抓取文件仅留本机。');await checkpoint({root});
      await advance('publishing','正在请求 GitHub 翻译并发布。');record.release=await publish({root,id});
      record.failed_stage=null;record.retry_at=null;record.dispatch_at=new Date().toISOString();
      await advance('awaiting_publication','已上传 GitHub，正在云端翻译 / 发布；将自动核验网站回执。可以关闭面板。');
    }catch(error){onFailure(error);record.failed_stage=record.phase;record.retry_at=new Date(Date.now()+60000).toISOString();
      record.failures=(record.failures||0)+1;
      await advance('failed',`处理暂停于 ${record.failed_stage}；结果保留。${record.failures<5?'服务将自动恢复。':'连续失败，需检查本地 Git / 网络；不会丢弃结果或重发未知计费请求。'}`).catch(()=>{});}
    finally{busy=false;}})();return {phase:'processing'};
  }
  async function check(id){return exclusive(async()=>{const r=await load(id);
    assertLibrary(['awaiting_publication','published'].includes(r.phase),'尚未提交发布');
    const result=await checkPublication(id,r.export_hash,r.publication_id);
    if(result===true||result?.published){r.phase='published';r.pending_translation_fields=result.pending_translation_fields??null;
      r.message='网站已核验本批次发布回执。'+(result.translation_status==='attention'?'部分翻译需要检查；已完成内容已上线。':result.translation_status==='pending'?'部分翻译在 GitHub 等待续跑。':'')+' 未完成目录和论文仍保留。';await store(r);}
    return {phase:r.phase};});}
  async function pulse(){
    if(busy)return;
    const s=await status();
    for(const r of s.runs){
      if(busy)return;const record=await load(r.id);
      if(r.phase==='awaiting_publication'){
        try{await check(r.id);}catch{/* Offline verification does not mean publication failed. */}
        if((await load(r.id)).phase==='awaiting_publication'&&Date.now()-Date.parse(record.dispatch_at||0)>30*60000){
          try{await publish({root,id:r.id});record.dispatch_at=new Date().toISOString();await store(record);}catch{}
        }
      }else if(r.has_export&&r.phase!=='published'&&(record.failures||0)<5&&(!record.retry_at||Date.parse(record.retry_at)<=Date.now())){
        await finish(r.id);return;
      }
    }
  }
  return {status,start,submit,checkpointCapture,finish,check,pulse,run:async id=>({run:(await load(id)).run}),sync:()=>exclusive(sync)};
}

/** Fixed-origin loopback bridge. No credential, filesystem path, command or
 * arbitrary URL is accepted from the browser. OPTIONS requires the same origin. */
export function collectionHttpServer(coordinator,{extensionId,port=17328}){
  assertLibrary(/^[a-p]{32}$/.test(extensionId),'扩展 ID 无效');
  const origin=`chrome-extension://${extensionId}`;
  return http.createServer(async(req,res)=>{
    const reply=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
      'Access-Control-Allow-Origin':origin,'Vary':'Origin'});res.end(JSON.stringify(data));};
    if(req.headers.host!==`127.0.0.1:${port}`||req.headers.origin!==origin){reply(403,{message:'本地正式流程拒绝此来源'});req.resume();return;}
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, POST',
      'Access-Control-Allow-Headers':'Content-Type, X-Paper-Workflow'});res.end();return;}
    if(req.headers['x-paper-workflow']!=='1'){reply(403,{message:'请求校验失败'});req.resume();return;}
    // Liveness must not read the library, sync Git or create paid work.
    if(['GET','POST'].includes(req.method)&&req.url==='/health'){
      req.resume();reply(200,{service:'paper-daily-workflow',status:'ready',version:2});return;
    }
    try {
      if(req.method==='GET'&&req.url==='/status'){reply(200,await coordinator.status());return;}
      assertLibrary(req.method==='POST'&&['/status','/start','/run','/submit','/checkpoint','/finish','/sync','/check-publication','/python/start','/python/pause','/python/resume','/python/fallback'].includes(req.url),'请求不支持');
      assertLibrary(req.headers['content-type']==='application/json','请求格式不支持');
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;assertLibrary(size<=(['/submit','/checkpoint'].includes(req.url)?150*1024*1024:16384),'请求过大');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(req.url==='/status'){reply(200,await coordinator.status());return;}
      if(req.url.startsWith('/python/')){assertLibrary(coordinator.python,'本地 Python 尚未配置');reply(200,await coordinator.python[req.url.split('/')[2]](body));return;}
      if(req.url==='/checkpoint'){reply(200,await coordinator.checkpointCapture(body.id,body.data));return;}
      const result=req.url==='/run'?await coordinator.run(body.id):req.url==='/start'?await coordinator.start(body.mode):req.url==='/submit'?await coordinator.submit(body.id,body.data):
        req.url==='/finish'?await coordinator.finish(body.id):req.url==='/check-publication'?await coordinator.check(body.id):await coordinator.sync();
      reply(200,result||{ok:true});
    }catch{reply(409,{message:'正式流程未完成请求；保留原有数据。请确认没有其他任务运行、任务 ID 正确且 Git 同步可用。'});}
  });
}
