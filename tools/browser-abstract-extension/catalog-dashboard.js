import { ACTIVE_CATALOG_TASKS, CATALOG_STATE as LEGACY_CATALOG_STATE, mergeCatalog } from './catalog-core.js';
import {workflowId,storedRun,catalogKey,detailKey} from './workflow-client.js';
import { CatalogEngine } from './catalog-engine.js';
import { readCatalogDocument } from './catalog-extractor.js';
import { makeReviewJobs, reviewedCatalogPapers,reviewedArticleRecords } from './review-core.js';
import {DETAIL_STATE_KEY,SAMPLE_DETAIL_STATE_KEY,SUPPLEMENT_DETAIL_STATE_KEY,mergeDetailPapers,applyDetailTypes} from './detail-queue.js';
import {catalogMembership,catalogDateLabel} from './catalog-scope.js';
import { mountAutoReview, prepareReviewPlan, REVIEW_KEY } from './review-client.js';
const $ = id => document.getElementById(id);
const runId=workflowId(),CATALOG_STATE=runId?catalogKey(runId):LEGACY_CATALOG_STATE;
let CATALOG_TASKS=ACTIVE_CATALOG_TASKS;
let controller, autoReview, writable = false;
let displayedPapers = null;
let pipelineArmed=false,transitioning=false;
const PIPELINE_KEY=runId?`paper_pipeline_${runId}`:'paper_pipeline_armed_v1';
const catalogOnly = new URL(location.href).searchParams.get('mode') === 'catalog-only';
async function enterDetails(){
  if(catalogOnly)return;
  if(transitioning)return;transitioning=true;
  await chrome.storage.local.set({[PIPELINE_KEY]:false});autoReview.close();
  location.href=chrome.runtime.getURL('dashboard.html?queue=catalog&autostart=1'+(runId?'&run='+runId:''));
}
async function refreshReviewed() {
  const plan = await prepareReviewPlan(makeReviewJobs(controller.s, null,{includeRetired:true}));
  const stored = (await chrome.storage.local.get(REVIEW_KEY))[REVIEW_KEY] || {};
  const detailStates=await chrome.storage.local.get(runId?[detailKey(runId)]:[DETAIL_STATE_KEY,SAMPLE_DETAIL_STATE_KEY,SUPPLEMENT_DETAIL_STATE_KEY]);
  displayedPapers = applyDetailTypes(reviewedCatalogPapers(controller.s, plan, stored),Object.values(detailStates).flatMap(s=>s?.records||[])); render(controller.s);
  if(pipelineArmed && controller.s.mode==='done' && !autoReview?.isRunning() && ['done','done_with_errors'].includes(autoReview?.getState().phase)) await enterDetails();
}
const labels = { catalog_candidates: '已读到候选条目（完整性未确认）', no_entries_found: '未读到条目，需检查页面结构',
  catalog_empty: '页面明确提示暂无文章', catalog_landing: '已找到最新卷期入口',
  catalog_not_found: '目录地址不存在，需要更新入口', needs_user_verification: '页面要求验证，请手动完成后继续',
  identity_unconfirmed: '未确认期刊身份', skipped: '已跳过' };
