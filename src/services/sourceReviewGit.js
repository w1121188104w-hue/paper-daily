import fs from 'node:fs/promises';
import path from 'node:path';
import {REVIEW_QUEUE_PATH,REVIEW_PROVIDER_PATH,readSourceReviewQueue} from './sourceReviewQueue.js';
import {CATALOG_REVIEW_PATH,readCatalogReviews} from './catalogSourceReview.js';
import {WORKFLOW_PATH} from './collectionWorkflow.js';
import {OFFICIAL_CACHE_PATH} from './officialCatalog.js';
import {FIELD_TASKS_PATH,readFieldTasks} from './collectionFieldTasks.js';
export async function sourceReviewGitFiles(repo){
  const files=[];
  for(const file of [REVIEW_QUEUE_PATH,CATALOG_REVIEW_PATH,FIELD_TASKS_PATH]){
    try{await fs.stat(path.join(repo,file));await (file===REVIEW_QUEUE_PATH?readSourceReviewQueue(repo):file===FIELD_TASKS_PATH?readFieldTasks(repo):readCatalogReviews(repo));files.push(file);}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
  try{for(const name of await fs.readdir(path.join(repo,REVIEW_PROVIDER_PATH))){
    if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
    const row=JSON.parse(await fs.readFile(path.join(repo,REVIEW_PROVIDER_PATH,name),'utf8'));
    if(row.fingerprint!==name.slice(0,-5)||!Number.isInteger(row.attempt))throw Error('INVALID_PROVIDER_LEDGER');
    files.push(REVIEW_PROVIDER_PATH+'/'+name);
  }}catch(e){if(e.code!=='ENOENT')throw e;}
  return files;
}
export function makeSourceReviewCheckpoint(repo,git){
  return async()=>{
    const files=await sourceReviewGitFiles(repo);
    for(const f of [WORKFLOW_PATH,OFFICIAL_CACHE_PATH])try{await fs.stat(path.join(repo,f));files.push(f);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!files.length)return;
    await git(['add','-f','--pathspec-from-file=-','--pathspec-file-nul'],{input:files.join('\0')+'\0'});
    const staged=(await git(['diff','--cached','--name-only','-z'])).split('\0').filter(Boolean);
    if(staged.some(f=>!files.includes(f)))throw Error('REVIEW_CHECKPOINT_SCOPE');
    if(staged.length)await git(['-c','user.name=github-actions[bot]','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com','commit','-m','data: checkpoint source review evidence and billing']);
    await git(['push','origin','HEAD:refs/heads/master']);
  };
}
