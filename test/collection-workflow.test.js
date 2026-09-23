import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {emptyWorkflow,addDiscoverySignals,createCollectionRun,applyCollectionReceipt,saveWorkflow,readWorkflow,publicWorkflow} from '../src/services/collectionWorkflow.js';
import {discoverCollectionTasks} from '../src/services/collectionDiscovery.js';
import {createCollectionCoordinator,collectionHttpServer} from '../src/services/collectionCoordinator.js';
import {ACTIVE_CATALOG_TASKS} from '../tools/browser-abstract-extension/catalog-core.js';
import {catalogRepairJobs,CatalogEngine} from '../tools/browser-abstract-extension/catalog-engine.js';
import {incrementalPapers} from '../tools/browser-abstract-extension/workflow-client.js';
import {makeReviewJobs,validateReviewOutput} from '../tools/browser-abstract-extension/review-core.js';
import {prepareReviewPlan} from '../tools/browser-abstract-extension/review-client.js';
import {prepareBrowserImport,importBrowserExport} from '../src/services/browserImport.js';
import {loadJournalConfig} from '../src/services/journals.js';
import {readJournalLibrary} from '../src/services/journalLibrary.js';
import {buildJournalSite} from '../src/services/journalSiteBuild.js';
const config=await loadJournalConfig(),task=ACTIVE_CATALOG_TASKS.find(t=>t.id==='catalog-1');
const at='2026-09-23T08:00:00.000Z',now=new Date(at),later='2026-09-23T09:00:00.000Z';
const doi='10.1016/j.respol.2026.105555',title='Credit markets and firm investment',url='https://www.sciencedirect.com/science/article/pii/S0048733326000555';
const abstract='We study firm investment using evidence from financial markets. The results suggest that credit supply affects investment across firms and regions. This study provides new evidence on the information environment and the allocation of capital.';
const signal={catalog_id:task.id,title,doi,source:'crossref'};
async function temp(t){const base=path.resolve(os.tmpdir()),dir=await fs.mkdtemp(path.join(base,'workflow-test-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(dir)),base);assert.ok(path.basename(dir).startsWith('workflow-test-'));await fs.rm(dir,{recursive:true,force:true});});return dir;}
async function capture(run,{missing=false,empty=false,review=true}={}){
  const item={doi,title,journal:'RP',url,evidence:{version:2,text:title,catalog_url:task.url}};
  const page={task_id:task.id,journal:'RP',source_url:task.url,requested_url:task.url,page_title:'Research Policy',captured_at:later,
    status:empty?'catalog_empty':'catalog_candidates',job_key:task.id+'|'+task.url,items:empty?[]:[item]};
  const record={doi,title,journal:'RP',url,source_url:url,extracted_at:later,identity:{ok:true},evidence_version:2,abstract:missing?null:abstract,
    evidence:[{id:'title',kind:'title',text:title},{id:'doi',kind:'doi',text:doi},...(!missing?[{id:'abstract',kind:'abstract',text:abstract,language:'en',context:'Abstract'}]:[])]};
  const data={kind:'paper_project_trial',workflow_run_id:run.id,records:empty?[]:[record],catalog:{pages:[page],run_started_at:run.created_at,
    scope_task_ids:[task.id],queue:[{task_id:task.id,url:task.url,depth:0}],cursor:1},ai_review_results:{},catalog_review_results:{}};
  if(review)for(const catalog of [true,false]){const plan=await prepareReviewPlan(makeReviewJobs(catalog?data.catalog:null,catalog?null:data));
    for(const j of plan.jobs){const fields={title:{status:'confirmed',spans:[{block_id:catalog?'card':'title',quote:title}]}};
      if(!catalog){fields.doi={status:'confirmed',spans:[{block_id:'doi',quote:doi}]};if(!missing)fields.abstract={status:'confirmed',block_ids:['abstract']};}
      (catalog?data.catalog_review_results:data.ai_review_results)[j.hash]={input:j.input,error:null,verdict:validateReviewOutput(j.input,{identity_match:true,fields})};}}
  return data;
}
test('daily scope, full fallback, stable cross-source signals and no acknowledgment on start',()=>{
  const s=addDiscoverySignals(emptyWorkflow(),[signal],{now});const run=createCollectionRun(s,[],{now});
  assert.equal(run.jobs.length,1);assert.equal(s.tasks[0].status,'pending');assert.equal(createCollectionRun(s,[],{mode:'full'}).jobs.length,ACTIVE_CATALOG_TASKS.length);
  assert.equal(addDiscoverySignals(s,[{...signal,source:'openalex'}],{now}).tasks[0].signals.length,1);
  assert.equal(addDiscoverySignals(s,[{...signal,source:'zhipu',doi:null,source_url:'https://evil.example/'}],{now}).tasks[0].signals.length,1);
});
test('retry keeps daily scope, does not silently enqueue all journals',async()=>{
  const s={scope_task_ids:[task.id],pages:[],queue:[{task_id:task.id,url:task.url,depth:0}],cursor:0};
  assert.equal(catalogRepairJobs(s).length,1);
  const engine=new CatalogEngine({now:()=>now.getTime(),save:async()=>{},saveSession:async()=>{},render:()=>{}});
  engine.s={...engine.s,...s};await engine.recheck();assert.equal(engine.s.queue.length,1);
});
test('only new/due papers enter detail queue; raw unreviewed candidates never start',()=>{
  const p={doi,title,journal:'RP',review_status:'source_checked_candidate'};
  assert.equal(incrementalPapers([p],{known_papers:[{...p,complete:true}]}).length,0);
  assert.equal(incrementalPapers([p],{known_papers:[{...p,next_retry_at:'2099-01-01T00:00:00Z'}]}).length,0);
  assert.equal(incrementalPapers([{...p,review_status:'pending'}],{known_papers:[]}).length,0);
  assert.equal(incrementalPapers([p],{known_papers:[]}).length,1);
});
test('unreviewed, pagination gaps, wrong identity and old captures keep reminder pending',async()=>{
  const s=addDiscoverySignals(emptyWorkflow(),[signal],{now}),run=createCollectionRun(s,[],{now});
  for(const mutate of [d=>d.catalog_review_results={},d=>d.catalog.pages[0].pagination_unresolved=true,
    d=>d.catalog.pages[0].identity_evidence={observed_issns:['0021-8456']},d=>d.catalog.pages[0].captured_at='2025-01-01T00:00:00Z']){
    const data=await capture(run);mutate(data);const prepared=await prepareBrowserImport(data,config);
    const out=await applyCollectionReceipt(s,run,data,prepared,{papers:[]});assert.equal(out.tasks[0].status,'pending');assert.equal(out.receipts[0].pending_catalogs,1);
  }
});
test('explicit empty catalog can finish; newer concurrent signal is never cleared',async()=>{
  const s=addDiscoverySignals(emptyWorkflow(),[signal],{now}),run=createCollectionRun(s,[],{now}),data=await capture(run,{empty:true});
  const prepared=await prepareBrowserImport(data,config);
  const out=await applyCollectionReceipt(s,run,data,prepared,{papers:[]});assert.equal(out.tasks[0].status,'processed');
  assert.equal((await applyCollectionReceipt(out,run,data,prepared,{papers:[]})).receipts.length,1);
  const newer=addDiscoverySignals(s,[{...signal,doi:'10.1016/j.respol.2026.106666'}]);
  assert.equal((await applyCollectionReceipt(newer,run,data,prepared,{papers:[]})).tasks[0].status,'pending');
});
test('catalog receipt separate from missing abstract; due retry selects related directory',async()=>{
  const s=addDiscoverySignals(emptyWorkflow(),[signal],{now}),run=createCollectionRun(s,[],{now}),data=await capture(run,{missing:true});
  const prepared=await prepareBrowserImport(data,config),out=await applyCollectionReceipt(s,run,data,prepared,{papers:[]},{now});
  assert.equal(out.tasks[0].status,'processed');assert.equal(out.receipts[0].pending_papers.length,1);
  assert.equal(createCollectionRun(out,[],{now}).jobs.length,0);
  assert.equal(createCollectionRun(out,[],{now:new Date('2026-10-01T00:00:00Z')}).jobs.length,1);
});
test('three-source failures still go to Zhipu then Scholar then Google; never translate',async()=>{
  const order=[];const result=await discoverCollectionTasks({...config,journals:config.journals.filter(j=>j.key==='RP')},emptyWorkflow(),[],{
    now,collect:async()=>{throw Error('source down');},search:async o=>{order.push(o.provider);return {called:true,result:{leads:[]}};}});
  assert.deepEqual(order,['zhipu','serpapi_scholar','serpapi_google']);assert.equal(result.monitors.filter(m=>m.status==='failed').length,3);assert.equal(result.tasks.length,0);
});

test('new indexed paper alerts only its journal, deduplicates sources, and skips known papers',async()=>{
  const collect=async()=>({source_results:['crossref','openalex','semanticscholar'].map(source=>({source,ok:true,complete:true,
    records:[{journal_key:'RP',doi,title,url}]}))});
  const selected={...config,journals:config.journals.filter(j=>j.key==='RP')};
  const state=await discoverCollectionTasks(selected,emptyWorkflow(),[],{now,collect});
  assert.equal(state.tasks.length,2);assert.ok(state.tasks.every(t=>t.journal==='RP'&&t.signals.length===1));
  assert.equal(createCollectionRun(state,[],{now}).jobs.length,2);
  const known=await discoverCollectionTasks(selected,emptyWorkflow(),[{journal_key:'RP',doi,title_original:title}],{now,collect});
  assert.equal(known.tasks.length,0);
});

test('remaining translations resume without recapture and require a fresh publication receipt',async t=>{
  const repo=await temp(t),stateDir=path.join(repo,'private-runs');
  await saveWorkflow(repo,addDiscoverySignals(emptyWorkflow(),[signal],{now}));let calls=0,liveToken=null;
  let failure;
  const c=createCollectionCoordinator({repositoryRoot:repo,stateDir,config,sync:async()=>{},onFailure:e=>failure=e,
    translate:async()=>({available_fields:++calls===1?1:0,held_fields:0}),build:async()=>{},publish:async()=>({}),
    checkPublication:async(_id,_hash,token)=>token===liveToken});
  const {run}=await c.start('daily'),data=await capture(run);data.catalog.pages[0].captured_at=new Date(Date.now()+1000).toISOString();
  await c.submit(run.id,data);await c.finish(run.id);
  await assert.rejects(c.finish(run.id));
  while((await c.status()).busy)await new Promise(r=>setTimeout(r,10));assert.ifError(failure);
  let receipt=(await readWorkflow(repo)).receipts[0];liveToken=receipt.publication_id;
  assert.equal((await c.check(run.id)).phase,'published');assert.equal((await c.status()).runs[0].pending_translation_fields,1);
  await c.finish(run.id);while((await c.status()).busy)await new Promise(r=>setTimeout(r,10));assert.ifError(failure);
  assert.equal(calls,2);assert.equal((await c.check(run.id)).phase,'awaiting_publication');
  receipt=(await readWorkflow(repo)).receipts[0];assert.notEqual(receipt.publication_id,liveToken);liveToken=receipt.publication_id;
  assert.equal((await c.check(run.id)).phase,'published');await c.finish(run.id);assert.equal(calls,2);
});
test('end-to-end: scoped capture → import → translate callback → build → receipt → verify deployment',async t=>{
  const repo=await temp(t),root=path.join(repo,'data/journal-store'),stateDir=path.join(repo,'private-runs');
  await saveWorkflow(repo,addDiscoverySignals(emptyWorkflow(),[signal],{now}));let paid=0,live=false,buildData;
  let failure;
  const c=createCollectionCoordinator({repositoryRoot:repo,stateDir,config,sync:async()=>{},onFailure:e=>failure=e,
    translate:async({paperIds})=>{assert.deepEqual(paperIds,['doi:'+doi]);paid++;return {requests:0};},
    build:async()=>{const b=await buildJournalSite(config,{root,outputRoot:path.join(repo,'build')});buildData=JSON.parse(await fs.readFile(path.join(b.directory,'data.json'),'utf8'));},
    publish:async()=>({dispatched:true}),checkPublication:async()=>live});
  const {run}=await c.start('daily');const data=await capture(run);data.catalog.pages[0].captured_at=new Date(Date.now()+1000).toISOString();
  await c.submit(run.id,data);assert.equal((await c.status()).runs[0].phase,'ready');
  await c.finish(run.id);while((await c.status()).busy)await new Promise(r=>setTimeout(r,10));
  const status=await c.status();assert.ifError(failure);assert.equal(status.runs[0].phase,'awaiting_publication');assert.equal(paid,1);
  assert.equal((await readJournalLibrary({root,config})).papers[0].abstract_original,abstract);
  assert.equal(buildData.collection_workflow.tasks.length,0);assert.equal(buildData.collection_workflow.receipts.length,1);
  assert.equal(JSON.stringify(buildData).includes('ai_review_results'),false);
  assert.equal((await c.check(run.id)).phase,'awaiting_publication');live=true;assert.equal((await c.check(run.id)).phase,'published');
  await c.submit(run.id,data);assert.equal((await c.status()).runs[0].phase,'published');assert.equal(paid,1);
});
test('loopback service rejects wrong origin, missing guard and arbitrary routes',async t=>{
  const port=19328,id='dcalhdbdeepppgdbhbgbaalabkamnhgc';let calls=0;
  const s=collectionHttpServer({status:async()=>{calls++;return {ok:true};}},{extensionId:id,port});await new Promise(r=>s.listen(port,'127.0.0.1',r));
  t.after(()=>new Promise(r=>s.close(r)));
  const good={Origin:'chrome-extension://'+id,'X-Paper-Workflow':'1'};
  assert.equal((await fetch(`http://127.0.0.1:${port}/status`,{headers:good})).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/status`,{headers:{...good,Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/status`,{headers:{Origin:good.Origin}})).status,403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/shell`,{headers:good})).status,409);assert.equal(calls,1);
});
