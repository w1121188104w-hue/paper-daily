import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {loadJournalConfig} from '../src/services/journals.js';
import {emptyWorkflow,saveWorkflow,addDiscoverySignals} from '../src/services/collectionWorkflow.js';
import {createCollectionCoordinator} from '../src/services/collectionCoordinator.js';
import {createLocalCollector} from '../src/services/localCollector.js';
import {createSourceReviewer} from '../tools/browser-abstract-extension/review-provider.mjs';
import {readJournalLibrary} from '../src/services/journalLibrary.js';
import {readFieldTasks} from '../src/services/collectionFieldTasks.js';
import {ACTIVE_CATALOG_TASKS} from '../tools/browser-abstract-extension/catalog-core.js';
import {validateReviewOutput} from '../tools/browser-abstract-extension/review-core.js';
const config=await loadJournalConfig(),task=ACTIVE_CATALOG_TASKS.find(t=>t.id==='catalog-1');
const doi='10.1016/j.respol.2026.105555',title='Credit markets and firm investment',url='https://www.sciencedirect.com/science/article/pii/S0048733326000555';
const abstract='We study firm investment using evidence from financial markets. The results suggest that credit supply affects investment across firms and regions. This study provides new evidence on the information environment and the allocation of capital.';
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'local-collector-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
async function drain(c){for(let i=0;i<300&&(await c.status()).busy;i++)await new Promise(r=>setTimeout(r,10));assert.equal((await c.status()).busy,false);}
test('plugin-controlled Python captures feed real shared reviewer and independently publish partial results; resume preserves run',async t=>{
  const repo=await temp(t),stateDir=path.join(repo,'private');let processHandle,spawnCount=0,paid=0,published=0,failure;
  await saveWorkflow(repo,addDiscoverySignals(emptyWorkflow(),[{catalog_id:task.id,title,doi,source:'crossref'}]));
  const coordinator=createCollectionCoordinator({repositoryRoot:repo,stateDir,config,sync:async()=>{},checkpoint:async()=>{},publish:async()=>{published++;},checkPublication:async()=>false,onFailure:e=>failure=e});
  const service=createSourceReviewer({apiKey:'test-placeholder-key',stateDir:path.join(repo,'reviews'),fetchImpl:async(u,opts)=>{
    paid++;const input=JSON.parse(JSON.parse(opts.body).messages[1].content),fields={title:{status:'confirmed',spans:[{block_id:input.kind==='catalog'?'card':'title',quote:title}]}};
    if(input.kind==='article'){fields.doi={status:'confirmed',spans:[{block_id:'doi',quote:doi}]};fields.abstract={status:'confirmed',block_ids:['abstract']};}
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({identity_match:true,fields,
      ...(input.kind==='catalog'?{catalog_membership:{status:'in_scope',spans:[{block_id:'card',quote:title}]}}:{})})}}]}));
  }});
  const collector=createLocalCollector({repositoryRoot:repo,stateDir,config,coordinator,pythonExecutable:'python-test',
    requestReview:async(input,options)=>(await service.review(input,{retryHeader:options.retryAttempt})).data,
    spawnImpl:(command,args,options)=>{spawnCount++;assert.equal(command,'python-test');assert.ok(args.includes('--profile'));assert.equal(options.windowsHide,true);assert.equal(options.env.DEEPSEEK_API_KEY,undefined);processHandle=new EventEmitter();return processHandle;}});
  const started=await collector.start(),current=await collector.current(),run=(await coordinator.run(started.id)).run;
  const reviewPolicy=JSON.parse(await fs.readFile(path.join(current.dir,'review-policy.json'),'utf8'));
  assert.equal(reviewPolicy.mode,'new_captures_only');assert.equal(reviewPolicy.archived_at,null);
  await assert.rejects(collector.start());await collector.pause();assert.equal(JSON.parse(await fs.readFile(path.join(current.dir,'control.json'),'utf8')).pause,true);
  const capturedAt=new Date(Date.now()+1000).toISOString();
  const page={task_id:task.id,journal:'RP',source_url:task.url,requested_url:task.url,page_title:'Research Policy',captured_at:capturedAt,
    status:'catalog_candidates',job_key:task.id+'|'+task.url,items:[{doi,title,journal:'RP',url,evidence:{version:2,text:title,catalog_url:task.url}}]};
  const record={doi,title,journal:'RP',url,source_url:url,extracted_at:capturedAt,identity:{ok:true},evidence_version:2,abstract,
    evidence:[{id:'title',kind:'title',text:title},{id:'doi',kind:'doi',text:doi},{id:'abstract',kind:'abstract',text:abstract,language:'en',context:'Abstract'}]};
  await fs.mkdir(path.join(current.dir,'captures'));
  const items=[];
  for(const [kind,result,id] of [['catalog',page,'a'],['article',record,'b']]){const key=id.repeat(64),file='captures/'+key+'.json';
    await fs.writeFile(path.join(current.dir,file),JSON.stringify({task:{kind,catalog_id:task.id,journal:'RP',url:kind==='catalog'?task.url:url,...(kind==='article'?{doi,title}:{})},result,capture:{}}));items.push({kind,key,file,status:result.status});}
  await fs.writeFile(path.join(current.dir,'state.json'),JSON.stringify({run_id:run.id,phase:'paused',items,queue:[],cursor:2,remaining:[{doi,reason:'missing_affiliations'}]}));
  processHandle.emit('exit',0);await collector.pulse();await drain(coordinator);assert.ifError(failure);
  const library=await readJournalLibrary({root:path.join(repo,'data/journal-store'),config});assert.equal(library.papers[0].abstract_original,abstract);assert.equal(published,1);assert.equal(paid,2);
  assert.deepEqual((await readFieldTasks(repo)).papers[0].missing_fields,[]);
  assert.equal((await readFieldTasks(repo)).papers[0].status,'complete');
  await collector.pulse();await drain(coordinator);assert.equal(paid,2);assert.equal(published,1);
  const fallback=await collector.fallback();assert.equal(fallback.run.browser_snapshot.records.length,1);assert.equal(Object.keys(fallback.run.catalog_review_results).length,2);
  await collector.resume();assert.equal(spawnCount,2);assert.equal((await collector.current()).id,run.id);processHandle.emit('exit',0);
});

