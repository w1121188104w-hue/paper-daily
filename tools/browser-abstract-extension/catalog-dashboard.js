import {ACTIVE_CATALOG_TASKS,mergeCatalog} from './catalog-core.js';
import {workflowId,storedRun,catalogKey,workflowRequest} from './workflow-client.js';
import {CatalogEngine} from './catalog-engine.js';
import {readCatalogDocument} from './catalog-extractor.js';
import {makeReviewJobs,reviewedCatalogPapers} from './review-core.js';
import {mountAutoReview,prepareReviewPlan,REVIEW_KEY,reviewFingerprint} from './review-client.js';
const $=id=>document.getElementById(id),runId=workflowId();
let controller,autoReview,writable=false,papers=null,tasks=[],transitioning=false,armed=true;
let submitting=false,nextSubmit=0,lastSubmitted='';
async function checkpointCatalog(stored,plan){
  if(submitting||Date.now()<nextSubmit)return;submitting=true;
  try{
    const results=Object.fromEntries(plan.jobs.filter(j=>stored[j.hash]).map(j=>[j.hash,stored[j.hash]]));
    if(!Object.values(results).some(r=>r.verdict?.status==='source_checked_candidate'))return;
    const data={kind:'paper_project',workflow_run_id:runId,records:[],catalog:structuredClone(controller.s),catalog_review_results:results,ai_review_results:{}};
    const fingerprint=await reviewFingerprint(data);if(fingerprint===lastSubmitted)return;
    await workflowRequest('/checkpoint',{id:runId,data});lastSubmitted=fingerprint;nextSubmit=Date.now()+30000;
  }catch{nextSubmit=Date.now()+30000;}
  finally{submitting=false;}
}
async function enterDetails(){
  if(transitioning)return;transitioning=true;autoReview.close();
  location.href=`dashboard.html?queue=catalog&autostart=1&run=${runId}`;
}
function render(s){
  $('status').textContent=s.reason;$('current').textContent=controller.task()?`当前：${controller.task().journal} · ${controller.task().label}`:'目录读取结束，正在核对。';
  const all=papers||mergeCatalog(s.pages);
  $('counts').textContent=`目录进度 ${s.cursor} / ${s.queue.length} 页 · 条目 ${all.length} · 官网直读 ${s.pages.filter(p=>p.direct_read).length} 页`;
  for(const id of ['start','skip','retry','recheck'])$(id).disabled=!writable||s.mode==='running';
  $('pause').disabled=!writable||s.mode!=='running';$('manual-link').hidden=!controller.current();
  if(controller.current())$('manual-link').href=controller.current().url;
  $('catalogs').replaceChildren(...tasks.map(t=>{
    const box=document.createElement('article'),h=document.createElement('h3');h.textContent=`${t.journal} · ${t.label}`;box.append(h);
    box.hidden=$('collection-filter').value!=='all'&&$('collection-filter').value!==t.collection;
    const p=document.createElement('p'),pages=s.pages.filter(p=>p.task_id===t.id);p.textContent=pages.map(p=>`${p.direct_read?'官网直读':'浏览器'}：${p.items.length} 条 · ${p.status}`).join('；')||'等待采集';box.append(p);
    const detail=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('ol');summary.textContent='查看条目';
    for(const item of all.filter(p=>p.catalog_memberships?.some(m=>m.task_id===t.id))){const li=document.createElement('li'),a=document.createElement('a');a.href=item.url;a.target='_blank';a.rel='noopener';a.textContent=item.title;li.append(a,document.createTextNode(` · ${item.doi||'DOI 待补'} · ${item.review_status==='source_checked_candidate'?'原文已核对':'待核对'}`));list.append(li);}
    detail.append(summary,list);box.append(detail);return box;
  }));
}
async function refreshReviewed(){
  const stored=(await chrome.storage.local.get(REVIEW_KEY))[REVIEW_KEY]||{},plan=await prepareReviewPlan(makeReviewJobs(controller.s,null),stored);
  papers=reviewedCatalogPapers(controller.s,plan,stored);render(controller.s);
  await checkpointCatalog(stored,plan);
  if(armed&&controller.s.mode==='done'&&!autoReview.isRunning()&&['done','done_with_errors'].includes(autoReview.getState().phase))await enterDetails();
}
async function boot(){
  if(!runId){location.replace('workflow.html');return;}
  const run=await storedRun(runId),key=catalogKey(runId),session=key+'_owned_tab';tasks=ACTIVE_CATALOG_TASKS.filter(t=>run.jobs.some(j=>j.catalog_id===t.id));
  document.querySelector('.tag').textContent='PAPER DAILY · '+chrome.runtime.getManifest().version;
  controller=new CatalogEngine({autoResumeVerification:true,now:()=>Date.now(),render,load:async()=>(await chrome.storage.local.get(key))[key],save:v=>chrome.storage.local.set({[key]:v}),
    loadSession:async()=>(await chrome.storage.session.get(session))[session],saveSession:v=>chrome.storage.session.set({[session]:v}),
    createTab:url=>chrome.tabs.create({url,active:true}),getTab:id=>chrome.tabs.get(id),navigate:(id,url)=>chrome.tabs.update(id,{url}),
    inspect:async tabId=>{const r=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},func:readCatalogDocument});if(!r[0]?.result)throw Error('No capture');return r[0].result;}});
  for(const id of ['start','pause','skip','retry','recheck'])$(id).onclick=async()=>{
    if(!writable)return;try{armed=id!=='pause';if(armed)autoReview.reset();else autoReview.stop();papers=null;await controller[id]();
      if(['retry','recheck'].includes(id))await controller.start();
    }catch{$('status').textContent='操作未完成；已有结果保留。';}
  };
  $('collection-filter').onchange=()=>render(controller.s);
  $('export').onclick=async()=>{const data={kind:'paper_catalog_backup',workflow_run_id:runId,catalog:controller.s,...await autoReview.export()},u=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download=`paper-catalog-${runId}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(u),30000);};
  await navigator.locks.request('paper-abstract-controller',{ifAvailable:true},async lock=>{
    if(!lock){$('status').textContent='另一任务面板正在采集，请回到原面板。';return;}
    writable=true;await controller.init();autoReview=mountAutoReview(()=>makeReviewJobs(controller.s,null),'catalog-'+runId,refreshReviewed);
    await refreshReviewed();
    if(new URL(location.href).searchParams.get('autostart')==='1'){history.replaceState(null,'',`catalog.html?run=${runId}`);await controller.start();}
    const listener=(m,sender,reply)=>{
      if(m?.type!=='catalog-adopt-manual'||sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('action-popup.html')||!writable)return;
      if(!tasks.some(t=>t.id===m.taskId)){reply({message:'该目录不属于当前批次。'});return;}
      armed=true;autoReview.reset();controller.adoptManual(m.tabId,m.taskId).then(()=>reply({message:controller.s.reason})).catch(e=>reply({message:e.message}));return true;
    };
    chrome.runtime.onMessage.addListener(listener);
    const changed=(c,area)=>{if(area==='local'&&c[REVIEW_KEY])void refreshReviewed();};chrome.storage.onChanged.addListener(changed);
    const removed=id=>void controller.tabClosed(id).catch(()=>{});chrome.tabs.onRemoved.addListener(removed);
    const timer=setInterval(()=>void controller.tick().then(()=>{if(controller.s.mode==='running')papers=null;autoReview.tick(controller.s.mode);}).catch(()=>{$('status').textContent='读取或保存未成功，已有结果保留。';}),2000);
    await new Promise(resolve=>window.addEventListener('pagehide',()=>{clearInterval(timer);autoReview.close();chrome.runtime.onMessage.removeListener(listener);chrome.storage.onChanged.removeListener(changed);chrome.tabs.onRemoved.removeListener(removed);writable=false;resolve();},{once:true}));
  });
}
boot().catch(()=>{$('status').textContent='无法恢复任务；原始结果未改动，请返回首页重试。';});
