// Replay original provider responses through the corrected verifier without network access.
import fs from 'node:fs/promises';
import path from 'node:path';
import {providerFingerprint} from '../tools/browser-abstract-extension/review-provider.mjs';
import {validateReviewOutput} from '../tools/browser-abstract-extension/review-core.js';
import {checkedResponse} from '../tools/browser-abstract-extension/review-client.js';
const dir=path.resolve(import.meta.dirname,'../data/acceptance/2026-10-05-deepseek/batch');
const data=JSON.parse(await fs.readFile(path.join(dir,'cases.json'),'utf8'));let replayed=0,recovered=0;
for(const job of data.jobs){
  const fingerprint=providerFingerprint(job.input);
  for(const cache of ['membership-proof-repair','../review-provider']){
    let saved;try{saved=JSON.parse(await fs.readFile(path.join(dir,cache,fingerprint+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
    if(!saved.output)continue;
    const previous=JSON.parse(await fs.readFile(path.join(dir,'results',job.hash+'.json'),'utf8'));
    const result=checkedResponse(job.input,{...saved,verdict:validateReviewOutput(job.input,saved.output),cached:true});
    replayed++;if(!previous.verdict?.catalog_membership&&result.verdict?.catalog_membership)recovered++;
    await fs.writeFile(path.join(dir,'results',job.hash+'.json'),JSON.stringify(result));break;
  }
}
console.log(JSON.stringify({replayed,recovered,new_calls:0}));