test('upgrades archive old captures without paid retries, exports or false completion; only new captures get the new reviewer',async t=>{
  const repo=await temp(t),stateDir=path.join(repo,'private'),id='10000000-0000-4000-8000-000000000001';
  const dir=path.join(stateDir,'python',id);await fs.mkdir(path.join(dir,'captures'),{recursive:true});
  const run={id,created_at:'2026-10-05T00:00:00.000Z',jobs:[],direct_pages:[]};
  await fs.writeFile(path.join(dir,'run.json'),JSON.stringify(run));
  await fs.writeFile(path.join(stateDir,'python','active.json'),JSON.stringify({id}));
  const old={doi,title,journal:'RP',url,source_url:url,identity:{ok:true},evidence_version:2,
    evidence:[{id:'title',kind:'title',text:title},{id:'doi',kind:'doi',text:doi},{id:'abstract',kind:'abstract',text:abstract,language:'en',context:'Abstract'}]};
  const key='a'.repeat(64),file='captures/'+key+'.json';
  const capturedText=JSON.stringify({task:{kind:'article',journal:'RP',url},result:old});
  await fs.writeFile(path.join(dir,file),capturedText);
  const state={phase:'captured',items:[{kind:'article',key,file}],queue:[],cursor:1,remaining:[]};
  await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(state));
  const cacheText=JSON.stringify({previous:{verdict:{status:'source_checked_candidate'}},failed:{error:'PROVIDER_TIMEOUT',attempt:1}});
  await fs.writeFile(path.join(dir,'reviews.json'),cacheText);
  let calls=0,completed=0;const exports=[];
  const coordinator={checkpointCapture:async(id,data)=>exports.push(structuredClone(data)),captureFinished:async()=>completed++,
    status:async()=>({workflow:{known_papers:[],field_tasks:[]}})};
  const requestReview=async input=>{
    calls++;assert.equal(input.decision_version,1);assert.equal(input.identity.title,title+' newly captured');
    return {verdict:validateReviewOutput(input,{identity_match:true,fields:{
      title:{status:'confirmed',spans:[{block_id:'title',quote:input.identity.title}]},
      doi:{status:'confirmed',spans:[{block_id:'doi',quote:doi}]},abstract:{status:'confirmed',block_ids:['abstract']}}})};
  };
  const options={repositoryRoot:repo,stateDir,config,coordinator,requestReview};
  let collector=createLocalCollector(options);await collector.pulse();
  assert.equal(calls,0);assert.equal(exports.length,0);assert.equal(completed,0);
  const frozen=await fs.readFile(path.join(dir,'review-policy.json'),'utf8');
  let status=await collector.status();assert.equal(status.review_pending,0);assert.equal(status.review_done,1);assert.equal(status.review_attention,1);
  assert.equal(status.historical_captures_retained,1);assert.equal(status.review_policy,'new_captures_only');
  assert.equal(await fs.readFile(path.join(dir,'reviews.json'),'utf8'),cacheText);
  assert.equal(await fs.readFile(path.join(dir,file),'utf8'),capturedText);
  // Changed context and a new process cannot turn the old page into new work.
  await fs.writeFile(path.join(dir,'run.json'),JSON.stringify({...run,review_context:{known_papers:[{id:'old-record',journal:'RP',doi,title}]}}));
  collector=createLocalCollector(options);await collector.pulse();assert.equal(calls,0);
  assert.equal(await fs.readFile(path.join(dir,'review-policy.json'),'utf8'),frozen);
  assert.equal((await collector.fallback()).run.browser_snapshot.records.length,0);
  // Continuing that SAME run with newly captured evidence still uses v1 decisions.
  const newKey='b'.repeat(64),newFile='captures/'+newKey+'.json';
  const fresh={...old,title:title+' newly captured',evidence:old.evidence.map(b=>b.id==='title'?{...b,text:title+' newly captured'}:b)};
  await fs.writeFile(path.join(dir,newFile),JSON.stringify({task:{kind:'article',journal:'RP',url},result:fresh}));
  state.items.push({kind:'article',key:newKey,file:newFile});state.cursor++;
  await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(state));
  await collector.pulse();assert.equal(calls,1);assert.equal(exports.length,1);
  assert.deepEqual(exports[0].records.map(r=>r.title),[fresh.title]);
  await collector.pulse();assert.equal(calls,1);assert.equal(exports.length,1);
  status=await collector.status();assert.equal(status.review_pending,0);assert.equal(status.review_done,2);
  assert.equal((await collector.fallback()).run.browser_snapshot.records.length,1);
});

