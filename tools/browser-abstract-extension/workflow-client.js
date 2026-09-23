import { ACTIVE_CATALOG_TASKS, catalogUrl } from './catalog-core.js';
export const WORKFLOW_ORIGIN='http://127.0.0.1:17328';
export const runKey=id=>`paper_workflow_run_${id}`;
export const catalogKey=id=>`paper_workflow_catalog_${id}`;
export const detailKey=id=>`paper_workflow_detail_${id}`;
export function workflowId(){const id=new URL(location.href).searchParams.get('run');if(id&&!/^[a-f0-9-]{36}$/.test(id))throw Error('任务 ID 无效');return id;}
export async function workflowRequest(endpoint,body){
  const response=await fetch(WORKFLOW_ORIGIN+endpoint,{method:body?'POST':'GET',headers:{'X-Paper-Workflow':'1',...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
  const result=await response.json();if(!response.ok)throw Error(result.message||'正式流程服务未完成请求');return result;
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
  const existing=(await chrome.storage.local.get(catalogKey(run.id)))[catalogKey(run.id)];
  await chrome.storage.local.set({[runKey(run.id)]:run,...(!existing?{[catalogKey(run.id)]:{schema_version:1,mode:'paused',reason:'正式任务已建立；不会清除网站提醒。',cursor:0,
    run_started_at:run.created_at,scope_task_ids:[...new Set(run.jobs.map(j=>j.catalog_id))],
    queue:run.jobs.map(j=>({task_id:j.catalog_id,url:j.url,depth:0})),pages:[],history:[]}}:{})});
}
