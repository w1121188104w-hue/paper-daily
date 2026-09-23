import { validateSamples, assessCapture } from './core.js';
import { readArticleDocument } from './extractor.js';
import { QueueEngine, STATE_KEY } from './engine.js';
import { makeReviewJobs,reviewedCatalogPapers,reviewedArticleRecords } from './review-core.js';
import { mountAutoReview,prepareReviewPlan,REVIEW_KEY } from './review-client.js';
import {CATALOG_STATE,CATALOG_TASKS} from './catalog-core.js';
import {DETAIL_STATE_KEY,SAMPLE_DETAIL_STATE_KEY,SUPPLEMENT_DETAIL_STATE_KEY,buildCatalogSample,buildSupplementSample,buildDetailQueue,mergeDetailPapers,reconcileDetailQueue,applyDetailTypes,validateFrozenDetailPapers} from './detail-queue.js';
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
const runId=workflowId();let workflowRun,exportPayload,submitted=false,submitting=false;
const supplementMode=new URL(location.href).searchParams.get('queue')==='catalog-supplement';
const sampleMode=supplementMode||new URL(location.href).searchParams.get('queue')==='catalog-sample';
const detailMode=sampleMode||new URL(location.href).searchParams.get('queue')==='catalog';
const stateKey=runId?detailKey(runId):supplementMode?SUPPLEMENT_DETAIL_STATE_KEY:sampleMode?SAMPLE_DETAIL_STATE_KEY:detailMode?DETAIL_STATE_KEY:STATE_KEY;
async function refreshReviewed(){
  const results=(await chrome.storage.local.get(REVIEW_KEY))[REVIEW_KEY]||{};
  const plan=await prepareReviewPlan(makeReviewJobs(null,controller.s,{includeRetired:true}),results);
  reviewed=await reviewedArticleRecords(controller.s,plan,results);render(controller.s);
}
async function submitWorkflow(){
  if(!runId||!exportPayload||submitting)return;submitting=true;
  try {await workflowRequest('/submit',{id:runId,data:await exportPayload()});submitted=true;
    $('workflow-message').textContent='本批次已提交本地正式流程服务。请回到正式流程入口，点击“导入、翻译并发布”。未合格项保留待处理。';}
  catch{$('workflow-message').textContent='提交未成功，浏览器原始结果保留。确认 start-workflow.cmd 已启动后，点击“提交本批次”。';}
  finally{submitting=false;}
}
function render(s) {
  $('status').textContent = s.mode==='done'?'采集已完成；核对进度见下方。':s.reason;
  const current = controller?.current();
  $('current').textContent = current ? `当前：${current.journal} · ${current.title}` : '当前队列已结束。';
  $('counts').textContent = `已记录 ${s.records.length} / ${s.sample_dois.length} 条 · 候选摘要 ${s.records.filter(r => r.status === 'candidate_extracted').length} 条 · 已确认无摘要 ${reviewed.filter(r=>r.abstract_status==='confirmed_absent').length} 条（不重试）`;
  $('queue-title').textContent=`${controller.papers.length} 篇${supplementMode?'专项补测':sampleMode?'全刊分组抽样':detailMode?'目录详情':'测试'}队列`;
  $('supplement-link').hidden=!sampleMode||supplementMode;
  $('manual-link').hidden=!current;if(current)$('manual-link').href=current.url;
  $('start').disabled = !writable || s.mode === 'running' || !current;
  $('pause').disabled = !writable || s.mode !== 'running';
  $('skip').disabled = !writable || !current;
  $('retry').disabled = !writable || s.mode === 'running';
  $('recheck').disabled = !writable || s.mode === 'running';
  $('jpe-ocr').disabled = true;$('jpe-ocr').hidden=true;
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
async function boot() {
  document.querySelector('.tag').textContent='PAPER DAILY · 详情采集 '+chrome.runtime.getManifest().version;
  if(runId){workflowRun=await storedRun(runId);const block=document.createElement('section'),a=document.createElement('a'),b=document.createElement('button'),p=document.createElement('p');
    a.href='workflow.html';a.textContent='正式流程入口 / 导入翻译发布';b.textContent='提交本批次';b.onclick=submitWorkflow;p.id='workflow-message';
    block.append(a,b,p);document.querySelector('main').prepend(block);
    const back=document.querySelector('header a');if(back)back.href='catalog.html?run='+runId;
    document.querySelector('header p').textContent='正式增量详情 → 原文核对 → 提交本地服务 → 导入、翻译并发布。';}
  let input,papers,catalogPapers=[],excluded=[],catalogSnapshot=null,catalogReviews={},initialDetailState,sampling=null;
  if(detailMode){
    const catalogState=runId?catalogKey(runId):CATALOG_STATE;
    const catalog=(await chrome.storage.local.get(catalogState))[catalogState];
    catalogSnapshot=catalog;
    const reviews=(await chrome.storage.local.get(REVIEW_KEY))[REVIEW_KEY]||{};
    const plan=await prepareReviewPlan(makeReviewJobs(catalog,null,{includeRetired:true}));
    catalogReviews=Object.fromEntries(plan.jobs.filter(j=>reviews[j.hash]).map(j=>[j.hash,reviews[j.hash]]));
    catalogPapers=reviewedCatalogPapers(catalog||{pages:[]},plan,reviews);
    const priorDetails=await chrome.storage.local.get(runId?[stateKey]:[DETAIL_STATE_KEY,SAMPLE_DETAIL_STATE_KEY,SUPPLEMENT_DETAIL_STATE_KEY]);
    catalogPapers=applyDetailTypes(catalogPapers,Object.values(priorDetails).flatMap(s=>s?.records||[]));
    const saved=(await chrome.storage.local.get(stateKey))[stateKey];
    if(sampleMode){
      const queue=supplementMode?buildSupplementSample(catalogPapers,priorDetails[SAMPLE_DETAIL_STATE_KEY],catalog?.run_started_at):buildCatalogSample(catalogPapers,CATALOG_TASKS,catalog?.run_started_at);
      sampling=saved?.sampling||{policy:queue.policy,coverage:queue.coverage};
      papers=saved?.detail_papers||queue.papers;excluded=queue.excluded;initialDetailState=saved;
      validateFrozenDetailPapers(papers,CATALOG_TASKS.length*3);
      $('sampling-info').textContent=supplementMode?'专项补测：补足研究论文样本。JPE Just Accepted / 图片摘要已停用；旧样本保留但不重试。':'独立抽样：每刊最新一期3篇、在线发表3篇；不足按实际数量。JPE Just Accepted / 图片摘要已停用，旧记录保留。';
      $('sampling-coverage').textContent=sampling.coverage.map(c=>supplementMode?`${c.journal} ${c.collection==='just_accepted'?'Just Accepted':c.collection==='issue'?'最新一期':'在线'}：${c.selected.length}/${c.needed}（缺额${c.shortfall}）`:`${c.journal} ${c.collection==='issue'?'最新一期':'在线'}：${c.selected.length}/3（可选${c.available}）`).join('；');
    }else{
      const queue=buildDetailQueue(runId?incrementalPapers(catalogPapers,workflowRun):catalogPapers);papers=queue.papers;excluded=queue.excluded;
      const reconciled=reconcileDetailQueue(saved,papers);papers=reconciled.papers;initialDetailState=reconciled.saved;
    }
    if(!papers.length&&!runId)throw Error('请先采集目录；没有可处理的含 DOI 条目。缺 DOI 和其他条目仍保留在目录。');
    input={source:'local_catalog'};
  }else{
    const response = await fetch(chrome.runtime.getURL('samples.json'));
    if (!response.ok) throw Error('无法加载扩展内的样本。');
    input=await response.json();papers=validateSamples(input);
  }
  const sessionKey = stateKey + '_owned_tab';
  const env = {
    excludedDois:catalogPapers.filter(excludedJpePaper).map(p=>p.doi),
    now: () => Date.now(), render,
    load: async () => detailMode?initialDetailState:(await chrome.storage.local.get(stateKey))[stateKey],
    save: value => chrome.storage.local.set({ [stateKey]: {...value,...(detailMode?{detail_papers:papers}: {}),...(sampleMode?{sampling}: {})} }),
    loadSession: async () => (await chrome.storage.session.get(sessionKey))[sessionKey],
    saveSession: value => chrome.storage.session.set({ [sessionKey]: value }),
    createTab: url => chrome.tabs.create({ url, active: true }),
    getTab: id => chrome.tabs.get(id), navigate: (id, url) => chrome.tabs.update(id, { url }), inspect
  };
  controller = new QueueEngine(papers, env);
  const action = fn => async () => {
    try { await fn(); } catch (e) { $('status').textContent = '操作未完成：' + e.message; }
  };
  for (const name of ['start', 'pause', 'skip', 'retry', 'recheck']) $(name).addEventListener('click', action(async () => {
    if (!writable) return;
    if(name==='retry'){
      if(autoReview?.isRunning()){autoReview.stop();$('status').textContent='请等当前核对保存后，再点重试未成功项。';return;}
      await refreshReviewed();autoReview?.reset();
      const typed=applyDetailTypes(catalogPapers,reviewed);
      await controller.retry({excludedDois:[...typed,...reviewed].filter(p=>p.type==='other').map(p=>p.doi),checkedDois:reviewed.filter(abstractRetryComplete).map(r=>r.doi)});
      return;
    }
    if (name === 'pause') autoReview?.stop(); else autoReview?.reset();
    await controller[name]();
  }));
  $('supplement-link').addEventListener('click',event=>{
    if(!writable||controller.s.mode==='running'||controller.busy||autoReview?.isRunning()){
      event.preventDefault();$('status').textContent='请先暂停采集并等当前核对保存后，再进入专项补测。';
    }
  });
  exportPayload=async()=>{
    await refreshReviewed();
    return { ...controller.s,...(runId?{workflow_run_id:runId}:{}), sample_source: input.source, production_writes: 0, ...await autoReview?.export(),
      reviewed_records:reviewed,...(sampleMode?{sampling}:{}),...(detailMode?{kind:supplementMode?'paper_catalog_supplement_trial':sampleMode?'paper_catalog_sample_trial':'paper_project_trial',catalog:catalogSnapshot,catalog_review_results:catalogReviews,
        papers:mergeDetailPapers(catalogPapers,reviewed),detail_queue_excluded:excluded}:{}),exported_at: new Date().toISOString() };
  };
  $('export').addEventListener('click', async () => {
    const data=await exportPayload();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'paper-abstract-trial-' + new Date().toISOString().slice(0, 10) + '.json';
    if(detailMode)link.download='paper-detail-trial-'+new Date().toISOString().slice(0,10)+'.json';link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  await navigator.locks.request('paper-abstract-controller', { ifAvailable: true }, async lock => {
    if (!lock) { $('status').textContent = '另一个助手面板正在使用。请回到原面板，或关闭它后刷新这里。'; return; }
    writable = true;
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await controller.init();
    autoReview = mountAutoReview(() => makeReviewJobs(null, controller.s), runId?'details-'+runId:supplementMode?'catalog-supplement-details':sampleMode?'catalog-sample-details':detailMode?'catalog-details':'article',refreshReviewed);
    await refreshReviewed();
    if(detailMode && !sampleMode && new URL(location.href).searchParams.get('autostart')==='1'){
      history.replaceState(null,'','dashboard.html?queue=catalog'+(runId?'&run='+runId:''));await controller.start();
    }
    const listener=(message,sender,sendResponse)=>{
      if(message?.type!=='article-adopt-manual'||sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('action-popup.html')||!writable)return;
      autoReview.reset();controller.adoptManual(message.tabId).then(()=>sendResponse({message:controller.s.reason})).catch(e=>sendResponse({message:e.message}));return true;
    };
    chrome.runtime.onMessage?.addListener(listener);
    chrome.tabs.onRemoved.addListener(id => { void controller.tabClosed(id); });
    const timer = setInterval(() => { void controller.tick().then(() => {autoReview.tick(controller.s.mode);
      if(runId&&!submitted&&!submitting&&controller.s.mode==='done'&&['done','done_with_errors'].includes(autoReview.getState().phase)){
        submitted=true;void submitWorkflow();} }).catch(()=>{}); }, 2000);
    // Keep the origin lock while this dashboard exists, not while a service worker happens to be awake.
    await new Promise(resolve => window.addEventListener('pagehide', () => { clearInterval(timer); autoReview.close(); chrome.runtime.onMessage?.removeListener(listener); writable = false; resolve(); }, { once: true }));
  });
}
boot().catch(e => { $('status').textContent = '无法启动：' + e.message; });