test('legacy captures without saved verdicts remain historical, not fabricated as reviewed',async t=>{
  const {captureReviewPolicy,newCaptureReviewData,captureReviewCounts,initializeCaptureReviewPolicy}=await import('../src/services/localReviewPolicy.js');
  const dir=await temp(t),page={task_id:'one',captured_at:'2026-10-05T00:00:00Z',items:[]};
  const data={records:[{title:'Old unreviewed evidence'}],catalog:{pages:[page],queue:[{task_id:'one'}],cursor:1}};
  const policy=await captureReviewPolicy(dir,data,{}),filtered=newCaptureReviewData(data,policy);
  assert.equal(filtered.records.length,0);assert.equal(filtered.catalog.pages.length,0);
  assert.deepEqual(captureReviewCounts(policy),{review_total:0,review_done:0,review_pending:0,review_attention:0,
    historical_review_total:0,historical_review_done:0,historical_captures_retained:2,review_policy:'new_captures_only'});
  const freshPage={...page,captured_at:'2026-10-06T00:00:00Z'};
  assert.deepEqual(newCaptureReviewData({...data,catalog:{...data.catalog,pages:[freshPage]}},policy).catalog.pages,[freshPage]);
  await initializeCaptureReviewPolicy(dir);
  assert.deepEqual(await captureReviewPolicy(dir,data,{}),policy);
  await fs.writeFile(path.join(dir,'review-policy.json'),JSON.stringify({...policy,archived_at:null}));
  await assert.rejects(captureReviewPolicy(dir,data,{}),/审核保护记录无效/);
  await fs.writeFile(path.join(dir,'review-policy.json'),JSON.stringify({version:2}));
  await assert.rejects(captureReviewPolicy(dir,data,{}),/审核保护记录无效/);
});

