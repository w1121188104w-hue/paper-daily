import { assessCapture } from './core.js';
import { readArticleDocument } from './extractor.js';
import { QueueEngine } from './engine.js';
import { makeReviewJobs,reviewedCatalogPapers,reviewedArticleRecords } from './review-core.js';
import { mountAutoReview,prepareReviewPlan,REVIEW_KEY,reviewFingerprint } from './review-client.js';
import {buildDetailQueue,mergeDetailPapers,reconcileDetailQueue,applyDetailTypes} from './detail-queue.js';
import {abstractRetryComplete} from './abstract-availability.js';
import {excludedJpePaper} from './collection-policy.js';
import {recoverStoredOcr} from './ocr-core.js';
import {closeOwnedJpePanel,collectJpeAffiliations,mergeJpeAffiliations} from './jpe-panel.js';
import {workflowId,storedRun,catalogKey,detailKey,incrementalPapers,workflowRequest} from './workflow-client.js';

const $ = id => document.getElementById(id);
const labels = { candidate_extracted: '已提取候选原文', no_abstract_stated: '页面明确没有摘要', skipped: '已跳过',
  not_found: '本轮未找到', identity_unconfirmed: '未核对到论文身份', partial_only: '只读到不完整摘要',
  page_unavailable: '页面无法读取', needs_user_verification: '等待验证' };
