import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadJournalConfig} from '../src/services/journals.js';
import {normalizeSourceRecord} from '../src/services/paperModel.js';
import {sourceReviewInput,reviewedSource,reviewJob} from '../src/services/sourceReview.js';
import {enqueueSourceReviews,processSourceReviews,readSourceReviewQueue,saveSourceReviewQueue} from '../src/services/sourceReviewQueue.js';
import {readJournalLibrary} from '../src/services/journalLibrary.js';
import {readCloudQueue} from '../src/services/cloudPublication.js';
import {createSourceReviewer} from '../tools/browser-abstract-extension/review-provider.mjs';
import {validateReviewInput} from '../tools/browser-abstract-extension/review-core.js';
const config=await loadJournalConfig(),journal=config.journals.find(j=>j.key==='RP');
const abstract='We study firm investment using evidence from financial markets. The results suggest that credit supply affects investment across firms and regions. This study provides new evidence on the information environment and the allocation of capital.';
function source(extra={}){return normalizeSourceRecord({source:'crossref',source_id:'10.1016/j.respol.2026.105555',doi:'10.1016/j.respol.2026.105555',title:'Credit markets and firm investment',abstract,
  authors:[{name:'Jane Doe'},{name:'John Smith'}],publication_date:'2026-10-01',published_online_date:'2026-09-20',
  journal_key:journal.key,journal_name:journal.name,journal_category:journal.category,journal_category_zh:journal.category_zh,
  print_issn:journal.print_issn,electronic_issn:journal.electronic_issn,last_checked_at:new Date().toISOString(),url:'https://doi.org/10.1016/j.respol.2026.105555',type:'journal-article',...extra});}
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'unified-source-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
function providerResponse(options){const input=JSON.parse(JSON.parse(options.body).messages[1].content),fields={};
  for(const name of ['title','doi','authors','publication_date','published_online_date','published_print_date','volume','issue','pages','type']){
    const b=input.blocks.find(b=>b.id===name.replaceAll('_','-'));
    if(b)fields[name]={status:'confirmed',spans:[{block_id:b.id,quote:b.text}]};
  }
  if(input.blocks.some(b=>b.id==='abstract'))fields.abstract={status:'confirmed',block_ids:['abstract']};
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({identity_match:true,fields})}}],usage:{prompt_tokens:10,completion_tokens:10}}));
}
test('same plugin provider performs real-shaped source review, caches unchanged evidence, and rejects forged proof',async t=>{
  const repo=await temp(t);let calls=0;
  const service=createSourceReviewer({apiKey:'test-placeholder-key',stateDir:repo,fetchImpl:async(url,opts)=>{calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');return providerResponse(opts);}});
  const request=async input=>(await service.review(input)).data,r=source(),input=sourceReviewInput(r);
  const first=await reviewJob(input,request),second=await reviewJob(sourceReviewInput({...r,last_checked_at:'2027-01-01T00:00:00Z'}),request);
  assert.equal(calls,1);assert.equal(second.result.cached,true);
  const accepted=reviewedSource(r,input,first.result);assert.equal(accepted.abstract,abstract);assert.equal(accepted.published_online_date,'2026-09-20');assert.equal(accepted.authors.length,2);
  const forged=structuredClone(first.result);forged.input.identity.title='Different work';assert.equal(reviewedSource(r,input,forged),null);
  assert.throws(()=>validateReviewInput({...input,source_url:'https://api.crossref.org.evil.test/works/one'}));
});
test('automatic partial record publishes independently; later fields merge; repeat costs and imports nothing',async t=>{
  const repo=await temp(t),root=path.join(repo,'data/journal-store');let calls=0;
  const service=createSourceReviewer({apiKey:'test-placeholder-key',stateDir:path.join(repo,'provider'),fetchImpl:async(u,o)=>{calls++;return providerResponse(o);}});
  const request=async input=>(await service.review(input)).data;
  await enqueueSourceReviews(repo,[source({abstract:'',authors:[],publication_date:'',published_online_date:''})]);
  const pending=await processSourceReviews(repo,config);assert.equal(pending.imported.committed,false);assert.equal((await readJournalLibrary({root,config})).papers.length,0);
  const first=await processSourceReviews(repo,config,{request});assert.equal(first.imported.stats.added,1);
  let lib=await readJournalLibrary({root,config});assert.equal(lib.papers[0].abstract_original,'');assert.equal((await readCloudQueue(repo)).requests.length,1);
  await enqueueSourceReviews(repo,[source()],{papers:lib.papers,branch:'python'});
  const second=await processSourceReviews(repo,config,{request});assert.equal(second.imported.stats.abstracts_filled,1);assert.equal(second.imported.stats.metadata_filled,1);
  lib=await readJournalLibrary({root,config});assert.equal(lib.papers.length,1);assert.equal(lib.papers[0].authors.length,2);assert.equal(lib.papers[0].abstract_original,abstract);
  const again=await processSourceReviews(repo,config,{request});assert.equal(again.imported.committed,false);assert.equal(calls,2);
  assert.equal((await readCloudQueue(repo)).requests.length,2);assert.ok((await readSourceReviewQueue(repo)).jobs.every(j=>j.status==='reviewed'));
});
test('unknown billed request is held across restart; a failed article does not stop another article',async t=>{
  const repo=await temp(t);let calls=0;
  const service=createSourceReviewer({apiKey:'test-placeholder-key',stateDir:repo,beforeRequest:async()=>{throw Error('checkpoint interrupted');},fetchImpl:async(u,o)=>{calls++;return providerResponse(o);}});
  const input=sourceReviewInput(source());assert.equal((await service.review(input)).code,500);
  const resumed=createSourceReviewer({apiKey:'test-placeholder-key',stateDir:repo,fetchImpl:async(u,o)=>{calls++;return providerResponse(o);}});
  assert.equal((await resumed.review(input)).data.error,'ATTEMPT_UNFINISHED');assert.equal(calls,0);
  const another=sourceReviewInput(source({source_id:'10.1016/j.respol.2026.105556',doi:'10.1016/j.respol.2026.105556'}));
  assert.equal((await resumed.review(another)).data.verdict.status,'source_checked_candidate');assert.equal(calls,1);
});

test('unbilled limit resumes without a paid retry header; latest proof survives interruption before import',async t=>{
  const repo=await temp(t),root=path.join(repo,'data/journal-store');
  const service=createSourceReviewer({apiKey:'test-placeholder-key',stateDir:path.join(repo,'provider'),fetchImpl:async(u,o)=>providerResponse(o)});
  const input=sourceReviewInput(source());
  const resumed=await reviewJob(input,async(i,options)=>{assert.equal(options.retryAttempt,undefined);return (await service.review(i)).data;},
    {cached:{error:'SESSION_LIMIT',attempt:1},retry:true});
  assert.equal(resumed.result.error,null);
  await enqueueSourceReviews(repo,[source({abstract:'',authors:[]}),source()]);
  let saves=0;
  await assert.rejects(processSourceReviews(repo,config,{request:async i=>(await service.review(i)).data,checkpoint:async()=>{if(++saves===2)throw Error('crash');}}));
  assert.equal((await readJournalLibrary({root,config})).papers.length,0);
  await processSourceReviews(repo,config,{request:async()=>{throw Error('must reuse proof');}});
  const paper=(await readJournalLibrary({root,config})).papers[0];
  assert.equal(paper.abstract_original,abstract);assert.equal(paper.authors.length,2);
  await processSourceReviews(repo,config);
  assert.equal((await readCloudQueue(repo)).requests.length,1);
});

test('online scope skips old evidence before review and never imports an unknown first-online date',async t=>{
  const repo=await temp(t),now=new Date('2026-10-05T13:00:00Z'),root=path.join(repo,'data/journal-store');let calls=0;
  const old=await enqueueSourceReviews(repo,[source({published_online_date:'2026-08-04'})],{enforceCollectionScope:true,now});
  assert.equal(old.queued,0);assert.equal(old.rejected.length,1);
  await enqueueSourceReviews(repo,[source({published_online_date:''})],{enforceCollectionScope:true,now});
  const service=createSourceReviewer({apiKey:'test-placeholder-key',stateDir:path.join(repo,'provider'),fetchImpl:async(u,o)=>{calls++;return providerResponse(o);}});
  const unknown=await processSourceReviews(repo,config,{request:async i=>(await service.review(i)).data});
  assert.equal(unknown.imported.committed,false);assert.equal((await readJournalLibrary({root,config})).papers.length,0);assert.equal(calls,1);
  await enqueueSourceReviews(repo,[source({published_online_date:'2026-08-05'})],{enforceCollectionScope:true,now});
  await processSourceReviews(repo,config,{request:async i=>(await service.review(i)).data});
  assert.equal((await readJournalLibrary({root,config})).papers[0].published_online_date,'2026-08-05');assert.equal(calls,2);
});

test('saved legacy source reviews replay without changing their evidence fingerprint or paying again',async t=>{
  const repo=await temp(t),record=source(),input=sourceReviewInput(record,{legacy:true});
  assert.equal(input.blocks.find(b=>b.id==='abstract').context,'source:abstract; candidate extracted from raw_abstract');
  const service=createSourceReviewer({apiKey:'test-placeholder-key',stateDir:path.join(repo,'provider'),fetchImpl:async(u,o)=>providerResponse(o)});
  const {hash,result}=await reviewJob(input,async i=>(await service.review(i)).data);
  await saveSourceReviewQueue(repo,{version:1,jobs:[{id:hash,input,record,status:'reviewed',result}]});
  const out=await processSourceReviews(repo,config,{request:()=>assert.fail('must reuse saved review')});
  assert.equal(out.imported.stats.added,1);
});
