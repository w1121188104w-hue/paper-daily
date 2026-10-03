import { ACTIVE_CATALOG_TASKS, catalogUrl } from './catalog-core.js';
import {REVIEW_KEY} from './review-client.js';
export const WORKFLOW_ORIGIN='http://127.0.0.1:17328';
export const runKey=id=>`paper_workflow_run_${id}`;
export const catalogKey=id=>`paper_workflow_catalog_${id}`;
export const detailKey=id=>`paper_workflow_detail_${id}`;
export function workflowId(){const id=new URL(location.href).searchParams.get('run');if(id&&!/^[a-f0-9-]{36}$/.test(id))throw Error('任务 ID 无效');return id;}
export async function workflowRequest(endpoint,body,fetchImpl=fetch){
  // Like bridgeHealth: extension GET can omit Origin; use POST even for status.
  // The service continues to reject requests without the configured Origin.
  let response;
  try{response=await fetchImpl(WORKFLOW_ORIGIN+endpoint,{method:'POST',headers:{'X-Paper-Workflow':'1','Content-Type':'application/json'},
    body:JSON.stringify(body??{}),signal:AbortSignal.timeout(30000)});}
  catch{throw Object.assign(Error('无法连接本机正式流程服务；请确认 start-workflow.cmd 已运行。'),{code:'WORKFLOW_CONNECTION'});}
  if(!response.ok)throw Object.assign(Error(response.status===403?'本地服务拒绝扩展来源，请核对扩展 ID；不是 API Key 错误。':`正式流程服务返回 HTTP ${response.status}；原有数据保留。`),{code:`WORKFLOW_HTTP_${response.status}`});
  try{return await response.json();}
  catch{throw Object.assign(Error('服务已响应，但返回格式无法读取；请检查插件与服务版本。'),{code:'WORKFLOW_RESPONSE'});}
}
export function workflowFailure(error,stage='request'){
  if(stage==='render')return '服务已连接，但任务页面显示失败；不是服务未启动。请保留页面并反馈此提示。';
  return /^WORKFLOW_(CONNECTION|RESPONSE|HTTP_\d+)$/.test(error?.code||'')?error.message:'正式流程请求未完成；请保留原有数据并反馈。';
}
export async function storedRun(id){
  let run=(await chrome.storage.local.get(runKey(id)))[runKey(id)];
  if(!run){run=(await workflowRequest('/run',{id})).run;await saveRun(run);}
  if(run?.id!==id||!Array.isArray(run.jobs)||run.jobs.some(j=>{const t=ACTIVE_CATALOG_TASKS.find(t=>t.id===j.catalog_id);return !t||catalogUrl(j.url,t)!==j.url;}))throw Error('正式任务清单缺失或无效；请回到正式流程入口');return run;
}
export function incrementalPapers(papers,run,now=Date.now()){
  return papers.filter(p=>{
    if(p.review_status!=='source_checked_candidate')return false;
    const old=run.known_papers.find(x=>x.doi&&x.doi===p.doi&&x.journal===p.journal);
    return !old?.complete&&(!old?.next_retry_at||Date.parse(old.next_retry_at)<=now);
  });
}
export async function saveRun(run){
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  if(run.catalog_review_results){const old=(await chrome.storage.local.get(REVIEW_KEY))[REVIEW_KEY]||{};
    await chrome.storage.local.set({[REVIEW_KEY]:{...run.catalog_review_results,...old}});}
  const existing=(await chrome.storage.local.get(catalogKey(run.id)))[catalogKey(run.id)];
  if(run.browser_snapshot&&!existing){
    const snapshot=run.browser_snapshot,records=snapshot.records||[];
    await chrome.storage.local.set({[catalogKey(run.id)]:snapshot.catalog});
    // Keep raw Python evidence available to the detail dashboard; its normal
    // queue reconciliation decides which articles still need browser work.
    await chrome.storage.local.set({['paper_python_records_'+run.id]:records});
  }
  const pages=run.direct_pages||[],directJobs=[...new Map(pages.map(p=>[p.task_id+'|'+p.requested_url,{task_id:p.task_id,url:p.requested_url,depth:0}])).values()];
  const browserJobs=run.jobs.filter(j=>!directJobs.some(d=>d.task_id===j.catalog_id&&d.url===j.url)).map(j=>({task_id:j.catalog_id,url:j.url,depth:0}));
  await chrome.storage.local.set({[runKey(run.id)]:run,...(!existing&&!run.browser_snapshot?{[catalogKey(run.id)]:{schema_version:1,mode:'paused',reason:'正式任务已建立；不会清除网站提醒。',
    run_started_at:run.created_at,scope_task_ids:[...new Set(run.jobs.map(j=>j.catalog_id))],
    queue:[...directJobs,...browserJobs],cursor:directJobs.length,pages,history:[]}}:{})});
}
