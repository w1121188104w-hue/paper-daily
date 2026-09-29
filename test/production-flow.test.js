import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseOfficialCatalog,readOfficialCatalog,hydrateRunFromOfficial,OFFICIAL_CACHE_PATH} from '../src/services/officialCatalog.js';
import {ACTIVE_CATALOG_TASKS} from '../tools/browser-abstract-extension/catalog-core.js';
import {readCloudQueue,enqueuePublication,processCloudPublications,enqueueManualBackfill} from '../src/services/cloudPublication.js';
import {writeWorkflowJson} from '../src/services/workflowStorage.js';
import {knownFeedSource,readOfficialFeeds} from '../src/services/officialFeeds.js';
import {loadJournalConfig} from '../src/services/journals.js';
const task=ACTIVE_CATALOG_TASKS.find(t=>t.journal==='TAR'&&t.collection==='online');
const article='https://publications.aaahq.org/accounting-review/article/doi/10.2308/TAR-2026-001/1/Test-article';
const card=`<div class="al-article-item"><h3><a href="${article}">An empirical investigation of capital allocation <span class="badge">FREE</span></a></h3><div class="al-authors-list">John Smith</div></div>`;
const response=(body,url=task.url)=>({url,requested_url:url,fetched_at:new Date().toISOString(),sha256:'a'.repeat(64),body:`<html><head><title>The Accounting Review</title></head><body>${body}</body></html>`});
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'production-flow-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('official catalog: exact journal cards only, no badges or recommendations',()=>{
  const p=parseOfficialCatalog(response(card+'<aside>'+card.replace('Test-article','Other')+'</aside>'),task);
  assert.equal(p.status,'catalog_candidates');assert.equal(p.items.length,1);assert.ok(!p.items[0].title.includes('FREE'));
  assert.equal(p.direct_read,true);assert.ok(p.items[0].evidence.text.includes(p.items[0].title));
});
test('official catalog: CAPTCHA, empty DOM, dynamic more button and wrong identity do not prove completion',async()=>{
  for(const body of ['',card+'<button>Load more</button>','<h1>Verify you are human</h1>',card+'<meta name="citation_issn" content="9999-9999">']){
    const r=await readOfficialCatalog(task,{request:async()=>response(body)});assert.equal(r.complete,false);
  }
});
test('official catalog follows only same-list pagination and rejects errors/limits',async()=>{
  let calls=0;
  const next=task.url+'?page=2';
  const r=await readOfficialCatalog(task,{request:async url=>{calls++;return response((url===task.url?card:card.replaceAll('Test-article','Second-article'))+(url===task.url?`<a rel="next" href="${next}">Next</a>`:''),url);}});
  assert.equal(calls,2);assert.equal(r.complete,true);
  const limited=await readOfficialCatalog(task,{request:async()=>response(card+`<a rel="next" href="${next}">Next</a>`)},{maxPages:1});assert.equal(limited.complete,false);
  assert.equal((await readOfficialCatalog(task,{request:async()=>{throw Object.assign(Error('private'),{code:'ACCESS_RESTRICTED'});}})).code,'ACCESS_RESTRICTED');
  const repeated=await readOfficialCatalog(task,{request:async url=>response(card+`<a rel="next" href="${next}">Next</a>`,url)});
  assert.equal(repeated.code,'REPEATED_PAGE');assert.equal(repeated.complete,false);
});
test('RSS known DOI + title can fill an abstract, but cannot import a new paper or manufacture a date',async()=>{
  const c=await loadJournalConfig(),j=c.journals.find(j=>j.key==='JF');
  const lead={doi:'10.1111/jofi.1234',title:'A source-backed study of investor behavior',url:'https://onlinelibrary.wiley.com/doi/10.1111/jofi.1234',date:'2026-09-29',date_role:'feed_update_date',authors:[],
    abstract:'This study examines investor behavior and market outcomes using administrative records and a policy change. We document the relationship between financial constraints, investment decisions, and the allocation of resources across firms.',evidence:{url:'https://onlinelibrary.wiley.com/feed/15406261/most-recent',scope_url:'https://onlinelibrary.wiley.com/feed/15406261/most-recent',method:'publisher_rss',fetched_at:new Date().toISOString(),body_sha256:'a'.repeat(64)}};
  assert.equal(knownFeedSource(lead,j,[]),null);
  const p={doi:lead.doi,journal_key:j.key,title_original:lead.title,abstract_original:''};
  assert.equal(knownFeedSource(lead,j,[p]).publication_date,'');
  assert.equal(knownFeedSource(lead,j,[{...p,title_original:'Unrelated article'}]),null);
  assert.equal(knownFeedSource(lead,j,[{...p,abstract_original:'Preserved'}]),null);
  const f=await readOfficialFeeds(j,{request:async()=>{throw Object.assign(Error(),{code:'ACCESS_RESTRICTED'});}});
  assert.equal(f.attempts[0].status,'failed');assert.equal(f.leads.length,0);
});
test('only fresh complete official evidence is reused; new signal invalidates older cache',async t=>{
  const dir=await temp(t),page=parseOfficialCatalog(response(card),task),now=Date.now();
  await writeWorkflowJson(path.join(dir,OFFICIAL_CACHE_PATH),{schema_version:1,catalogs:[{catalog_id:task.id,url:task.url,complete:true,checked_at:new Date(now).toISOString(),pages:[page]}]});
  const run={jobs:[{catalog_id:task.id,url:task.url}]};
  assert.equal((await hydrateRunFromOfficial(dir,run,{now})).direct_pages.length,1);
  assert.equal((await hydrateRunFromOfficial(dir,run,{now:now+25*3600000})).direct_pages.length,0);
  assert.equal((await hydrateRunFromOfficial(dir,{jobs:[{...run.jobs[0],signal_at:new Date(now+1000).toISOString()}]},{now})).direct_pages.length,0);
});
test('cloud queue checkpoints before translation; IDs only, exact retry idempotency, no local keys',async t=>{
  const dir=await temp(t),args={id:randomUUID(),publicationId:randomUUID(),inputHash:'a'.repeat(64),paperIds:['doi:10.1000/test']};
  await enqueuePublication(dir,args);await enqueuePublication(dir,args);assert.equal((await readCloudQueue(dir)).requests.length,1);
  await assert.rejects(enqueuePublication(dir,{...args,paperIds:['other']}));
  const order=[];
  await processCloudPublications(dir,{checkpoint:async()=>order.push('save'),translate:async()=>{order.push('translate');return {available_fields:0,held_fields:0,requested_this_run:1};}});
  assert.deepEqual(order,['save','translate','save']);assert.equal((await readCloudQueue(dir)).requests[0].status,'translated');
  await processCloudPublications(dir,{checkpoint:async()=>{},translate:async()=>{throw Error('duplicate billing');}});
});
test('cloud unknown/held outcomes require attention, never loop paid requests',async t=>{
  const dir=await temp(t);await enqueuePublication(dir,{id:randomUUID(),publicationId:randomUUID(),inputHash:'b'.repeat(64),paperIds:[]});
  let n=0;const opts={checkpoint:async()=>{},translate:async()=>{n++;return {available_fields:0,held_fields:2,stop_reason:'NO_UNATTEMPTED_TASKS'};}};
  await processCloudPublications(dir,opts);await processCloudPublications(dir,opts);
  assert.equal(n,1);assert.equal((await readCloudQueue(dir)).requests[0].status,'attention');
});

