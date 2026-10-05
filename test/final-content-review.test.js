import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {makeReviewJobs,validateReviewInput,validateReviewOutput,reviewedCatalogCoverage} from '../tools/browser-abstract-extension/review-core.js';
import {reviewRecord} from '../tools/browser-abstract-extension/review-decisions.js';
import {prepareReviewPlan,checkedResponse,reviewFingerprint} from '../tools/browser-abstract-extension/review-client.js';
import {verdictOutput} from '../tools/browser-abstract-extension/article-review.js';
import {createSourceReviewer} from '../tools/browser-abstract-extension/review-provider.mjs';
const title='Who Pays for Unions?',doi='10.1093/qje/qjaa001',url='https://academic.oup.com/qje/article/135/1/1/1234';
function article(){return {records:[{title:title+'Get access',doi,journal:'QJE',url,source_url:url,identity:{ok:false,reason:'identity_unconfirmed'},evidence_version:2,
  evidence:[{id:'title',kind:'title',text:title},{id:'doi',kind:'doi',text:doi},{id:'short',kind:'abstract',text:'We find that unions raise wages.'},
    {id:'body',kind:'context',text:'Abstract\nWe estimate the response to a policy. The effect is positive.\nKeywords: policy'}]}]};}
test('unconfirmed parser identity reaches DeepSeek; semantic short abstract survives exact-span replay',()=>{
  const {jobs,skipped}=makeReviewJobs(null,article());assert.equal(jobs.length,1);assert.equal(skipped.length,0);
  const input=jobs[0].input,output={identity_match:true,fields:{title:{status:'corrected',spans:[{block_id:'title',quote:title}]},
    doi:{status:'confirmed',spans:[{block_id:'doi',quote:doi}]},abstract:{status:'confirmed',block_ids:['short']}}};
  const checked=validateReviewOutput(input,output);assert.equal(checked.fields.abstract,'We find that unions raise wages.');
  assert.equal(validateReviewOutput(input,verdictOutput(input,checked)).fields.abstract,checked.fields.abstract);
  const rejected=validateReviewOutput(input,{...output,identity_match:false});assert.equal(rejected.status,'identity_unconfirmed');
});
test('DeepSeek can select a complete abstract from context, but invented or edited text never becomes evidence',()=>{
  const input=makeReviewJobs(null,article()).jobs[0].input;
  const value={status:'corrected',role:'abstract',completeness:'complete',spans:[{block_id:'body',quote:'We estimate the response to a policy. The effect is positive.'}]};
  const verdict=validateReviewOutput(input,{identity_match:true,fields:{abstract:value}});
  assert.equal(verdict.fields.abstract,value.spans[0].quote);
  assert.equal(checkedResponse(input,{verdict}).verdict.fields.abstract,value.spans[0].quote);
  const invented=validateReviewOutput(input,{identity_match:true,fields:{abstract:{...value,spans:[{block_id:'body',quote:'Invented response to a policy.'}]}}});
  assert.equal(invented.fields.abstract,null);
});
test('missing abstract is a valid model judgment, not an automatic paid retry',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'final-review-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let calls=0;
  const service=createSourceReviewer({apiKey:'test-key-not-real-12345',stateDir:dir,fetchImpl:async()=>{
    calls++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({identity_match:true,fields:{abstract:{status:'missing',block_ids:[]}}})}}]}));
  }});
  const input=makeReviewJobs(null,article()).jobs[0].input;
  assert.equal((await service.review(input)).data.error,undefined);
  assert.equal((await service.review(input)).data.cached,true);assert.equal(calls,1);
});