test('new runs do not re-review old directory evidence reused for an article handoff',async t=>{
  const {captureReviewPolicy,newCaptureReviewData,initializeCaptureReviewPolicy}=await import('../src/services/localReviewPolicy.js');
  const dir=await temp(t),page={task_id:'one',captured_at:'2026-10-05T00:00:00Z',items:[]};
  await initializeCaptureReviewPolicy(dir,{pages:[page],results:{saved:{verdict:{status:'source_checked_candidate'}}}});
  const data={records:[{title:'Newly captured article'}],catalog:{pages:[page],queue:[{task_id:'one'}],cursor:1}};
  const policy=await captureReviewPolicy(dir,data,{}),fresh=newCaptureReviewData(data,policy);
  assert.equal(policy.historical_reviews.done,1);assert.equal(fresh.catalog.pages.length,0);
  assert.deepEqual(fresh.records,data.records);
});
test('incremental batches do not freeze the parent and reviewed catalog metadata can publish before details',async t=>{
  const repo=await temp(t);await saveWorkflow(repo,addDiscoverySignals(emptyWorkflow(),[{catalog_id:task.id,title,doi,source:'crossref'}]));let failure;
  const c=createCollectionCoordinator({repositoryRoot:repo,stateDir:path.join(repo,'private'),config,sync:async()=>{},publish:async()=>{},checkPublication:async()=>false,onFailure:e=>failure=e});
  const {run}=await c.start('daily');
  const {makeReviewJobs,validateReviewOutput}=await import('../tools/browser-abstract-extension/review-core.js');
  const {prepareReviewPlan}=await import('../tools/browser-abstract-extension/review-client.js');
  const page={task_id:task.id,journal:'RP',source_url:task.url,requested_url:task.url,page_title:'Research Policy',captured_at:new Date(Date.now()+1000).toISOString(),
    status:'catalog_candidates',job_key:'test',items:[{doi,title,journal:'RP',url,evidence:{version:2,text:title,catalog_url:task.url}}]};
  const data={kind:'paper_project',workflow_run_id:run.id,records:[],catalog:{pages:[page],cursor:0,queue:[{task_id:task.id,url:task.url}]},ai_review_results:{},catalog_review_results:{}};
  const plan=await prepareReviewPlan(makeReviewJobs(data.catalog,null));const job=plan.jobs[0];
  data.catalog_review_results[job.hash]={input:job.input,verdict:validateReviewOutput(job.input,{identity_match:true,
    catalog_membership:{status:'in_scope',spans:[{block_id:'card',quote:title}]},fields:{title:{status:'confirmed',spans:[{block_id:'card',quote:title}]}}})};
  const first=await c.checkpointCapture(run.id,data);await drain(c);assert.ifError(failure);
  const library=await readJournalLibrary({root:path.join(repo,'data/journal-store'),config});assert.equal(library.papers.length,1);assert.equal(library.papers[0].abstract_original,'');
  assert.equal((await c.checkpointCapture(run.id,data)).duplicate,true);
  const second=await c.checkpointCapture(run.id,{...data,catalog:{...data.catalog,cursor:1}});assert.notEqual(second.id,first.id);await drain(c);assert.ifError(failure);
  assert.equal((await c.run(run.id)).run.id,run.id);
});

