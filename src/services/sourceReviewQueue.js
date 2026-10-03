import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertLibrary} from './libraryValidation.js';
import {writeWorkflowJson} from './workflowStorage.js';
import {sourceReviewInput,reviewJob,reviewedSource,hasNewSourceFields,missingPaperFields} from './sourceReview.js';
import {reviewFingerprint} from '../../tools/browser-abstract-extension/review-client.js';
import {canRetryReview} from '../../tools/browser-abstract-extension/retry-policy.js';
import {readJournalLibrary} from './journalLibrary.js';
import {importBrowserExport} from './browserImport.js';
import {enqueuePublication,publicationInputHash} from './cloudPublication.js';
import {reconcileFieldTasks} from './collectionFieldTasks.js';
export const REVIEW_QUEUE_PATH='data/collection-workflow/source-review.json';
export const REVIEW_PROVIDER_PATH='data/collection-workflow/review-provider';
export function validateSourceReviewQueue(q){
  assertLibrary(q?.version===1&&Array.isArray(q.jobs)&&q.jobs.length<=20000,'来源审核队列无效');
  const seen=new Set();
  for(const j of q.jobs){
    assertLibrary(/^[a-f0-9]{64}$/.test(j.id)&&!seen.has(j.id)&&j.record&&j.input&&
      ['pending','reviewed','attention'].includes(j.status),'来源审核条目无效');seen.add(j.id);
  }
  return q;
}
export async function readSourceReviewQueue(repo){
  try{const file=path.join(repo,REVIEW_QUEUE_PATH);assertLibrary((await fs.stat(file)).size<=128*1024*1024,'来源审核队列需要归档');
    return validateSourceReviewQueue(JSON.parse(await fs.readFile(file,'utf8')));}
  catch(e){if(e.code==='ENOENT')return {version:1,jobs:[]};throw e;}
}
export const saveSourceReviewQueue=(repo,q)=>writeWorkflowJson(path.join(repo,REVIEW_QUEUE_PATH),validateSourceReviewQueue(q));
export async function enqueueSourceReviews(repo,records,{papers=[],branch='automatic'}={}){
  const q=await readSourceReviewQueue(repo),rejected=[];
  for(const record of records){
    if(!hasNewSourceFields(record,papers))continue;
    try{
      const input=sourceReviewInput(record),id=await reviewFingerprint(input);
      if(q.jobs.some(j=>j.id===id))continue;
      q.jobs.push({id,record,input,branch,status:'pending',created_at:new Date().toISOString(),result:null});
    }catch{rejected.push({doi:record.doi,journal:record.journal_key,reason:'review_evidence_invalid'});}
  }
  q.rejected=[...(q.rejected||[]),...rejected].slice(-20000);
  await saveSourceReviewQueue(repo,q);return {queued:q.jobs.filter(j=>j.status==='pending').length,rejected};
}
/** Callers serialize library/Git writes; each reviewed item is independent. */
export async function processSourceReviews(repo,config,{root=path.join(repo,'data/journal-store'),request,maxJobs=500,
  checkpoint=async()=>{},onProgress=()=>{},retry=true}={}){
  const q=await readSourceReviewQueue(repo),sources=[],decisions=[];let processed=0;
  for(const job of q.jobs){
    if(job.status==='reviewed'&&!(retry&&canRetryReview(job.result)))continue;
    if(processed>=maxJobs)break;
    if(!request){job.status='attention';job.error='REVIEW_SERVICE_UNAVAILABLE';continue;}
    try{
      const original=sourceReviewInput(job.record);
      assertLibrary(await reviewFingerprint(original)===job.id&&await reviewFingerprint(job.input)===job.id,'来源审核证据已变化');
      const {result}=await reviewJob(job.input,request,{retry,cached:job.result});
      job.result=result;job.updated_at=new Date().toISOString();processed++;
      const source=reviewedSource(job.record,job.input,result);
      job.status=source?'reviewed':'attention';job.error=result.error||(!source?'IDENTITY_OR_FIELDS_UNCONFIRMED':null);
      if(source)sources.push(source);
      else decisions.push({doi:job.record.doi,journal_key:job.record.journal_key,action:'skipped',reason:job.error});
    }catch{job.status='attention';job.error='REVIEW_NOT_COMPLETE';}
    await saveSourceReviewQueue(repo,q);await checkpoint();
    onProgress({source_review:job.id,status:job.status,processed});
    if(['SESSION_LIMIT','PROVIDER_HTTP_401','PROVIDER_HTTP_402','PROVIDER_HTTP_403','PROVIDER_HTTP_429'].includes(job.error))break;
  }
  // A prior interruption after review but before import replays the saved proof,
  // without another provider call or losing previously accepted partial fields.
  const latestSources=new Map();
  for(const job of q.jobs.filter(j=>j.status==='reviewed')){
    try{const source=reviewedSource(job.record,sourceReviewInput(job.record),job.result);
      if(source)latestSources.set(source.source+'|'+source.source_id,source);
    }catch{job.status='attention';job.error='SAVED_REVIEW_INVALID';}
  }
  sources.splice(0,sources.length,...latestSources.values());
  const prepared={input_sha256:publicationInputHash(sources),sources,decisions,raw_record_count:q.jobs.length};
  const imported=await importBrowserExport(config,{root,prepared,save:true});
  const library=await readJournalLibrary({root,config});
  const accepted=imported.decisions.filter(d=>['added','abstract_filled','metadata_filled','unchanged'].includes(d.action));
  if(accepted.length){
    const paperIds=library.papers.filter(p=>accepted.some(d=>p.journal_key===d.journal_key&&(d.doi?p.doi===d.doi:p.title_original===d.title))).map(p=>p.id);
    // Content-derived IDs recover an interruption between import and enqueue.
    // Replaying unchanged proof neither loses publication nor creates new jobs.
    const h=prepared.input_sha256,id=[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20,32)].join('-');
    await enqueuePublication(repo,{id,publicationId:randomUUID(),paperIds,inputHash:prepared.input_sha256});
    await reconcileFieldTasks(repo,library.papers,{paperIds,branch:'automatic'});
  }
  for(const job of q.jobs){const paper=library.papers.find(p=>p.journal_key===job.record.journal_key&&(job.record.doi?p.doi===job.record.doi:p.source_records.some(r=>r.source===job.record.source&&r.source_id===job.record.source_id)));
    job.missing_fields=paper?missingPaperFields(paper):['identity','abstract','authors','publication_date','affiliations'];}
  await saveSourceReviewQueue(repo,q);await checkpoint();
  return {processed,reviewed:q.jobs.filter(j=>j.status==='reviewed').length,pending:q.jobs.filter(j=>j.status!=='reviewed').length,imported};
}
