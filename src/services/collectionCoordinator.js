import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {writeWorkflowJson as atomic} from './workflowStorage.js';
import {emptyWorkflow,readWorkflow,saveWorkflow,publicWorkflow,createCollectionRun,applyCollectionReceipt,checkedCatalogPapers} from './collectionWorkflow.js';
import {readJournalLibrary} from './journalLibrary.js';
import {readBrowserExport,prepareBrowserImport,importBrowserExport} from './browserImport.js';
import {assertLibrary} from './libraryValidation.js';

const idOK=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
async function optional(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function createCollectionCoordinator({repositoryRoot,stateDir,config,sync,checkpoint=async()=>{},translate,build,publish,checkPublication,onFailure=()=>{}}){
  const root=path.join(repositoryRoot,'data/journal-store');let busy=false,lastWorkflow=null;
  const runFile=id=>{assertLibrary(idOK(id),'任务 ID 无效');return path.join(stateDir,id,'run.json');};
  async function load(id){const r=await optional(runFile(id));assertLibrary(r?.run?.id===id,'任务未找到');return r;}
  const store=r=>atomic(runFile(r.run.id),r);
  async function status(){if(!busy){const lib=await readJournalLibrary({root,config});lastWorkflow=publicWorkflow(await readWorkflow(repositoryRoot),{papers:lib.papers});}
    const workflow=lastWorkflow||publicWorkflow(emptyWorkflow());
    let dirs=[];try{dirs=await fs.readdir(stateDir);}catch(e){if(e.code!=='ENOENT')throw e;}
    const runs=[];for(const id of dirs.filter(idOK)){const r=await load(id);runs.push({id,mode:r.run.mode,created_at:r.run.created_at,phase:r.phase,message:r.message||'',has_export:!!r.export_hash,pending_translation_fields:r.pending_translation_fields||0});}
    return {busy,workflow,runs:runs.sort((a,b)=>b.created_at.localeCompare(a.created_at))};}
  async function exclusive(fn){assertLibrary(!busy,'另一个正式任务正在处理');busy=true;try{return await fn();}finally{busy=false;}}
  async function start(mode){return exclusive(async()=>{
    await sync();const lib=await readJournalLibrary({root,config}),run=createCollectionRun(await readWorkflow(repositoryRoot),lib.papers,{mode});
    lastWorkflow=publicWorkflow(await readWorkflow(repositoryRoot),{papers:lib.papers});
    await store({run,phase:'collecting',message:'等待插件采集；网站提醒未清除。'});return {run};});}
  async function submit(id,data){return exclusive(async()=>{
    const record=await load(id);assertLibrary(data?.workflow_run_id===id&&Array.isArray(data.catalog?.pages)&&Array.isArray(data.records),'结果不是当前批次');
    assertLibrary(data.catalog.pages.every(p=>record.run.jobs.some(j=>j.catalog_id===p.task_id)),'结果包含本批次以外目录');
    const text=JSON.stringify(data),digest=createHash('sha256').update(text+'\n').digest('hex');
    assertLibrary(Buffer.byteLength(text)<=150*1024*1024,'导出过大');
    if(record.export_hash===digest)return {phase:record.phase,duplicate:true};
    assertLibrary(record.phase!=='published','已发布批次请建立新任务');
    // Validate proof shape before accepting; formal data is not modified here.
    await prepareBrowserImport(data,config,digest);
    await atomic(path.join(stateDir,id,'export.json'),data);
    await store({...record,phase:'ready',export_hash:digest,message:'结果已保存；等待明确执行导入、翻译并发布。'});
    return {phase:'ready'};});}
  async function finish(id){
    assertLibrary(!busy,'另一个正式任务正在处理');busy=true;let record;
    try{record=await load(id);assertLibrary(record.export_hash,'尚无采集结果');}
    catch(e){busy=false;throw e;}
    if(record.phase==='published'&&!record.pending_translation_fields){busy=false;return {phase:'published'};}
    const advance=async(phase,message)=>{record.phase=phase;record.message=message;await store(record);};
    // Durable phases survive closing the browser. A service restart never
    // automatically resumes paid calls; the user explicitly clicks Finish.
    void (async()=>{try{
      await advance('syncing','正在同步远端正式库。');await sync();
      const input=await readBrowserExport(path.join(stateDir,id,'export.json'));
      assertLibrary(input.sha256===record.export_hash,'导出文件校验失败');
      const prepared=await prepareBrowserImport(input.data,config,input.sha256);
      await advance('importing','按原始证据核验并合并；已有内容不覆盖。');
      const imported=await importBrowserExport(config,{root,prepared,save:true});
      record.import_stats=imported.stats;await store(record);
      await checkpoint({root});
      await advance('translating','仅翻译本批次新增或缺失字段；失败不删除已导入论文。');
      const captured=await checkedCatalogPapers(input.data),current=await readJournalLibrary({root,config});
      const paperIds=[...new Set([...imported.decisions.filter(d=>['added','abstract_filled','unchanged'].includes(d.action)).map(d=>'doi:'+d.doi),
        ...captured.filter(p=>p.review_status==='source_checked_candidate'&&current.papers.some(x=>x.doi===p.doi&&x.journal_key===p.journal)).map(p=>'doi:'+p.doi)])];
      record.translation=await translate({root,paperIds,maxRequests:record.run.max_requests});
      record.pending_translation_fields=(record.translation.available_fields||0)+(record.translation.held_fields||0);
      await advance('receipting','保存目录回执和未完成论文清单。');
      const lib=await readJournalLibrary({root,config});
      const state=await applyCollectionReceipt(await readWorkflow(repositoryRoot),record.run,input.data,prepared,lib);
      record.publication_id=randomUUID();
      const receipt=state.receipts.find(r=>r.id===record.run.id);
      receipt.publication_id=record.publication_id;
      receipt.pending_translation_fields=record.pending_translation_fields;
      await saveWorkflow(repositoryRoot,state);
      await advance('building','验证网站构建；尚未发布。');await build({root});
      await advance('publishing','提交正式库和任务回执，申请发布。');record.release=await publish({root,id});
      await advance('awaiting_publication','数据已提交，发布已请求；等待网站版本核验，不能当作已上线。');
    }catch(error){onFailure(error);record.failed_stage=record.phase;await advance('failed','本批次未全部完成；已保存步骤保留。可再次执行，未知计费请求不会自动重发。').catch(()=>{});}
    finally{busy=false;}})();return {phase:'processing'};
  }
  async function check(id){return exclusive(async()=>{const r=await load(id);
    assertLibrary(['awaiting_publication','published'].includes(r.phase),'尚未提交发布');
    if(await checkPublication(id,r.export_hash,r.publication_id)){r.phase='published';r.message='网站已读取到本次发布回执；目录未完成项及缺失论文仍保留。'+(r.pending_translation_fields?` 仍有 ${r.pending_translation_fields} 个中文字段待处理，可继续翻译，无需重新采集。`:'');await store(r);}
    return {phase:r.phase};});}
  return {status,start,submit,finish,check,run:async id=>({run:(await load(id)).run}),sync:()=>exclusive(sync)};
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
    try {
      if(req.method==='GET'&&req.url==='/status'){reply(200,await coordinator.status());return;}
      assertLibrary(req.method==='POST'&&['/start','/run','/submit','/finish','/sync','/check-publication'].includes(req.url),'请求不支持');
      assertLibrary(req.headers['content-type']==='application/json','请求格式不支持');
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;assertLibrary(size<=(req.url==='/submit'?150*1024*1024:16384),'请求过大');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result=req.url==='/run'?await coordinator.run(body.id):req.url==='/start'?await coordinator.start(body.mode):req.url==='/submit'?await coordinator.submit(body.id,body.data):
        req.url==='/finish'?await coordinator.finish(body.id):req.url==='/check-publication'?await coordinator.check(body.id):await coordinator.sync();
      reply(200,result||{ok:true});
    }catch{reply(409,{message:'正式流程未完成请求；保留原有数据。请确认没有其他任务运行、任务 ID 正确且 Git 同步可用。'});}
  });
}
