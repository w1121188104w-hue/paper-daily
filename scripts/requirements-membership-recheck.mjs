// One targeted acceptance recheck after fixing repeated-title proof validation.
// Older provider caches did not retain raw output, so discarded spans cannot be replayed.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createSourceReviewer} from '../tools/browser-abstract-extension/review-provider.mjs';
import {reviewJob} from '../src/services/sourceReview.js';
const dir=path.resolve(import.meta.dirname,'../data/acceptance/2026-10-05-deepseek/batch');
const data=JSON.parse(await fs.readFile(path.join(dir,'cases.json'),'utf8')),jobs=[];
for(const job of data.jobs.filter(j=>j.input.kind==='catalog')){
  const result=JSON.parse(await fs.readFile(path.join(dir,'results',job.hash+'.json'),'utf8'));
  if(result.verdict?.status==='source_checked_candidate'&&!result.verdict.catalog_membership)jobs.push({job,result});
}
const archive=path.join(dir,'membership-before-recheck');await fs.mkdir(archive,{recursive:true});
for(const {job,result} of jobs){try{await fs.writeFile(path.join(archive,job.hash+'.json'),JSON.stringify(result),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}}
console.log(JSON.stringify({stage:'membership_recheck',jobs:jobs.length}));
let index=0,done=0,calls=0,resolved=0;
const request=async(...args)=>{calls++;return fetch(...args);};
await Promise.all(Array.from({length:6},async()=>{
  const provider=createSourceReviewer({apiKey:process.env.DEEPSEEK_API_KEY,stateDir:path.join(dir,'membership-proof-repair'),fetchImpl:request,maxCalls:1000});
  while(index<jobs.length){
    const {job}=jobs[index++];const {result}=await reviewJob(job.input,async input=>(await provider.review(input)).data);
    await fs.writeFile(path.join(dir,'results',job.hash+'.json'),JSON.stringify(result));
    done++;if(result.verdict?.catalog_membership)resolved++;
    if(done%25===0||done===jobs.length)console.log(JSON.stringify({done,total:jobs.length,calls,resolved}));
    if(result.global_failure)throw Error(result.error);
  }
}));