let controller, autoReview, writable = false, reviewed=[];
const runId=workflowId(),stateKey=detailKey(runId);let workflowRun,exportPayload,submitted=false,submitting=false,submitAfter=0,frozenExport=null;
let checkpointing=false,lastCheckpoint='',checkpointAfter=0;
async function checkpointAvailable(){
  if(!runId||!exportPayload||checkpointing||Date.now()<checkpointAfter)return;
  checkpointing=true;
  try{
    const data=await exportPayload();
    const accepted=new Set(Object.values(data.ai_review_results||{}).filter(r=>r.verdict?.status==='source_checked_candidate').map(r=>r.input.identity.doi));
    data.records=data.records.filter(r=>accepted.has(r.doi));
    if(!data.records.length)return;
    const signature=await reviewFingerprint({records:data.records,ai_review_results:data.ai_review_results,catalog_review_results:data.catalog_review_results});
    const key='paper_incremental_checkpoint_'+runId;
    lastCheckpoint ||= (await chrome.storage.local.get(key))[key]||'';
    if(signature===lastCheckpoint)return;
    await workflowRequest('/checkpoint',{id:runId,data});lastCheckpoint=signature;
    await chrome.storage.local.set({[key]:signature});
    $('workflow-message').textContent='已取得且审核通过的内容已独立提交；剩余采集继续进行。';
  }catch{checkpointAfter=Date.now()+30000;}
  finally{checkpointing=false;}
}
async function refreshReviewed(){
  const results=(await chrome.storage.local.get(REVIEW_KEY))[REVIEW_KEY]||{};
  const plan=await prepareReviewPlan(makeReviewJobs(null,controller.s,{includeRetired:true}),results);
  reviewed=await reviewedArticleRecords(controller.s,plan,results);render(controller.s);
}
async function submitWorkflow(){
  if(!runId||!exportPayload||submitting||Date.now()<submitAfter)return;submitting=true;
  try{
    const backupKey='paper_workflow_submission_'+runId;
    frozenExport ||= (await chrome.storage.local.get(backupKey))[backupKey] || await exportPayload();
    await chrome.storage.local.set({[backupKey]:frozenExport});
    await workflowRequest('/submit',{id:runId,data:frozenExport});submitted=true;
    $('workflow-message').textContent='已安全提交，正在自动上传 GitHub 翻译发布。';
    autoReview.close();location.href='workflow.html';
  }catch{submitted=false;submitAfter=Date.now()+30000;$('workflow-message').textContent='提交暂未成功，原始结果已保存。30 秒后自动重试同一份结果，无需重新采集。';}
  finally{submitting=false;}
}
function render(s) {
  $('status').textContent = s.mode==='done'?'采集已完成；核对进度见下方。':s.reason;
  const current = controller?.current();
  $('current').textContent = current ? `当前：${current.journal} · ${current.title}` : '当前队列已结束。';
  $('counts').textContent = `已记录 ${s.records.length} / ${s.sample_dois.length} 条 · 候选摘要 ${s.records.filter(r => r.status === 'candidate_extracted').length} 条 · 已确认无摘要 ${reviewed.filter(r=>r.abstract_status==='confirmed_absent').length} 条（不重试）`;
  $('queue-title').textContent=`${controller.papers.length} 篇增量详情队列`;
  $('manual-link').hidden=!current;if(current)$('manual-link').href=current.url;
  $('start').disabled = !writable || s.mode === 'running' || !current;
  $('pause').disabled = !writable || s.mode !== 'running';
  $('skip').disabled = !writable || !current;
  $('retry').disabled = !writable || s.mode === 'running';
  $('recheck').disabled = !writable || s.mode === 'running';
  $('export').disabled = false;
  document.title = `${s.mode === 'running' ? '运行中' : s.mode === 'done' ? '已完成' : '已暂停'} · 论文摘要助手`;
  const cards = controller.papers.map(paper => {
    const record = s.records.find(r => r.doi === paper.doi), card = document.createElement('article');
    const title = document.createElement('h3'); title.textContent = `${paper.journal} · ${paper.title}`;
    const link = document.createElement('a'); link.href = paper.url; link.textContent = paper.doi; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const status = document.createElement('p'); status.className = 'result'; status.textContent = record ? labels[record.status] || record.status : '等待处理';
    card.append(title, link, status);
    if(controller.excluded(paper)){const note=document.createElement('p');note.textContent='已按要求放弃：JPE Just Accepted / 图片摘要。不再采集、识别或重试；历史记录保留。';card.append(note);}
    if(record?.ocr&&!controller.excluded(paper)){const note=document.createElement('p'),checked=reviewed.find(r=>r.doi===paper.doi),recovered=recoverStoredOcr(record);
      note.textContent=checked?.abstract?'图片摘要已保存；OCR 原文和来源可追溯，但不保证逐字符识别无误。':recovered.ocr.extraction?.abstract?'已从保存的 OCR 原文找到摘要候选，待 DeepSeek 核对；无需重新打开网页。':`图片摘要未补全：${record.ocr.extraction?.status||record.ocr.status||'未识别'}。不会生成摘要。`;card.append(note);}
    if (record?.abstract) {
      const details = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('pre');
      summary.textContent = `查看候选英文摘要（${record.abstract.length} 字符）`; text.textContent = record.abstract;
      details.append(summary, text); card.append(details);
    }
    const checked=reviewed.find(r=>r.doi===paper.doi);
    if(checked?.abstract_status==='confirmed_absent'){const note=document.createElement('p');note.textContent='已确认：出版社没有独立摘要。保留空值，不生成摘要，不自动重试。';card.append(note);}
    if(checked?.type==='other'){const note=document.createElement('p');note.textContent='其他：已根据原文确认非研究文章；保留记录，不参加缺摘要重试。';card.append(note);}
    if(checked?.affiliations?.length){
      const details=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('ul');
      summary.textContent=`作者单位（已核对 ${checked.affiliations.length} 项）`;
      for(const a of checked.affiliations){const li=document.createElement('li');li.textContent=`${a.author||'对应作者未明确'}：${a.affiliation}`;list.append(li);}
      details.append(summary,list);card.append(details);
    }else if(record){const note=document.createElement('p');note.textContent=record.affiliation_candidates?.length?'已采到单位候选，待原文核对':'本页暂未读到作者单位';card.append(note);}
    return card;
  });
  $('papers').replaceChildren(...cards);
}
function expandExplicitAbstract() {
  for (const button of document.querySelectorAll('button,[role="button"]')) {
    if (/^(?:show (?:full )?abstract|view abstract|expand abstract|展开摘要|显示摘要)$/i.test((button.textContent || button.getAttribute('aria-label') || '').trim())
        && button.getBoundingClientRect().height > 0) { button.click(); return true; }
  }
  return false;
}
function expandExplicitAffiliations(){
  for(const el of document.querySelectorAll('button,[role="button"],a[href^="#"]')){
    if(/^(?:author (?:information|affiliations|info(?:rmation)? and affiliations)|authors and affiliations|show (?:all )?affiliations|show more|作者信息|作者单位)$/i.test((el.textContent||el.getAttribute('aria-label')||'').trim()) &&
      el.getBoundingClientRect().height>0 && el.getAttribute('aria-expanded')!=='true' && !el.dataset.paperAffiliationExpanded){
      if(/^show more$/i.test(el.textContent.trim())&&!el.closest('.author-group,.AuthorGroups,.authors,.author-info'))continue;
      el.dataset.paperAffiliationExpanded='1';el.click();return true;
    }
  }return false;
}
async function inspect(tabId, paper) {
  const execute=(func,args=[])=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},func,args});
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  if(paper.journal==='JPE'){
    const panel=await closeOwnedJpePanel(execute,paper,wait);
    if(['close_failed','close_unavailable'].includes(panel?.status))return {status:'page_unavailable',abstract:null,panel_cleanup_failed:true};
  }
  const values = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: readArticleDocument });
  if (!values[0]?.result) return { status: 'page_unavailable', abstract: null };
  let capture=values[0].result,result=assessCapture(paper,capture);
  if(paper.journal==='JPE'&&!result.abstract&&capture.evidence?.some(b=>/\bJust Accepted\b/i.test(b.text||'')))result.collection_status='excluded_by_user';
  if (result.identity?.ok) {
    if(paper.journal==='JPE'&&result.abstract&&!capture.affiliation_candidates?.length){
      const authors=await collectJpeAffiliations(execute,paper,async()=>{
        const extra=(await execute(readArticleDocument))?.[0]?.result;
        return extra&&assessCapture(paper,extra).identity?.ok?extra:null;
      },wait);
      capture=mergeJpeAffiliations(capture,authors.capture);
      result.author_panel={status:authors.status,cleanup:authors.cleanup};
      if(['close_failed','close_unavailable','owned_panel_open'].includes(authors.cleanup))result.panel_cleanup_failed=true;
    }
    result.evidence = capture.evidence; result.evidence_version = capture.evidence_version;
    result.affiliation_candidates=capture.affiliation_candidates||[];result.affiliation_extraction_version=capture.affiliation_extraction_version;
    if(paper.journal!=='JPE'&&!result.affiliation_candidates.length){const expanded=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},func:expandExplicitAffiliations});result.pending_affiliations=expanded[0]?.result===true;}
  }
  if (result.status === 'not_found' && result.identity?.ok) {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: expandExplicitAbstract });
  }
  if (result.abstract) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.abstract));
    result.abstract_sha256 = [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  if(paper.journal==='JPE'&&(await chrome.tabs.get(tabId)).url!==capture.url)return {status:'page_unavailable',abstract:null};
  return result;
}
async function boot(){
  if(!runId){location.replace('workflow.html');return;}
  workflowRun=await storedRun(runId);
  document.querySelector('.tag').textContent='PAPER DAILY · '+chrome.runtime.getManifest().version;
  const catalog=(await chrome.storage.local.get(catalogKey(runId)))[catalogKey(runId)];
  if(!catalog)throw Error('目录任务尚未准备，请返回采集首页。');
  const reviews=(await chrome.storage.local.get(REVIEW_KEY))[REVIEW_KEY]||{},plan=await prepareReviewPlan(makeReviewJobs(catalog,null,{includeRetired:true}),reviews);
  const catalogReviews=Object.fromEntries(plan.jobs.filter(j=>reviews[j.hash]).map(j=>[j.hash,reviews[j.hash]]));
  let catalogPapers=reviewedCatalogPapers(catalog,plan,reviews);
  let saved=(await chrome.storage.local.get(stateKey))[stateKey];
  if(!saved){
    const python=(await chrome.storage.local.get('paper_python_records_'+runId))['paper_python_records_'+runId];
    if(python?.length){
      const available=buildDetailQueue(incrementalPapers(catalogPapers,workflowRun)).papers;
      const prior=python.filter(r=>available.some(p=>p.doi===r.doi));
      const detailPlan=await prepareReviewPlan(makeReviewJobs(null,{records:prior}),reviews),checked=await reviewedArticleRecords({records:prior},detailPlan,reviews);
      const done=new Set(checked.filter(r=>r.abstract&&r.affiliations?.length&&r.authors_raw&&r.publication_month).map(r=>r.doi));
      saved={schema_version:1,sample_dois:available.map(p=>p.doi),detail_papers:available,queue:available.filter(p=>!done.has(p.doi)).map(p=>p.doi),cursor:0,
        mode:'paused',reason:'继续 Python 剩余文章；已有原文和审核结果保留。',records:prior,history:[],attempts:0};
    }
  }
  catalogPapers=applyDetailTypes(catalogPapers,saved?.records||[]);
  const queue=buildDetailQueue(incrementalPapers(catalogPapers,workflowRun)),reconciled=reconcileDetailQueue(saved,queue.papers),papers=reconciled.papers;
  const sessionKey=stateKey+'_owned_tab';
  controller=new QueueEngine(papers,{
    autoResumeVerification:true,peek:async(tabId,paper)=>{const r=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},func:readArticleDocument});return r[0]?.result?assessCapture(paper,r[0].result):{};},
    excludedDois:catalogPapers.filter(excludedJpePaper).map(p=>p.doi),now:()=>Date.now(),render,
    load:async()=>reconciled.saved,save:value=>chrome.storage.local.set({[stateKey]:{...value,detail_papers:papers}}),
    loadSession:async()=>(await chrome.storage.session.get(sessionKey))[sessionKey],saveSession:value=>chrome.storage.session.set({[sessionKey]:value}),
    createTab:url=>chrome.tabs.create({url,active:true}),getTab:id=>chrome.tabs.get(id),navigate:(id,url)=>chrome.tabs.update(id,{url}),inspect
  });
  for(const name of ['start','pause','skip','retry','recheck'])$(name).onclick=async()=>{
    if(!writable)return;
    try{
      if(name==='pause'){autoReview.stop();await controller.pause();return;}
      if(name==='retry'){await refreshReviewed();autoReview.reset();await controller.retry({excludedDois:reviewed.filter(p=>p.type==='other').map(p=>p.doi),checkedDois:reviewed.filter(abstractRetryComplete).map(p=>p.doi)});await controller.start();return;}
      autoReview.reset();await controller[name]();if(name==='recheck')await controller.start();
    }catch(e){$('status').textContent='操作未完成：'+e.message;}
  };
  exportPayload=async()=>{
    await refreshReviewed();
    return {...controller.s,workflow_run_id:runId,kind:'paper_project',...await autoReview.export(),
      catalog,catalog_review_results:catalogReviews,reviewed_records:reviewed,papers:mergeDetailPapers(catalogPapers,reviewed),detail_queue_excluded:queue.excluded,exported_at:new Date().toISOString()};
  };
  $('export').onclick=async()=>{const u=URL.createObjectURL(new Blob([JSON.stringify(await exportPayload(),null,2)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download='paper-collection-'+runId+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),30000);};
  await navigator.locks.request('paper-abstract-controller',{ifAvailable:true},async lock=>{
    if(!lock){$('status').textContent='另一任务面板正在运行，请回到原面板。';return;}
    writable=true;await controller.init();
    autoReview=mountAutoReview(()=>makeReviewJobs(null,controller.s),'details-'+runId,refreshReviewed);await refreshReviewed();
    if(new URL(location.href).searchParams.get('autostart')==='1'){history.replaceState(null,'','dashboard.html?queue=catalog&run='+runId);await controller.start();}
    const listener=(m,sender,reply)=>{
      if(m?.type!=='article-adopt-manual'||sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('action-popup.html')||!writable)return;
      autoReview.reset();controller.adoptManual(m.tabId).then(()=>reply({message:controller.s.reason})).catch(e=>reply({message:e.message}));return true;
    };
    chrome.runtime.onMessage.addListener(listener);
    const removed=id=>void controller.tabClosed(id);chrome.tabs.onRemoved.addListener(removed);
    const timer=setInterval(()=>void controller.tick().then(()=>{
      autoReview.tick(controller.s.mode);
      if(!submitted&&!submitting)void checkpointAvailable();
      if(!submitted&&!submitting&&controller.s.mode==='done'&&['done','done_with_errors'].includes(autoReview.getState().phase))void submitWorkflow();
    }).catch(()=>{}),2000);
    await new Promise(resolve=>window.addEventListener('pagehide',()=>{clearInterval(timer);autoReview.close();chrome.runtime.onMessage.removeListener(listener);chrome.tabs.onRemoved.removeListener(removed);writable=false;resolve();},{once:true}));
  });
}
boot().catch(e=>{$('status').textContent='无法恢复任务：'+e.message;});
