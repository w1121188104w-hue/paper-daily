import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ACTIVE_CATALOG_TASKS, catalogUrl, articleUrl, cleanDoi, titleKey } from '../../tools/browser-abstract-extension/catalog-core.js';
import { catalogRepairJobs } from '../../tools/browser-abstract-extension/catalog-engine.js';
import { makeReviewJobs, reviewedCatalogPapers } from '../../tools/browser-abstract-extension/review-core.js';
import { prepareReviewPlan } from '../../tools/browser-abstract-extension/review-client.js';
import { canonicalEvidence } from '../../tools/browser-abstract-extension/article-review.js';
import { assertLibrary } from './libraryValidation.js';
import { classifyPaper } from './paperClassification.js';
import { verifiedPages } from './browserImport.js';
import { excludedJpePaper } from '../../tools/browser-abstract-extension/collection-policy.js';
import { writeWorkflowJson } from './workflowStorage.js';
import { discoveryCatalogEvidenceUrl } from './discoveryLead.js';

export const WORKFLOW_PATH = 'data/collection-workflow/state.json';
const sha = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const time = x => typeof x === 'string' && Number.isFinite(Date.parse(x));
const taskFor = id => ACTIVE_CATALOG_TASKS.find(t => t.id === id);
export const emptyWorkflow = () => ({ schema_version: 1, updated_at: null, tasks: [], monitors: [], receipts: [], checked_papers: [] });

export function validateWorkflow(s) {
  assertLibrary(s?.schema_version === 1 && ['tasks','monitors','receipts','checked_papers'].every(k => Array.isArray(s[k])), '任务账本格式无效');
  assertLibrary(s.tasks.length <= 20000 && s.receipts.length <= 10000, '任务账本需要归档，不能截断历史');
  const ids = new Set();
  for (const t of s.tasks) {
    const c = taskFor(t.catalog_id);
    assertLibrary(c && catalogUrl(t.url,c) === t.url && t.id === sha([t.catalog_id,t.url]) && !ids.has(t.id) &&
      ['pending','processed'].includes(t.status) && Array.isArray(t.signals) && t.signals.length <= 10000 &&
      time(t.created_at) && time(t.updated_at), '目录任务身份无效');
    ids.add(t.id);
    for (const signal of t.signals) assertLibrary(/^[a-f0-9]{64}$/.test(signal.key) &&
      ['crossref','openalex','semanticscholar','zhipu','serpapi_scholar','serpapi_google','manual'].includes(signal.source) &&
      typeof signal.title === 'string' && signal.title.length <= 1500 && (!signal.doi || cleanDoi(signal.doi) === signal.doi), '目录提醒证据无效');
  }
  for (const p of s.checked_papers) assertLibrary(cleanDoi(p.doi) === p.doi && typeof p.journal === 'string' &&
    p.doi && ['complete','confirmed_absent','other','missing'].includes(p.status) && time(p.checked_at) &&
    (!p.next_retry_at || time(p.next_retry_at)), '论文处理回执无效');
  for (const r of s.receipts) assertLibrary(typeof r.id === 'string' && time(r.at) && ['daily','full'].includes(r.mode) &&
    ['completed_catalogs','pending_catalogs'].every(k=>Number.isInteger(r[k]) && r[k]>=0) && Array.isArray(r.pending_papers), '批次回执无效');
  for (const m of s.monitors) assertLibrary(typeof m.journal === 'string' && time(m.checked_at) &&
    ['crossref','openalex','semanticscholar','search'].includes(m.source) && ['ok','partial','failed','disabled','quota_exhausted'].includes(m.status), '发现状态无效');
  return s;
}
export async function readWorkflow(repositoryRoot) {
  try { const file=path.join(repositoryRoot,WORKFLOW_PATH); assertLibrary((await fs.stat(file)).size<=32*1024*1024,'任务账本过大');
    return validateWorkflow(JSON.parse(await fs.readFile(file,'utf8'))); }
  catch(e) { if(e.code === 'ENOENT') return emptyWorkflow(); throw e; }
}
export async function saveWorkflow(repositoryRoot, state) {
  validateWorkflow(state);
  await writeWorkflowJson(path.join(repositoryRoot,WORKFLOW_PATH),state);
}

