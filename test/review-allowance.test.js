import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSourceReviewer,providerFingerprint,MAX_REVIEW_ALLOWANCE} from '../tools/browser-abstract-extension/review-provider.mjs';

test('extending an authorized review allowance preserves usage, cached decisions and unfinished request protection',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'review-allowance-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const budgetFile=path.join(dir,'budget.json');await fs.writeFile(budgetFile,JSON.stringify({version:1,calls:3000}));
  let paid=0;
  const opts={apiKey:'test-placeholder-key',stateDir:dir,budgetFile,maxCalls:6000,fetchImpl:async()=>{
    paid++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({identity_match:false,fields:{}})}}]}));
  }};
  const input={kind:'catalog',source_url:'https://www.sciencedirect.com/science/article/pii/S0048733326000555',
    identity:{title:'A newly collected article',journal:'RP'},blocks:[{id:'card',kind:'card',text:'A newly collected article'}]};
  let reviewer=createSourceReviewer(opts);await reviewer.ready();assert.equal(reviewer.calls,3000);
  assert.equal((await reviewer.review(input)).code,200);assert.equal(paid,1);assert.equal(reviewer.calls,3001);
  reviewer=createSourceReviewer(opts);await reviewer.ready();
  assert.equal((await reviewer.review(input)).data.cached,true);assert.equal(reviewer.calls,3001);assert.equal(paid,1);
  const unfinished={...input,identity:{...input.identity,title:'Previously reserved request'}};
  const fingerprint=providerFingerprint(unfinished);
  await fs.writeFile(path.join(dir,fingerprint+'.json'),JSON.stringify({fingerprint,error:'ATTEMPT_UNFINISHED',attempt:1}));
  assert.equal((await reviewer.review(unfinished)).data.error,'ATTEMPT_UNFINISHED');assert.equal(paid,1);
  assert.deepEqual(JSON.parse(await fs.readFile(budgetFile,'utf8')),{version:1,calls:3001});
  const exhausted=createSourceReviewer({...opts,maxCalls:3000});await exhausted.ready();
  assert.equal((await exhausted.review({...input,identity:{...input.identity,title:'Another new article'}})).code,429);
  for(const limit of [0,Infinity,MAX_REVIEW_ALLOWANCE+1])assert.throws(()=>createSourceReviewer({...opts,maxCalls:limit}),/INVALID_LIMIT/);
});
