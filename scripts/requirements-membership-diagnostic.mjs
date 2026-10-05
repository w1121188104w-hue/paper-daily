// Isolated diagnostic: preserve raw responses for previously missing membership proof.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createSourceReviewer} from '../tools/browser-abstract-extension/review-provider.mjs';
import {copyEvidenceSpans} from '../tools/browser-abstract-extension/review-core.js';
const dir=path.resolve(import.meta.dirname,'../data/acceptance/2026-10-05-deepseek/batch');
const data=JSON.parse(await fs.readFile(path.join(dir,'cases.json'),'utf8'));
const provider=createSourceReviewer({apiKey:process.env.DEEPSEEK_API_KEY,stateDir:path.join(dir,'membership-diagnostic'),maxCalls:3});
let count=0;
for(const job of data.jobs.filter(j=>j.input.kind==='catalog')){
  const previous=JSON.parse(await fs.readFile(path.join(dir,'results',job.hash+'.json'),'utf8'));
  if(previous.verdict?.catalog_membership)continue;
  const input={...job.input,acceptance_diagnostic:'Inspect missing catalog membership evidence, retaining the original source unchanged.'};
  const {data:result}=await provider.review(input);
  const raw=result.output?.catalog_membership;let proofError;
  try{copyEvidenceSpans(input.blocks,raw?.spans);}catch(e){proofError=e.message;}
  await fs.mkdir(path.join(dir,'membership-diagnostic'),{recursive:true});
  await fs.writeFile(path.join(dir,'membership-diagnostic',job.hash+'.json'),JSON.stringify({input,result},null,2));
  console.log(JSON.stringify({title:input.identity.title,raw,checked:result.verdict?.catalog_membership,proofError,error:result.error}));
  if(++count===3)break;
}
