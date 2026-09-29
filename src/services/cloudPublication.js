import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertLibrary} from './libraryValidation.js';
import {writeWorkflowJson} from './workflowStorage.js';

// Only IDs and operational receipts go to GitHub. Raw browser exports stay local.
export const CLOUD_QUEUE_PATH='data/collection-workflow/publication-queue.json';
export function validateCloudQueue(q){
  assertLibrary(q?.schema_version===1&&Array.isArray(q.requests)&&q.requests.length<=20000,'云端发布队列格式无效');
  const ids=new Set();
  for(const r of q.requests){
    assertLibrary(typeof r.id==='string'&&/^[a-f0-9-]{36}$/.test(r.id)&&!ids.has(r.id)&&
      /^[a-f0-9]{64}$/.test(r.input_sha256)&&/^[a-f0-9-]{36}$/.test(r.publication_id)&&
      ['pending','processing','translated','attention'].includes(r.status)&&Array.isArray(r.paper_ids)&&r.paper_ids.length<=20000&&
      r.paper_ids.every(id=>typeof id==='string'&&id.length<500)&&Number.isInteger(r.max_requests)&&r.max_requests>0&&r.max_requests<=1000&&
      Number.isInteger(r.rounds)&&r.rounds>=0&&Number.isFinite(Date.parse(r.created_at)),'云端发布任务无效');
    ids.add(r.id);
  }
  return q;
}
export async function readCloudQueue(repo){
  try{return validateCloudQueue(JSON.parse(await fs.readFile(path.join(repo,CLOUD_QUEUE_PATH),'utf8')));}
  catch(e){if(e.code==='ENOENT')return {schema_version:1,requests:[]};throw e;}
}
export async function saveCloudQueue(repo,q){await writeWorkflowJson(path.join(repo,CLOUD_QUEUE_PATH),validateCloudQueue(q));}
export async function enqueuePublication(repo,{id,inputHash,publicationId,paperIds,maxRequests=100,now=new Date()}){
  const q=await readCloudQueue(repo),old=q.requests.find(r=>r.id===id);
  const paper_ids=[...new Set(paperIds)].sort();
  if(old){assertLibrary(old.input_sha256===inputHash&&JSON.stringify(old.paper_ids)===JSON.stringify(paper_ids),'已上传批次内容不能改变');return old;}
  const r={id,input_sha256:inputHash,publication_id:publicationId,paper_ids,max_requests:maxRequests,rounds:0,
    status:'pending',created_at:now.toISOString(),updated_at:now.toISOString(),pending_fields:null};
  q.requests.push(r);await saveCloudQueue(repo,q);return r;
}
export const publicationInputHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Durable request accounting remains in translationAutomation; this queue never
 * resets reservations, unknown outcomes, retry limits, or existing translations. */
export async function processCloudPublications(repo,{translate,checkpoint,updateReceipt=async()=>{},now=()=>new Date()}){
  const q=await readCloudQueue(repo);let processed=0;
  for(const r of q.requests){
    if(!['pending','processing'].includes(r.status)||r.next_at&&Date.parse(r.next_at)>now().getTime())continue;
    if(r.rounds>=6){r.status='attention';r.code='CLOUD_ROUND_LIMIT';r.updated_at=now().toISOString();await updateReceipt(r);await saveCloudQueue(repo,q);await checkpoint();continue;}
    r.status='processing';r.rounds++;r.updated_at=now().toISOString();await saveCloudQueue(repo,q);await checkpoint();
    try{
      const result=await translate({paperIds:r.paper_ids,maxRequests:r.max_requests});
      r.pending_fields=(result.available_fields||0)+(result.held_fields||0);
      r.requested=(r.requested||0)+(result.requested_this_run||0);
      r.code=result.stop_reason||null;
      r.status=r.pending_fields===0?'translated':result.paused?'attention':(result.available_fields||0)>0&&r.rounds<6?'pending':'attention';
      r.next_at=r.status==='pending'?new Date(now().getTime()+30*60000).toISOString():null;
      await updateReceipt(r);
    }catch(e){
      // Unknown paid outcomes are held by the immutable reservation ledger.
      // Retrying this job does not authorize replay of those API requests.
      r.status='attention';r.code='CLOUD_TRANSLATION_FAILED';await updateReceipt(r);
    }
    r.updated_at=now().toISOString();await saveCloudQueue(repo,q);await checkpoint();processed++;
  }
  return {processed,pending:q.requests.filter(r=>r.status==='pending').length,attention:q.requests.filter(r=>r.status==='attention').length};
}