/** Positive evidence only. Search absence NEVER completes a directory task.
 * Caller owns the repository writer lock and durable paid-search budget. */
export function addDiscoverySignals(input, observations, { now = new Date() } = {}) {
  const state = structuredClone(validateWorkflow(input)), at = now.toISOString();
  for (const o of observations) {
    const catalog = taskFor(o.catalog_id); if(!catalog) continue;
    const url = catalogUrl(o.catalog_url || catalog.url,catalog);
    if(!url || typeof o.title !== 'string' || !o.title.trim() || o.title.length > 1500) continue;
    const doi = cleanDoi(o.doi), sourceUrl = o.source_url && (catalogUrl(o.source_url,catalog) || articleUrl(o.source_url,catalog) || discoveryCatalogEvidenceUrl(o.source_url,catalog));
    if(!['crossref','openalex','semanticscholar'].includes(o.source) && !sourceUrl) continue;
    const signal = { key:sha([doi || sourceUrl,doi?'':titleKey(o.title),o.change_key || '']), source:o.source,
      title:o.title, doi, source_url:sourceUrl || null, discovered_at:at,
      confidence:['crossref','openalex','semanticscholar'].includes(o.source) ? 'paper_detected' : 'possible_update' };
    const id=sha([catalog.id,url]); let task=state.tasks.find(t=>t.id===id);
    if(!task) { task={id,catalog_id:catalog.id,journal:catalog.journal,collection:catalog.collection,url,
      status:'pending',created_at:at,updated_at:at,signals:[],checked_at:null,receipt_id:null}; state.tasks.push(task); }
    if(task.signals.some(s=>s.key===signal.key)) continue;
    task.signals.push(signal); task.status='pending'; task.updated_at=at;
  }
  state.updated_at=at; return validateWorkflow(state);
}

export function publicWorkflow(state, { now = new Date(), papers = [] } = {}) {
  validateWorkflow(state);
  return {schema_version:1,updated_at:state.updated_at,coverage:'signals_are_not_complete_catalogs',
    tasks:state.tasks.filter(t=>t.status==='pending').map(t=>({id:t.id,catalog_id:t.catalog_id,journal:t.journal,collection:t.collection,
      url:t.url,signal_count:t.signals.length,confidence:t.signals.some(s=>s.confidence==='paper_detected')?'paper_detected':'possible_update',
      updated_at:t.updated_at,titles:t.signals.slice(-5).map(s=>s.title)})),
    pending_papers:pendingWorkflowPapers(state,papers),
    monitors:state.monitors.map(m=>({journal:m.journal,source:m.source,status:m.status,checked_at:m.checked_at})), receipts:state.receipts.slice(-20).map(r=>({id:r.id,at:r.at,mode:r.mode,
      completed_catalogs:r.completed_catalogs,pending_catalogs:r.pending_catalogs,pending_papers:r.pending_papers.length,input_sha256:r.input_sha256,
      publication_id:r.publication_id||null,pending_translation_fields:r.pending_translation_fields||0})),
    full_audit_last_at:[...state.receipts].reverse().find(r=>r.mode==='full'&&r.pending_catalogs===0)?.at || null,
    known_papers:papers.map(p=>{const checked=state.checked_papers.find(x=>x.doi===p.doi&&x.journal===p.journal_key);
      return {doi:p.doi,journal:p.journal_key,title:p.title_original,complete:!!p.abstract_original || checked?.status==='confirmed_absent' || classifyPaper(p).kind==='other',
        next_retry_at:checked?.status==='missing'?checked.next_retry_at:null};}),generated_at:now.toISOString()};
}

