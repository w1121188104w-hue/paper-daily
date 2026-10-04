import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {emptyWorkflow,validateWorkflow,addDiscoverySignals,createCollectionRun,applyCollectionReceipt,saveWorkflow,readWorkflow,publicWorkflow} from '../src/services/collectionWorkflow.js';
import {seedCatalogBaselines} from '../scripts/seed-catalog-baselines.js';
import {catalogChecks,capturedIssueRank,recordCatalogBaseline} from '../src/services/catalogBaseline.js';
import {workflowAuditChecks} from '../public/journals/viewModel.js';
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
test('authenticated pre-run direct capture can finish; changed cached content remains pending',async()=>{
  const s=addDiscoverySignals(emptyWorkflow(),[signal],{now}),run=createCollectionRun(s,[],{now});
  const data=await capture(run,{empty:true});data.catalog.pages[0].captured_at='2026-09-23T07:00:00Z';
  run.direct_pages=[structuredClone(data.catalog.pages[0])];
  data.catalog.pages[0]=Object.fromEntries(Object.entries(data.catalog.pages[0]).reverse());
  const prepared=await prepareBrowserImport(data,config);
  assert.equal((await applyCollectionReceipt(s,run,data,prepared,{papers:[]})).receipts[0].completed_catalogs,1);
  data.catalog.pages[0].captured_at='2026-09-23T06:00:00Z';
  assert.equal((await applyCollectionReceipt(s,run,data,prepared,{papers:[]})).receipts[0].pending_catalogs,1);
});
test('catalog receipt separate from missing abstract; due retry selects related directory',async()=>{
  const s=addDiscoverySignals(emptyWorkflow(),[signal],{now}),run=createCollectionRun(s,[],{now}),data=await capture(run,{missing:true});
  const prepared=await prepareBrowserImport(data,config),out=await applyCollectionReceipt(s,run,data,prepared,{papers:[]},{now});
  assert.equal(out.tasks[0].status,'processed');assert.equal(out.receipts[0].pending_papers.length,1);
  assert.equal(createCollectionRun(out,[],{now}).jobs.length,0);
  assert.equal(createCollectionRun(out,[],{now:new Date('2026-10-01T00:00:00Z')}).jobs.length,1);
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

test('automatic submission queues GitHub work, never invokes a local translator, duplicate is idempotent',async t=>{
  const repo=await temp(t),stateDir=path.join(repo,'private-runs');
  await saveWorkflow(repo,addDiscoverySignals(emptyWorkflow(),[signal],{now}));
  let paid=0,pushed=0,dispatched=0,failure,live=false;
  const c=createCollectionCoordinator({repositoryRoot:repo,stateDir,config,sync:async()=>{},onFailure:e=>failure=e,
    translate:async()=>{paid++;throw Error('LOCAL_TRANSLATION_FORBIDDEN');},checkpoint:async()=>pushed++,
    publish:async()=>{dispatched++;return {dispatched:true};},checkPublication:async()=>live});
  const {run}=await c.start('daily'),data=await capture(run);data.catalog.pages[0].captured_at=new Date(Date.now()+1000).toISOString();
  await c.submit(run.id,data);
  while((await c.status()).busy)await new Promise(r=>setTimeout(r,10));
  assert.ifError(failure);assert.equal(paid,0);assert.equal(pushed,1);assert.equal(dispatched,1);
  assert.equal((await c.status()).runs[0].phase,'awaiting_publication');
  const q=JSON.parse(await fs.readFile(path.join(repo,'data/collection-workflow/publication-queue.json'),'utf8'));
  assert.deepEqual(q.requests[0].paper_ids,['doi:'+doi]);assert.equal(q.requests[0].status,'pending');
  assert.ok(!JSON.stringify(q).includes(abstract));
  await c.submit(run.id,data);await c.finish(run.id);assert.equal(dispatched,1);
  assert.equal((await c.check(run.id)).phase,'awaiting_publication');
  live=true;await c.pulse();assert.equal((await c.status()).runs[0].phase,'published');
});

test('saved upload failures resume despite older failure counts and clear safe diagnostics after success',async t=>{
  const repo=await temp(t),stateDir=path.join(repo,'private-runs');
  await saveWorkflow(repo,addDiscoverySignals(emptyWorkflow(),[signal],{now}));
  let offline=true,dispatched=0;
  const c=createCollectionCoordinator({repositoryRoot:repo,stateDir,config,sync:async()=>{},
    checkpoint:async()=>{if(offline)throw Object.assign(Error('private transport detail'),{code:'GIT_CONNECTION_FAILED'});},
    publish:async()=>{dispatched++;return {dispatched:true};},checkPublication:async()=>false});
  const {run}=await c.start('daily');await c.submit(run.id,await capture(run));
  while((await c.status()).busy)await new Promise(r=>setTimeout(r,10));
  const file=path.join(stateDir,run.id,'run.json'),saved=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(saved.failure_code,'GIT_CONNECTION_FAILED');assert.equal(JSON.stringify(saved).includes('private transport detail'),false);
  await fs.writeFile(file,JSON.stringify({...saved,failures:6,retry_at:'2020-01-01T00:00:00Z'}));offline=false;
  await c.pulse();while((await c.status()).busy)await new Promise(r=>setTimeout(r,10));
  const done=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(done.phase,'awaiting_publication');assert.equal(done.failure_code,null);assert.equal(dispatched,1);
});
test('scoped source import preserves data; cloud receipt is required to confirm deployment',async t=>{
  const repo=await temp(t),root=path.join(repo,'data/journal-store'),stateDir=path.join(repo,'private-runs');
  await saveWorkflow(repo,addDiscoverySignals(emptyWorkflow(),[signal],{now}));let failure,live=false;
  const c=createCollectionCoordinator({repositoryRoot:repo,stateDir,config,sync:async()=>{},onFailure:e=>failure=e,
    publish:async()=>({dispatched:true}),checkPublication:async()=>live?{published:true,pending_translation_fields:2,translation_status:'attention'}:false});
  const {run}=await c.start('daily'),data=await capture(run);data.catalog.pages[0].captured_at=new Date(Date.now()+1000).toISOString();
  await c.submit(run.id,data);while((await c.status()).busy)await new Promise(r=>setTimeout(r,10));assert.ifError(failure);
  assert.equal((await readJournalLibrary({root,config})).papers[0].abstract_original,abstract);
  const b=await buildJournalSite(config,{root,outputRoot:path.join(repo,'build')}),buildData=JSON.parse(await fs.readFile(path.join(b.directory,'data.json'),'utf8'));
  assert.equal(buildData.collection_workflow.tasks.length,0);assert.equal(buildData.collection_workflow.receipts.length,1);
  assert.equal(JSON.stringify(buildData).includes('ai_review_results'),false);
  assert.equal((await c.check(run.id)).phase,'awaiting_publication');live=true;
  assert.equal((await c.check(run.id)).phase,'published');assert.equal((await c.status()).runs[0].pending_translation_fields,2);
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
  const post={method:'POST',headers:{...good,'Content-Type':'application/json'},body:'{}'};
  assert.equal((await fetch(`http://127.0.0.1:${port}/status`,post)).status,200);
  assert.equal(calls,2);
  const health=await fetch(`http://127.0.0.1:${port}/health`,post);
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{service:'paper-daily-workflow',status:'ready',version:2});
  assert.equal(calls,2,'health does not read the library or run the coordinator');
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`,{...post,headers:{...post.headers,Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`,{method:'POST',headers:{Origin:good.Origin}})).status,403);
  for(const Origin of [undefined,'null','https://evil.example','chrome-extension://'+'a'.repeat(32)]){
    const headers={...post.headers};delete headers.Origin;if(Origin!==undefined)headers.Origin=Origin;
    assert.equal((await fetch(`http://127.0.0.1:${port}/status`,{...post,headers})).status,403);
  }
  assert.equal(calls,2);
});

