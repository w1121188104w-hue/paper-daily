import {ACTIVE_CATALOG_TASKS,mergeCatalog} from './catalog-core.js';
import {workflowId,storedRun,catalogKey,workflowRequest} from './workflow-client.js';
import {CatalogEngine} from './catalog-engine.js';
import {readCatalogDocument} from './catalog-extractor.js';
import {makeReviewJobs,reviewedCatalogPapers} from './review-core.js';
import {mountAutoReview,prepareReviewPlan,REVIEW_KEY,reviewFingerprint} from './review-client.js';
const $=id=>document.getElementById(id),runId=workflowId();
let controller,autoReview,writable=false,papers=null,tasks=[],transitioning=false,armed=true;
let submitting=false,nextSubmit=0,lastSubmitted='',catalogOnly=false,completed=false,finalizing=false,frozenExport=null,retryAt=0;
async function finishCatalogOnly(){
  if(completed||finalizing||submitting||Date.now()<retryAt)return;finalizing=true;
  try{
    const backupKey='paper_catalog_submission_'+runId;
    frozenExport ||= (await chrome.storage.local.get(backupKey))[backupKey];
    if(!frozenExport){const review=await autoReview.export();frozenExport={kind:'paper_project',workflow_run_id:runId,records:[],catalog:structuredClone(controller.s),catalog_review_results:review.ai_review_results,ai_review_results:{}};}
    await chrome.storage.local.set({[backupKey]:frozenExport});
    render(controller.s);
    await workflowRequest('/submit',{id:runId,data:frozenExport});completed=true;autoReview.close();
    $('handoff-status').textContent='目录已安全提交，已取得内容继续入库和发布。可以启动 Python 采集剩余论文。';
    render(controller.s);await refreshHandoff();
  }catch{retryAt=Date.now()+30000;$('handoff-status').textContent='目录结果已在本机保存，30 秒后重试提交，无需重新采集。';}
  finally{finalizing=false;}
}
async function refreshHandoff(){
  if(!catalogOnly||!completed)return;
  try{const s=await workflowRequest('/status'),p=s.python;
    $('python-remaining').disabled=Boolean(s.busy||!p?.available||p.running||p.id&&!['idle','captured'].includes(p.phase));
    if(s.busy)$('handoff-status').textContent='目录已提交，后台正在保存和交接。完成后可启动 Python。';
    else if(p?.running||p?.id&&!['idle','captured'].includes(p.phase))$('handoff-status').textContent='目录已提交。已有 Python 任务，请回首页查看或继续该任务。';
    else $('handoff-status').textContent='目录已提交。现在可以启动 Python 采集剩余论文；目录与论文的发布分别继续。';
  }catch{$('python-remaining').disabled=true;$('handoff-status').textContent='目录已保留；请回首页连接本机服务后继续。';}
}
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
  if(catalogOnly){await finishCatalogOnly();return;}
  if(transitioning)return;transitioning=true;autoReview.close();
  location.href=`dashboard.html?queue=catalog&autostart=1&run=${runId}`;
}
function render(s){
  $('status').textContent=s.reason;$('current').textContent=controller.task()?`当前：${controller.task().journal} · ${controller.task().label}`:'目录读取结束，正在核对。';
  const all=papers||mergeCatalog(s.pages);
  $('counts').textContent=`目录进度 ${s.cursor} / ${s.queue.length} 页 · 条目 ${all.length} · 官网直读 ${s.pages.filter(p=>p.direct_read).length} 页`;
  for(const id of ['start','skip','retry','recheck'])$(id).disabled=!writable||s.mode==='running'||catalogOnly&&(!!frozenExport||finalizing);
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
  if(!completed&&!frozenExport)await checkpointCatalog(stored,plan);
  if(armed&&controller.s.mode==='done'&&!autoReview.isRunning()&&['done','done_with_errors'].includes(autoReview.getState().phase))await enterDetails();
}
async function boot(){
  if(!runId){location.replace('workflow.html');return;}
  const run=await storedRun(runId),key=catalogKey(runId),session=key+'_owned_tab';tasks=ACTIVE_CATALOG_TASKS.filter(t=>run.jobs.some(j=>j.catalog_id===t.id));
  catalogOnly=run.scope==='catalog';$('catalog-handoff').hidden=!catalogOnly;
  if(catalogOnly)frozenExport=(await chrome.storage.local.get('paper_catalog_submission_'+runId))['paper_catalog_submission_'+runId]||null;
  if(catalogOnly)$('scope-note').textContent='仅补充目录：最新一期和在线发表分别读取，自动经过 DeepSeek 核对并提交。完成后由你启动 Python 采集剩余论文。';
  $('python-remaining').onclick=async()=>{$('python-remaining').disabled=true;try{await workflowRequest('/python/start',{scope:'articles',catalog_run_id:runId});location.href='workflow.html';}catch(e){$('handoff-status').textContent='Python 尚未启动，目录结果保留。'+e.message;}};
  document.querySelector('.tag').textContent='PAPER DAILY · '+chrome.runtime.getManifest().version;
  controller=new CatalogEngine({autoResumeVerification:true,now:()=>Date.now(),render,load:async()=>(await chrome.storage.local.get(key))[key],save:v=>chrome.storage.local.set({[key]:v}),
    loadSession:async()=>(await chrome.storage.session.get(session))[session],saveSession:v=>chrome.storage.session.set({[session]:v}),
    createTab:url=>chrome.tabs.create({url,active:true}),getTab:id=>chrome.tabs.get(id),navigate:(id,url)=>chrome.tabs.update(id,{url}),
    inspect:async tabId=>{const r=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},func:readCatalogDocument});if(!r[0]?.result)throw Error('No capture');return r[0].result;}});
  for(const id of ['start','pause','skip','retry','recheck'])$(id).onclick=async()=>{
    if(!writable||catalogOnly&&frozenExport)return;try{armed=id!=='pause';if(armed)autoReview.reset();else autoReview.stop();papers=null;await controller[id]();
      if(['retry','recheck'].includes(id))await controller.start();
    }catch{$('status').textContent='操作未完成；已有结果保留。';}
  };
  $('collection-filter').onchange=()=>render(controller.s);
  $('export').onclick=async()=>{const data={kind:'paper_catalog_backup',workflow_run_id:runId,catalog:controller.s,...await autoReview.export()},u=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download=`paper-catalog-${runId}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(u),30000);};
  await navigator.locks.request('paper-abstract-controller',{ifAvailable:true},async lock=>{
    if(!lock){$('status').textContent='另一任务面板正在采集，请回到原面板。';return;}
    writable=true;await controller.init();autoReview=mountAutoReview(()=>makeReviewJobs(controller.s,null),'catalog-'+runId,refreshReviewed);
    if(catalogOnly&&frozenExport){autoReview.close();await finishCatalogOnly();}
    await refreshReviewed();
    if(new URL(location.href).searchParams.get('autostart')==='1'){history.replaceState(null,'',`catalog.html?run=${runId}`);await controller.start();}
    const listener=(m,sender,reply)=>{
      if(m?.type!=='catalog-adopt-manual'||sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('action-popup.html')||!writable||catalogOnly&&frozenExport)return;
      if(!tasks.some(t=>t.id===m.taskId)){reply({message:'该目录不属于当前批次。'});return;}
      armed=true;autoReview.reset();controller.adoptManual(m.tabId,m.taskId).then(()=>reply({message:controller.s.reason})).catch(e=>reply({message:e.message}));return true;
    };
    chrome.runtime.onMessage.addListener(listener);
    const changed=(c,area)=>{if(area==='local'&&c[REVIEW_KEY])void refreshReviewed();};chrome.storage.onChanged.addListener(changed);
    const removed=id=>void controller.tabClosed(id).catch(()=>{});chrome.tabs.onRemoved.addListener(removed);
    let handoffPoll=0;
    const timer=setInterval(()=>void controller.tick().then(async()=>{if(controller.s.mode==='running')papers=null;if(!completed)autoReview.tick(controller.s.mode);
      if(catalogOnly&&frozenExport&&!completed)await finishCatalogOnly();
      if(Date.now()>handoffPoll){handoffPoll=Date.now()+15000;await refreshHandoff();}
    }).catch(()=>{$('status').textContent='读取或保存未成功，已有结果保留。';}),2000);
    await new Promise(resolve=>window.addEventListener('pagehide',()=>{clearInterval(timer);autoReview.close();chrome.runtime.onMessage.removeListener(listener);chrome.storage.onChanged.removeListener(changed);chrome.tabs.onRemoved.removeListener(removed);writable=false;resolve();},{once:true}));
  });
}
boot().catch(()=>{$('status').textContent='无法恢复任务；原始结果未改动，请返回首页重试。';});