export function createCollectionRun(state, papers, { mode='daily', now=new Date(), maxRequests=100 }={}) {
  validateWorkflow(state);
  assertLibrary(['daily','full'].includes(mode) && Number.isInteger(maxRequests) && maxRequests>0 && maxRequests<=1000,'运行参数无效');
  const active=state.tasks.filter(t=>t.status==='pending');
  const jobs=mode==='full'?ACTIVE_CATALOG_TASKS.map(t=>({catalog_id:t.id,url:t.url})):active.map(t=>({catalog_id:t.catalog_id,url:t.url}));
  // Full audits also retain explicitly discovered intermediate issue URLs.
  for(const t of active) if(!jobs.some(j=>j.catalog_id===t.catalog_id&&j.url===t.url)) jobs.push({catalog_id:t.catalog_id,url:t.url});
  // Revisit only the relevant directories when an unfinished paper is due.
  for(const p of pendingWorkflowPapers(state,papers)) if(!p.next_retry_at || Date.parse(p.next_retry_at)<=now.getTime())
    for(const m of p.catalog_memberships||[]) {const task=taskFor(m.task_id),url=task&&catalogUrl(m.catalog_url,task);
      if(url&&!jobs.some(j=>j.catalog_id===task.id&&j.url===url))jobs.push({catalog_id:task.id,url});}
  return {version:1,id:randomUUID(),mode,created_at:now.toISOString(),max_requests:maxRequests,
    jobs, task_versions:active.map(t=>({id:t.id,signals:t.signals.map(s=>s.key)})),
    known_papers:publicWorkflow(state,{papers,now}).known_papers};
}

/** Replay original catalog evidence, never trust export.papers or a client success flag. */
export async function checkedCatalogPapers(data) {
  const catalog={...data.catalog,pages:verifiedPages(data)};
  const cache=Object.fromEntries(Object.entries(data.catalog_review_results || {}).filter(([,r])=>r?.input));
  const plan=await prepareReviewPlan(makeReviewJobs(catalog,null),cache);
  for(const j of plan.jobs) if(cache[j.hash] && canonicalEvidence(cache[j.hash].input)!==canonicalEvidence(j.input)) delete cache[j.hash];
  return reviewedCatalogPapers(catalog,plan,cache);
}

export function pendingWorkflowPapers(state,papers=[]) {
  const latest=new Map();
  for(const r of state.receipts)for(const p of r.pending_papers)latest.set(`${p.journal}|${p.doi||titleKey(p.title)}`,p);
  return [...latest.values()].filter(p=>!papers.some(x=>x.journal_key===p.journal&&x.doi&&x.doi===p.doi&&
    (x.abstract_original||classifyPaper(x).kind==='other'))&&!state.checked_papers.some(x=>x.journal===p.journal&&x.doi&&x.doi===p.doi&&['complete','confirmed_absent','other'].includes(x.status)))
    .map(p=>({...p,next_retry_at:state.checked_papers.find(x=>x.doi===p.doi&&x.journal===p.journal)?.next_retry_at||p.next_retry_at||null}));
}

export function validateCollectionRun(run) {
  assertLibrary(run?.version===1 && /^[a-f0-9-]{36}$/.test(run.id) && ['daily','full'].includes(run.mode) && time(run.created_at) &&
    Array.isArray(run.jobs) && run.jobs.length<=2000 && Array.isArray(run.task_versions) && Array.isArray(run.known_papers),'运行清单无效');
  assertLibrary(new Set(run.jobs.map(j=>j.catalog_id+'|'+j.url)).size===run.jobs.length && run.jobs.every(j=>{
    const t=taskFor(j.catalog_id);return t&&catalogUrl(j.url,t)===j.url;}),'运行清单目录无效');
  return run;
}