test('legacy ledger is readable but never invents a verified catalog baseline',()=>{
  const old=emptyWorkflow();delete old.catalog_baselines;delete old.audit_interval_days;
  validateWorkflow(old);const publicState=publicWorkflow(old,{now});
  assert.equal(publicState.audit_interval_days,14);assert.equal(publicState.catalog_checks.length,ACTIVE_CATALOG_TASKS.length);
  assert.ok(publicState.catalog_checks.every(c=>c.status==='baseline_missing'));
  assert.equal(createCollectionRun(old,[],{now}).jobs.length,0);
  assert.throws(()=>validateWorkflow({...old,audit_interval_days:0}));
});

test('verified receipt persists issue, DOI set and capture time independently of abstract completion',async t=>{
  const s=addDiscoverySignals(emptyWorkflow(),[signal],{now}),run=createCollectionRun(s,[],{now});
  const data=await capture(run,{missing:true});data.catalog.pages[0].issue_heading='Volume 55, Issue 10';
  const prepared=await prepareBrowserImport(data,config),out=await applyCollectionReceipt(s,run,data,prepared,{papers:[]},{now:new Date('2026-09-25T00:00:00Z')});
  const b=out.catalog_baselines[0];assert.deepEqual(b.rank,[55,10]);assert.equal(b.papers[0].doi,doi);
  assert.equal(b.checked_at,later);assert.equal(b.input_sha256,prepared.input_sha256);assert.equal(out.receipts[0].pending_papers.length,1);
  const repo=await temp(t);await saveWorkflow(repo,out);assert.deepEqual((await readWorkflow(repo)).catalog_baselines,out.catalog_baselines);
  const pub=publicWorkflow(out,{now});assert.equal(pub.catalog_checks.find(c=>c.catalog_id===task.id).paper_count,1);
  assert.equal(JSON.stringify(pub).includes('input_sha256":"'+prepared.input_sha256),true); // receipt digest, no original page
  assert.equal(JSON.stringify(pub).includes('source_urls'),false);
});