function render(s) {
  $('status').textContent = s.reason;
  $('current').textContent = controller.task() ? `当前：${controller.task().journal} · ${controller.task().label}` : '本轮队列结束。';
  const papers = displayedPapers || mergeCatalog(s.pages);
  $('counts').textContent = `队列进度 ${s.cursor} / ${s.queue.length} 页 · 候选条目 ${papers.length} 条 · 无 DOI ${papers.filter(p => !p.doi).length} 条`;
  for (const id of ['start', 'skip']) $(id).disabled = !writable || !controller.current() || (id === 'start' && s.mode === 'running');
  $('pause').disabled = !writable || s.mode !== 'running'; $('retry').disabled = !writable || s.mode === 'running'; $('export').disabled = false;
  $('recheck').disabled = !writable || s.mode === 'running';
  $('details').disabled = !writable || s.mode === 'running' || (!papers.length&&!runId);
  $('sample-details').disabled = !writable || s.mode === 'running' || !papers.length;
  $('manual-link').hidden = !controller.current();
  if (controller.current()) $('manual-link').href = controller.current().url;
  $('catalogs').replaceChildren(...CATALOG_TASKS.map(task => {
    const card = document.createElement('article'), h = document.createElement('h3'), a = document.createElement('a');
    h.textContent = `${task.journal} · ${task.collection==='issue'?'最新一期':'在线发表'} · ${task.label}`; a.href = task.url; a.textContent = '手动打开该目录 ↗'; a.target = '_blank'; a.rel = 'noopener noreferrer'; card.append(h, a);
    const filter=$('collection-filter').value;card.hidden=filter!=='all'&&task.collection!==filter;
    const pages = s.pages.filter(p => p.task_id === task.id), status = document.createElement('p');
    status.textContent = pages.length ? pages.map(p => `${labels[p.status] || p.status}：${p.items.length} 条`).join('；') : '等待读取'; card.append(status);
    for (const page of pages) {
      if (s.last_attempts?.[page.job_key]) {
        const failed = document.createElement('p'); failed.className = 'note';
        failed.textContent = '最近一次补跑未成功，下面仍保留上次读到的结果；可以继续补跑。'; card.append(failed);
      }
      if (page.more_controls?.length || page.next_links?.length || page.warnings?.length || page.pagination_note) {
        const note = document.createElement('p'); note.className = 'note'; note.textContent = '覆盖提示：' + JSON.stringify({ more: page.more_controls, next: page.next_links, note: page.pagination_note, warnings: page.warnings }); card.append(note);
      }
      if (page.items.length) {
        const details = document.createElement('details'), summary = document.createElement('summary'), list = document.createElement('ol');
        summary.textContent = `展开本页 ${page.items.length} 条标题`;
        for (const raw of page.items) { const item = papers.find(p => p.journal === raw.journal && (p.url === raw.url || p.alternate_records?.some(a=>a.url===raw.url))) || raw;
          const li = document.createElement('li'), link = document.createElement('a'); link.href = item.url; link.textContent = item.title; link.target = '_blank'; link.rel = 'noopener noreferrer';
          li.append(link, document.createTextNode(` · ${item.doi || '暂无 DOI'} · ${item.authors_raw || '作者待补'} · ${catalogDateLabel(item,catalogMembership(page,task))}${item.type === 'other' ? ' · 其他' : ''}${item.retraction_status === 'retracted' ? ' · 已撤稿' : ''}${item.record_resolution ? ' · 已合并官网旧入口（原记录保留）' : ''}${item.review_status === 'source_checked_candidate' ? ' · 已核对原文' : ' · 待核对'}`)); list.append(li); }
        details.append(summary, list); card.append(details);
      }
    }
    return card;
  }));
}
async function boot() {
  document.querySelector('.tag').textContent='PAPER DAILY · 目录采集 '+chrome.runtime.getManifest().version;
  if(runId){const run=await storedRun(runId);CATALOG_TASKS=ACTIVE_CATALOG_TASKS.filter(t=>run.jobs.some(j=>j.catalog_id===t.id));
    $('sample-details').hidden=true;$('pipeline').checked=true;
    document.querySelector('h1').textContent=run.mode==='daily'?'正式流程 · 日常增量目录':'正式流程 · 全刊目录巡检';
    document.querySelector('header p').textContent='只读取本批次目录；原文核对后自动建立增量详情队列。已有完整论文不重复访问，采集完成后提交正式流程服务。';
    const old=document.querySelector('header a');old.href='workflow.html';old.textContent='返回正式流程入口';
    $('details').textContent='进入本批次增量详情';
    $('pipeline').parentElement.lastChild.textContent=' 目录核对结束后自动采集新增 / 到期未完成论文';}
  $('collection-filter').addEventListener('change',()=>controller&&render(controller.s));
  pipelineArmed=!catalogOnly && !!(await chrome.storage.local.get(PIPELINE_KEY))[PIPELINE_KEY];
  if(catalogOnly){await chrome.storage.local.set({[PIPELINE_KEY]:false});$('pipeline').checked=false;$('pipeline').disabled=true;$('details').hidden=true;}
  $('recheck').textContent=`重新读取${runId?'本批次':'全部'} ${CATALOG_TASKS.length} 个入口（保留旧结果）`;
  const sessionKey = CATALOG_STATE + '_owned_tab';
  controller = new CatalogEngine({ now: () => Date.now(), render,
    load: async () => (await chrome.storage.local.get(CATALOG_STATE))[CATALOG_STATE], save: value => chrome.storage.local.set({ [CATALOG_STATE]: value }),
    loadSession: async () => (await chrome.storage.session.get(sessionKey))[sessionKey], saveSession: value => chrome.storage.session.set({ [sessionKey]: value }),
    createTab: url => chrome.tabs.create({ url, active: true }), getTab: id => chrome.tabs.get(id), navigate: (id, url) => chrome.tabs.update(id, { url }),
    inspect: async tabId => { const result = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: readCatalogDocument }); if (!result[0]?.result) throw Error('No capture'); return result[0].result; }
  });
  for (const id of ['start', 'pause', 'skip', 'retry', 'recheck']) $(id).addEventListener('click', async () => {
    if (!writable) return;
    try {
      if (id === 'pause') autoReview?.stop();
      if(id==='pause'){pipelineArmed=false;await chrome.storage.local.set({[PIPELINE_KEY]:false});}
      if(['start','recheck'].includes(id)){pipelineArmed=!catalogOnly && $('pipeline').checked;await chrome.storage.local.set({[PIPELINE_KEY]:pipelineArmed});}
      if(id==='retry'){pipelineArmed=false;await chrome.storage.local.set({[PIPELINE_KEY]:false});}
      if (['start','skip','retry','recheck'].includes(id)) autoReview?.reset();
      displayedPapers = null; await controller[id]();
    } catch { $('status').textContent = '操作失败，未清空数据；请先导出已有结果。'; }
  });
  $('export').addEventListener('click', async () => {
    await refreshReviewed();
    const detailStateKey=runId?detailKey(runId):DETAIL_STATE_KEY;
    const details=(await chrome.storage.local.get(detailStateKey))[detailStateKey]||{records:[]};
    const reviews=(await chrome.storage.local.get(REVIEW_KEY))[REVIEW_KEY]||{};
    const detailPlan=await prepareReviewPlan(makeReviewJobs(null,details,{includeRetired:true}),reviews);
    const data = { ...controller.export(), papers:mergeDetailPapers(displayedPapers,await reviewedArticleRecords(details,detailPlan,reviews)),
      details,...await autoReview?.export(),detail_review_results:Object.fromEntries(detailPlan.jobs.filter(j=>reviews[j.hash]).map(j=>[j.hash,reviews[j.hash]])) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'paper-catalog-trial-' + new Date().toISOString().slice(0, 10) + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  $('details').addEventListener('click',async()=>{
    if(!writable||controller.s.mode==='running')return;
    if(autoReview.isRunning()){autoReview.stop();$('status').textContent='当前核对结束后，请再点“补摘要和作者单位”。目录进度保留。';return;}
    await enterDetails();
  });
  $('sample-details').addEventListener('click',async()=>{
    if(!writable||controller.s.mode==='running')return;
    if(autoReview.isRunning()){autoReview.stop();$('status').textContent='等当前核对保存后，再点抽样测试。';return;}
    await chrome.storage.local.set({[PIPELINE_KEY]:false});autoReview.close();
    location.href=chrome.runtime.getURL('dashboard.html?queue=catalog-sample');
  });
  $('pipeline').addEventListener('change',async()=>{pipelineArmed=$('pipeline').checked && controller.s.mode==='running';await chrome.storage.local.set({[PIPELINE_KEY]:pipelineArmed});});
  // The same lock as the abstract dashboard: only one pilot controls tabs at a time.
  await navigator.locks.request('paper-abstract-controller', { ifAvailable: true }, async lock => {
    if (!lock) { $('status').textContent = '另一个摘要或目录面板正在使用。请关闭其他助手面板，再刷新本页。'; return; }
    writable = true; await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); await controller.init();
    autoReview = mountAutoReview(() => makeReviewJobs(controller.s, null), runId?'catalog-'+runId:'catalog', refreshReviewed);
    await refreshReviewed();
    chrome.storage.onChanged?.addListener((changes, area) => { if (area === 'local' && changes[REVIEW_KEY]) void refreshReviewed(); });
    const listener = (message, sender, sendResponse) => {
      if (message?.type !== 'catalog-adopt-manual' || sender.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL('action-popup.html') || !writable) return;
      if(runId&&!CATALOG_TASKS.some(t=>t.id===message.taskId)){sendResponse({message:'这个目录不在当前正式批次中，原任务不变。'});return;}
      autoReview.reset();
      controller.adoptManual(message.tabId, message.taskId).then(() => sendResponse({ message: controller.s.reason }))
        .catch(e => sendResponse({ message: e.message })); return true;
    };
    chrome.runtime.onMessage.addListener(listener);
    chrome.tabs.onRemoved.addListener(id => { void controller.tabClosed(id).catch(() => {}); });
    const timer = setInterval(() => { void controller.tick().then(() => { if (controller.s.mode === 'running') displayedPapers = null; autoReview.tick(controller.s.mode); }).catch(() => { $('status').textContent = '采集状态更新失败，请导出已有结果；核对未被当作成功。'; }); }, 2000);
    await new Promise(resolve => window.addEventListener('pagehide', () => { clearInterval(timer); autoReview.close(); chrome.runtime.onMessage.removeListener(listener); writable = false; resolve(); }, { once: true }));
  });
}
boot().catch(() => { $('status').textContent = '无法恢复目录进度或权限不足。未覆盖原有摘要数据。'; });