test('catalog-only handoff starts reviewed articles while cloud is busy, without catalog or unreviewed article jobs',async t=>{
  const repo=await temp(t),stateDir=path.join(repo,'private');let failure,child;
  await saveWorkflow(repo,addDiscoverySignals(emptyWorkflow(),[{catalog_id:task.id,title,doi,source:'crossref'}]));
  const c=createCollectionCoordinator({repositoryRoot:repo,stateDir,config,sync:async({forWrite=false}={})=>{
    if(forWrite)throw Object.assign(Error('cloud active'),{code:'CLOUD_WRITER_ACTIVE'});
  },publish:async()=>{},checkPublication:async()=>false,onFailure:e=>{if(e.code!=='CLOUD_WRITER_ACTIVE')failure=e;}});
  const {run}=await c.start('daily',{scope:'catalog'});
  assert.equal(run.scope,'catalog');assert.equal(run.jobs.length,1);
  const {makeReviewJobs,validateReviewOutput}=await import('../tools/browser-abstract-extension/review-core.js');
  const {prepareReviewPlan}=await import('../tools/browser-abstract-extension/review-client.js');
  const page={task_id:task.id,journal:'RP',source_url:task.url,requested_url:task.url,page_title:'Research Policy',captured_at:new Date(Date.now()+1000).toISOString(),
    status:'catalog_candidates',job_key:task.id+'|'+task.url,items:[{doi,title,journal:'RP',url,evidence:{version:2,text:title,catalog_url:task.url}},
      {doi:'10.1016/j.respol.2026.109999',title:'Unreviewed paper',journal:'RP',url:url.replace('0555','9999'),evidence:{version:2,text:'Unreviewed paper',catalog_url:task.url}}]};
  const data={kind:'paper_project',workflow_run_id:run.id,records:[],catalog:{pages:[page],cursor:1,queue:[{task_id:task.id,url:task.url}],scope_task_ids:[task.id]},ai_review_results:{},catalog_review_results:{}};
  const plan=await prepareReviewPlan(makeReviewJobs(data.catalog,null)),job=plan.jobs.find(j=>j.input.identity.doi===doi);
  data.catalog_review_results[job.hash]={input:job.input,verdict:validateReviewOutput(job.input,{identity_match:true,fields:{title:{status:'confirmed',spans:[{block_id:'card',quote:title}]}}})};
  const collector=createLocalCollector({repositoryRoot:repo,stateDir,config,coordinator:c,pythonExecutable:'test-python',requestReview:()=>{throw Error('not needed');},
    spawnImpl:()=>{child=new EventEmitter();return child;}});
  await assert.rejects(collector.start({scope:'articles',catalog_run_id:run.id}),/目录尚未完成提交/);
  await c.submit(run.id,data);await drain(c);assert.ifError(failure);
  assert.equal((await c.status()).runs.find(r=>r.id===run.id).phase,'waiting_for_cloud');
  await collector.start({scope:'articles',catalog_run_id:run.id});
  const current=await collector.current(),pythonPlan=JSON.parse(await fs.readFile(path.join(current.dir,'plan.json'),'utf8'));
  assert.deepEqual(pythonPlan.jobs.map(j=>[j.kind,j.doi]),[['article',doi]]);
  assert.equal(pythonPlan.interval_seconds,3);
  assert.equal((await c.run(current.id)).run.catalog_run_id,run.id);
  assert.equal((await c.run(current.id)).run.direct_pages.length,1);
  child.emit('exit',0);
});
