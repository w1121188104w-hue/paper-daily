import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeWorkflowJson} from './workflowStorage.js';
import {assertLibrary} from './libraryValidation.js';

// A protocol upgrade must not turn saved captures into new paid review work.
// Freeze the original evidence, rather than mutable review-input fingerprints.
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const file=dir=>path.join(dir,'review-policy.json');
export const newCaptureReviewPolicy=()=>({version:1,mode:'new_captures_only',archived_at:null,
  catalog_pages:[],article_records:[],historical_reviews:{total:0,done:0,attention:0}});
function archivedPolicy(data,cache){
  const reviews=Object.values(cache);
  return {...newCaptureReviewPolicy(),archived_at:new Date().toISOString(),
    catalog_pages:(data.catalog?.pages||[]).map(fingerprint),article_records:(data.records||[]).map(fingerprint),
    historical_reviews:{total:reviews.length,done:reviews.filter(r=>!r.error&&r.verdict?.status==='source_checked_candidate').length,
      attention:reviews.filter(r=>r.error||r.verdict?.status!=='source_checked_candidate').length}};
}
export async function initializeCaptureReviewPolicy(dir,{pages=[],results={}}={}){
  const policy=pages.length?archivedPolicy({catalog:{pages},records:[]},results):newCaptureReviewPolicy();
  await fs.mkdir(dir,{recursive:true});
  // Never reset an archive when initialization is retried.
  try{await fs.writeFile(file(dir),JSON.stringify(policy)+'\n',{flag:'wx'});}
  catch(e){if(e.code!=='EEXIST')throw e;}
}
export async function captureReviewPolicy(dir,data,cache={}){
  let policy;
  try{policy=JSON.parse(await fs.readFile(file(dir),'utf8'));}
  catch(e){
    if(e.code!=='ENOENT')throw e;
    policy=archivedPolicy(data,cache);
    await writeWorkflowJson(file(dir),policy);
  }
  assertLibrary(policy.version===1&&policy.mode==='new_captures_only'&&
    [policy.catalog_pages,policy.article_records].every(list=>Array.isArray(list)&&list.every(h=>/^[a-f0-9]{64}$/.test(h)))&&
    ['total','done','attention'].every(k=>Number.isSafeInteger(policy.historical_reviews?.[k])&&policy.historical_reviews[k]>=0)&&
    (policy.archived_at===null?policy.catalog_pages.length+policy.article_records.length+policy.historical_reviews.total===0:
      typeof policy.archived_at==='string'&&Number.isFinite(Date.parse(policy.archived_at)))&&
    policy.historical_reviews.done+policy.historical_reviews.attention===policy.historical_reviews.total,
  '旧采集审核保护记录无效；停止调用');
  return policy;
}
export function newCaptureReviewData(data,policy){
  if(!policy.archived_at)return data;
  const oldPages=new Set(policy.catalog_pages),oldRecords=new Set(policy.article_records);
  const pages=(data.catalog.pages||[]).filter(p=>!oldPages.has(fingerprint(p)));
  const records=(data.records||[]).filter(r=>!oldRecords.has(fingerprint(r)));
  // Keep the entire saved snapshot on disk. Only fresh evidence enters the
  // current reviewer/export, so old verdicts cannot acquire new authority.
  const freshTasks=new Set(pages.map(p=>p.task_id));
  const queue=(data.catalog.queue||[]).filter(j=>freshTasks.has(j.task_id));
  const cursor=(data.catalog.queue||[]).slice(0,data.catalog.cursor).filter(j=>freshTasks.has(j.task_id)).length;
  return {...data,records,catalog:{...data.catalog,pages,queue,cursor,scope_task_ids:[...freshTasks]}};
}
export function captureReviewCounts(policy,{total=0,done=0,pending=0,attention=0}={}){
  const old=policy.historical_reviews;
  return {review_total:old.total+total,review_done:old.done+done,review_pending:pending,
    review_attention:old.attention+attention,historical_review_total:old.total,historical_review_done:old.done,
    historical_captures_retained:policy.catalog_pages.length+policy.article_records.length,
    review_policy:'new_captures_only'};
}