test('an old verdict cannot replace the changed input containing a database correction target',async()=>{
  const captured=article(),legacy=makeReviewJobs(null,captured).jobs[0].legacy_input;
  const verdict=validateReviewOutput(legacy,{identity_match:true,fields:{title:{status:'confirmed',spans:[{block_id:'title',quote:title}]},doi:{status:'confirmed',spans:[{block_id:'doi',quote:doi}]},
    abstract:{status:'confirmed',spans:[{block_id:'body',quote:'We estimate the response to a policy. The effect is positive.'}]}}});
  const hash=await reviewFingerprint(legacy),cache={[hash]:{input:legacy,verdict}};
  captured.review_context={known_papers:[{id:'doi:'+doi,doi,journal_key:'QJE',title_original:title+'Get access',url,authors:[],abstract_original:'',source_records:[]}]};
  const plan=await prepareReviewPlan(makeReviewJobs(null,captured),cache);
  assert.notEqual(plan.jobs[0].hash,hash);assert.equal(plan.jobs[0].input.existing_records[0].title,title+'Get access');
});
test('whole catalog resolves cross-page matches and evidence-backed recommendations, retaining unread pagination',async()=>{
  const base={task_id:'catalog-5',journal:'QJE',source_url:'https://academic.oup.com/qje/issue/141/3',page_title:'Quarterly Journal of Economics',items:[{title,doi,url,journal:'QJE',evidence:{version:2,text:title}}]};
  const recommendation=url+'2',second=url+'3';
  const page={...base,unmatched_article_links:[recommendation,second],article_link_contexts:[{url:recommendation,text:'Recommended articles: Different study'}],warnings:['unmatched_article_links:2'],next_links:[base.source_url+'?page=3'],pagination_unresolved:true};
  const catalog={pages:[page,{...base,source_url:base.source_url+'?page=2',items:[{...base.items[0],url:second}]}]};
  const plan=await prepareReviewPlan(makeReviewJobs(catalog,null)),job=plan.jobs.find(j=>j.input.catalog_context.related_links.length);
  const verdict=validateReviewOutput(job.input,{identity_match:true,fields:{},catalog_links:[{url:recommendation,status:'out_of_scope',spans:[{block_id:'link-context-0',quote:'Recommended articles: Different study'}]}]});
  const result=reviewedCatalogCoverage(catalog,plan,{[job.hash]:{input:job.input,verdict}});
  assert.deepEqual(result[0].unmatched_article_links,[]);assert.equal(result[0].pagination_unresolved,true);assert.deepEqual(result[0].next_links,page.next_links);
});

test('large catalog keeps every card for cross-page review and enforces the transport byte limit',()=>{
  const page={task_id:'catalog-5',journal:'QJE',source_url:'https://academic.oup.com/qje/issue/141/3',
    page_title:'Quarterly Journal of Economics',items:Array.from({length:273},(_,i)=>({
      title:'Research on '+('economic policy '.repeat(16))+i,doi:'10.1093/qje/qjaa'+i,
      url:url+'/'+i,journal:'QJE',evidence:{version:2,text:'Research evidence '+i}}))};
  const {jobs,skipped}=makeReviewJobs({pages:[page]},null);
  assert.equal(skipped.length,0);assert.equal(jobs.length,273);
  const input=jobs[0].input;
  assert.ok(new TextEncoder().encode(JSON.stringify(input)).length>80000);
  assert.equal(input.catalog_context.cards.length,273);
  assert.equal(input.catalog_context.cards.at(-1).url,page.items.at(-1).url);
  assert.throws(()=>validateReviewInput({...input,catalog_context:{...input.catalog_context,extra:'测'.repeat(100000)}}),/OVERSIZE/);
  assert.throws(()=>validateReviewInput({...input,kind:'article'}),/OVERSIZE/);
});

test('repeated source captures do not crowd out distinct identity evidence',()=>{
  const source={source:'publisher',source_id:'one',url,title,doi};
  const record=reviewRecord({id:'paper-one',title_original:title,source_records:[source,{...source,last_checked_at:'2026-10-05'},
    {...source,source_id:'two',title:title+'Get access'}]});
  assert.equal(record.sources.length,2);assert.equal(record.sources[1].title,title+'Get access');
});

test('a repeated reviewed title remains usable for membership, but arbitrary repeated context does not',()=>{
  const catalog={pages:[{task_id:'catalog-5',journal:'QJE',source_url:'https://academic.oup.com/qje/issue/141/3',
    page_title:'Quarterly Journal of Economics',items:[{title,doi,url,journal:'QJE',evidence:{version:2,text:title+'\nSelect '+title+'\nRelated\nRelated'}}]}]};
  const input=makeReviewJobs(catalog,null).jobs[0].input;
  const output={identity_match:true,fields:{title:{status:'confirmed',spans:[{block_id:'card',quote:title}]}},
    catalog_membership:{status:'in_scope',spans:[{block_id:'card',quote:title}]}};
  assert.equal(validateReviewOutput(input,output).catalog_membership.status,'in_scope');
  output.catalog_membership.spans[0].quote='Related';
  assert.equal(validateReviewOutput(input,output).catalog_membership,null);
  input.blocks.push({id:'repeat-heading',kind:'context',context:'catalog_heading',text:'Volume 141, Issue 3 | Volume 141, Issue 3'});
  output.catalog_membership.spans=[{block_id:'repeat-heading',quote:'Volume 141, Issue 3'}];
  assert.equal(validateReviewOutput(input,output).catalog_membership.status,'in_scope');
});