test('manual cloud backfill freezes current eligible IDs and reuses the same Actions run',async t=>{
  const dir=await temp(t),tasks=[{paper_id:'doi:10.1000/one',field:'title',source_text_hash:'a'.repeat(64)},
    {paper_id:'doi:10.1000/one',field:'abstract',source_text_hash:'b'.repeat(64)}];
  assert.equal(await enqueueManualBackfill(dir,{runId:'123',tasks:[]}),null);
  assert.equal((await readCloudQueue(dir)).requests.length,0);
  const first=await enqueueManualBackfill(dir,{runId:'123',tasks});
  assert.deepEqual(first.paper_ids,['doi:10.1000/one']);assert.equal(first.max_requests,1);
  const retry=await enqueueManualBackfill(dir,{runId:'123',tasks:[{...tasks[0],paper_id:'doi:10.1000/other'}]});
  assert.deepEqual(retry,first);assert.equal((await readCloudQueue(dir)).requests.length,1);
  await assert.rejects(enqueueManualBackfill(dir,{runId:'',tasks}));
  await assert.rejects(enqueueManualBackfill(dir,{runId:'456',tasks:[{...tasks[0],source_text_hash:'invalid'}]}));
});
test('production surfaces have no test entrypoints or manual publish stage; local workflow has no translator',async()=>{
  for(const file of ['action-popup.html','workflow.html','catalog.html','dashboard.html','review.html']){
    const html=await fs.readFile(new URL('../tools/browser-abstract-extension/'+file,import.meta.url),'utf8');assert.doesNotMatch(html,/trial|抽样|补测|旧版|测试|试验|导入、翻译并发布/);
  }
  const local=await fs.readFile(new URL('../scripts/collection-service.js',import.meta.url),'utf8');assert.doesNotMatch(local,/runTranslationAutomation|buildJournalSite/);
  const launch=await fs.readFile(new URL('../scripts/start-workflow.ps1',import.meta.url),'utf8');assert.doesNotMatch(launch,/SecureStringToBSTR|PtrToStringBSTR/);
});