export async function applyCollectionReceipt(input, run, data, prepared, library, { now=new Date() }={}) {
  const state=structuredClone(validateWorkflow(input)), at=now.toISOString();
  validateCollectionRun(run);
  assertLibrary(data.workflow_run_id===run.id && Array.isArray(data.catalog?.pages) && time(run.created_at),'回执不属于当前任务');
  if(state.receipts.some(r=>r.id===run.id&&r.input_sha256===prepared.input_sha256)) return state;
  const pages=verifiedPages(data), pending=[], completeJobs=[];
  const checked=await checkedCatalogPapers(data);
  const repair=catalogRepairJobs(data.catalog);
  for(const job of run.jobs) {
    const task=taskFor(job.catalog_id), captured=pages.filter(p=>p.task_id===job.catalog_id && p.captured_at>=run.created_at &&
      catalogUrl(p.source_url,task) && ['catalog_candidates','catalog_empty','catalog_landing'].includes(p.status));
    const root=captured.find(p=>[p.requested_url,p.source_url].includes(job.url));
    const unfinished=(data.catalog.queue||[]).slice(data.catalog.cursor).some(j=>j.task_id===job.catalog_id);
    const unreviewed=checked.some(p=>p.catalog_memberships?.some(m=>m.task_id===job.catalog_id)&&p.review_status!=='source_checked_candidate'&&p.type!=='other'&&!excludedJpePaper(p));
    if(!root || unfinished || unreviewed || repair.some(j=>j.task_id===job.catalog_id) || captured.some(p=>p.more_controls?.length || p.pagination_unresolved || p.pagination_note ||
      p.warnings?.some(w=>/not_stable|limit|unresolved/i.test(w)))) pending.push(job);
    else completeJobs.push(job);
  }
  const lib=new Map(library.papers.map(p=>[p.doi,p]));
  const accepted=new Set(prepared.sources.map(s=>s.doi));
  const pendingPapers=[];
  for(const p of checked) {
    if(!run.jobs.some(j=>p.catalog_memberships?.some(m=>m.task_id===j.catalog_id))) continue;
    if(excludedJpePaper(p)||p.type==='other')continue;
    const paper=lib.get(p.doi), source=prepared.sources.find(s=>s.doi===p.doi);
    const old=state.checked_papers.find(x=>x.doi===p.doi&&x.journal===p.journal);
    let status=paper?.journal_key===p.journal&&(paper.abstract_original||classifyPaper(paper).kind==='other')?'complete':
      old?.status==='confirmed_absent'?'confirmed_absent':null;
    if(!status && source?.raw_dates?.browser_import?.abstract_state==='confirmed_absent') status='confirmed_absent';
    if(!status) pendingPapers.push({doi:p.doi||null,journal:p.journal,title:p.title,url:p.url,catalog_memberships:p.catalog_memberships,next_retry_at:new Date(now.getTime()+7*86400000).toISOString(),
      reason:!p.doi?'no_doi_yet':accepted.has(p.doi)?'abstract_missing':'detail_or_identity_pending'});
    if(p.doi && (source || status)) {
      const value={doi:p.doi,journal:p.journal,status:status||'missing',checked_at:at,
        next_retry_at:status?null:new Date(now.getTime()+7*86400000).toISOString()};
      if(old) Object.assign(old,value); else state.checked_papers.push(value);
    }
  }
  for(const captured of completeJobs) {
    const task=state.tasks.find(t=>t.catalog_id===captured.catalog_id&&t.url===captured.url);
    const version=task&&run.task_versions.find(t=>t.id===task.id);
    if(!task || !version) continue;
    // New reminders that arrived after the run started must remain pending.
    if(task.signals.every(s=>version.signals.includes(s.key))) {task.status='processed';task.checked_at=at;task.receipt_id=run.id;}
  }
  state.receipts=state.receipts.filter(r=>r.id!==run.id);
  state.receipts.push({id:run.id,at,mode:run.mode,completed_catalogs:completeJobs.length,pending_catalogs:pending.length,
    pending_papers:pendingPapers,input_sha256:prepared.input_sha256});
  state.updated_at=at; return validateWorkflow(state);
}