test('partial or wrong-identity linked pages cannot advance the baseline or clear a reminder',async()=>{
  for(const bad of ['missing','identity','unreviewed']){
    const s=addDiscoverySignals(emptyWorkflow(),[signal],{now}),run=createCollectionRun(s,[],{now}),data=await capture(run);
    const child=task.url+'?page=2';data.catalog.pages[0].next_links=[child];
    data.catalog.queue.push({task_id:task.id,url:child,depth:1});data.catalog.cursor=2;
    if(bad!=='missing'){
      const p=structuredClone(data.catalog.pages[0]);p.source_url=child;p.requested_url=child;p.job_key=task.id+'|'+child;p.next_links=[];
      if(bad==='identity')p.identity_evidence={observed_issns:['0021-8456']};
      else {p.items[0].title='A different unreviewed paper';p.items[0].url=url+'1';p.items[0].doi=doi+'1';}
      data.catalog.pages.push(p);
    }
    const prepared=await prepareBrowserImport(data,config),out=await applyCollectionReceipt(s,run,data,prepared,{papers:[]},{now});
    assert.equal(out.catalog_baselines.length,0,bad);assert.equal(out.tasks[0].status,'pending',bad);
  }
});

test('offline seed replays original proof, preserves reminders and uses original date; duplicate is free and idempotent',async()=>{
  const s=addDiscoverySignals(emptyWorkflow(),[signal],{now}),run=createCollectionRun(s,[],{now}),data=await capture(run);
  data.catalog.pages[0].issue_heading='Volume 55, Issue 10';
  const seeded=await seedCatalogBaselines(s,data,'b'.repeat(64),{now:new Date(later)});
  assert.equal(seeded.catalog_baselines.length,1);assert.deepEqual(seeded.tasks,s.tasks);assert.deepEqual(seeded.receipts,[]);
  assert.equal(seeded.catalog_baselines[0].checked_at,later);
  assert.deepEqual(await seedCatalogBaselines(seeded,data,'b'.repeat(64),{now:new Date('2026-09-30T00:00:00Z')}),seeded);
  const bad=structuredClone(data);bad.catalog_review_results={};
  assert.equal((await seedCatalogBaselines(s,bad,'c'.repeat(64),{now:new Date(later)})).catalog_baselines.length,0);
});

test('audit deadlines update on static site, do not bulk-enqueue daily run, and accept 7/14 day intervals',async()=>{
  const s=emptyWorkflow(),run=createCollectionRun(s,[],{mode:'full',now}),data=await capture(run,{empty:true});
  const out=await seedCatalogBaselines(s,data,'d'.repeat(64),{now:new Date(later)}),publicState=publicWorkflow(out,{now:new Date(later)});
  const deadline=Date.parse(later)+14*86400000;
  assert.equal(workflowAuditChecks(publicState,deadline-1).find(c=>c.catalog_id===task.id).status,'recently_checked');
  assert.equal(workflowAuditChecks(publicState,deadline).find(c=>c.catalog_id===task.id).status,'audit_due');
  assert.equal(createCollectionRun(out,[],{now:new Date(deadline)}).jobs.length,0);
  out.audit_interval_days=7;
  assert.equal(catalogChecks(out,{now:new Date(deadline)}).find(c=>c.catalog_id===task.id).next_audit_at,new Date(Date.parse(later)+7*86400000).toISOString());
  assert.equal(out.catalog_baselines[0].papers.length,0); // explicit empty online/current list is valid evidence
});

test('saved baselines suppress indexed known catalog papers even when missing abstracts prevented library import',async()=>{
  const s=emptyWorkflow(),run=createCollectionRun(s,[],{mode:'full',now}),data=await capture(run,{missing:true});
  const seeded=await seedCatalogBaselines(s,data,'e'.repeat(64),{now:new Date(later)});
  const next=await discoverCollectionTasks({...config,journals:config.journals.filter(j=>j.key==='RP')},seeded,[],{now,
    collect:async()=>({source_results:[{source:'crossref',ok:true,complete:true,records:[{journal_key:'RP',doi,title,url}]}]})});
  assert.equal(next.tasks.length,0);assert.equal(next.catalog_baselines.length,1);
});


test('older captures/issues cannot refresh baseline deadlines; conflicting heading cannot invent an issue',()=>{
  const s=emptyWorkflow(),job={catalog_id:task.id,url:task.url};
  const page={task_id:task.id,source_url:task.url,captured_at:later,issue_heading:'Volume 55, Issue 10'};
  recordCatalogBaseline(s,job,[page],[],{receiptId:'first',inputHash:'a'.repeat(64)});
  for(const patch of [{captured_at:at},{captured_at:'2026-09-25T00:00:00Z',issue_heading:'Volume 55, Issue 9'}])
    recordCatalogBaseline(s,job,[{...page,...patch}],[],{receiptId:'stale',inputHash:'b'.repeat(64)});
  assert.equal(s.catalog_baselines[0].receipt_id,'first');
  assert.equal(capturedIssueRank([{...page,page_title:'Volume 55, Issue 8'}],task),null);
  assert.equal(catalogChecks({...s,catalog_baselines:[{...s.catalog_baselines[0],url:'https://www.sciencedirect.com/journal/research-policy/vol/55/issue/10'}]},{now}).find(c=>c.catalog_id===task.id).status,'baseline_missing');
});
