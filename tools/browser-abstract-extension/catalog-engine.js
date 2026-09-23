import { CATALOG_TASKS, ACTIVE_CATALOG_TASKS, catalogUrl, sameCatalogList, assessCatalog, mergeCatalog } from './catalog-core.js';
import {disabledCatalogUrl} from './collection-policy.js';
const key = job => `${job.task_id}|${job.url}`;
export const MAX_CATALOG_PAGES = 50;
const taskPageLimit = task => task?.landing ? MAX_CATALOG_PAGES : MAX_CATALOG_PAGES - 1;
const capturedOK = p => ['catalog_candidates', 'catalog_landing', 'catalog_empty'].includes(p?.status);
// Historical successful pages still contribute papers, but do not establish
// current-run coverage. Do not use repair_started_at: same-run pages stay fresh.
const currentRead = (p, state) => capturedOK(p) && (!state.run_started_at ||
  (Number.isFinite(Date.parse(p.captured_at)) && Date.parse(p.captured_at) >= Date.parse(state.run_started_at)));
const updatedEntry = (url, task) => {
  try {
    const u = new URL(url);
    return task.legacy_urls?.some(old => { const v=new URL(old);return u.origin===v.origin&&u.pathname===v.pathname; }) ?
      catalogUrl(task.url + u.search, task) : url;
  } catch { return url; }
};
function paginationMissing(page) {
  if (page.pagination_unresolved) return true;
  if (page.next_links?.length) return false;
  // Compatibility with 0.10.0/0.10.1 exports, which only saved pagination text.
  const numbers = (page.warnings || []).filter(w => w.startsWith('pagination_present:'))
    .flatMap(w => w.slice('pagination_present:'.length).match(/\b\d+\b/g) || []).map(Number);
  if (!numbers.length || !page.source_url) return false;
  const u = new URL(page.source_url);
  const current = page.pagination_current || (u.searchParams.has('startPage') ? Number(u.searchParams.get('startPage')) + 1 : Number(u.searchParams.get('page') || u.searchParams.get('pageNumber') || 1));
  return Math.max(...numbers) > current;
}
// Requeue only failed reads or unfinished pagination. Successful pages and AI
// caches are untouched. A capped page with a known next URL resumes there.
export function catalogRepairJobs(state) {
  const jobs = [], pages = state.pages || [];
  const add = job => { const task = CATALOG_TASKS.find(t => t.id === job.task_id); if (!task) return;
    job = {...job,url:updatedEntry(job.url,task)};
    if (!disabledCatalogUrl(job.url)&&catalogUrl(job.url, task) && !jobs.some(j => key(j) === key(job))) jobs.push(job); };
  const read = (task, url) => pages.some(p => p.task_id === task.id && currentRead(p,state) && [p.source_url, p.requested_url].includes(url));
  for (const task of ACTIVE_CATALOG_TASKS) {
    if(state.scope_task_ids&&!state.scope_task_ids.includes(task.id))continue;
    const group = pages.filter(p => p.task_id === task.id);
    if (!group.length) { add({task_id:task.id,url:task.url,depth:0}); continue; }
    for (const page of group) {
      const url = page.requested_url || page.source_url || task.url;
      const oldJob = state.queue?.find(j => key(j) === page.job_key);
      const depth = oldJob?.depth ?? page.pagination_depth ?? 0;
      const replacement=updatedEntry(url,task);
      if(replacement!==url){if(!read(task,replacement))add({task_id:task.id,url:replacement,depth:0});continue;}
      if (!capturedOK(page) || state.last_attempts?.[page.job_key]) { add({task_id:task.id,url,depth}); continue; }
      if (page.status === 'catalog_landing' && page.issue_target && !read(task, page.issue_target)) add({task_id:task.id,url:page.issue_target,depth:1});
      const next = (page.next_links || []).filter(u => sameCatalogList(page.source_url, u, task) && !read(task, u));
      if (next.length && !['repeated_catalog_page','catalog_page_limit_reached'].includes(page.pagination_note)) {
        if (depth < taskPageLimit(task)) add({task_id:task.id,url:next[0],depth:depth+1});
      } else if (paginationMissing(page) || (page.warnings || []).includes('card_limit_500')) add({task_id:task.id,url,depth});
    }
  }
  // Do not discard still-pending work when retry is clicked during a pause.
  for (const job of (state.queue || []).slice(state.cursor || 0)) {
    const task = CATALOG_TASKS.find(t => t.id === job.task_id);
    if (task && !read(task, job.url)) add(job);
  }
  return jobs;
}
export class CatalogEngine {
  constructor(env) {
    this.env = env; this.busy = false; this.epoch = 0; this.nextAt = 0; this.owned = null; this.lastSignature = null; this.reads = 0;
    this.s = { schema_version: 1, mode: 'paused', reason: '准备就绪，点击开始采集目录。', cursor: 0,
      queue: ACTIVE_CATALOG_TASKS.map(t => ({ task_id: t.id, url: t.url, depth: 0 })), pages: [], history: [] };
    this.saveChain = Promise.resolve();
  }
  current() { return this.s.queue[this.s.cursor]; }
  task() { return CATALOG_TASKS.find(t => t.id === this.current()?.task_id); }
  async persist() {
    this.s.updated_at = new Date(this.env.now()).toISOString();
    const copy = structuredClone(this.s);
    this.saveChain = this.saveChain.then(() => this.env.save(copy));
    await this.saveChain; this.env.render(this.s);
  }
  async init() {
    const saved = await this.env.load();
    if (saved) {
      if (saved.schema_version !== 1 || !Array.isArray(saved.queue) || saved.queue.length > CATALOG_TASKS.length * (MAX_CATALOG_PAGES + 1) ||
        !Array.isArray(saved.pages) || !Array.isArray(saved.history) || !Number.isInteger(saved.cursor) || saved.cursor < 0 || saved.cursor > saved.queue.length ||
        saved.queue.some(j => { const t = CATALOG_TASKS.find(t => t.id === j.task_id); return !t || !catalogUrl(j.url, t) || !Number.isInteger(j.depth) || j.depth < 0 || j.depth > taskPageLimit(t); }) ||
        new Set(saved.queue.map(key)).size !== saved.queue.length) throw Error('目录试验进度格式不匹配，未覆盖原数据。');
      const complete = saved.cursor === saved.queue.length && saved.pages.length > 0;
      this.s = { ...saved, mode: complete ? 'done' : 'paused', reason: complete ? '目录采集已完成；正在恢复待核对进度，无需重新采集。' : '已恢复目录进度；点击继续。' };
    }
    this.s.queue=[...this.s.queue.slice(0,this.s.cursor),...this.s.queue.slice(this.s.cursor).filter(j=>!disabledCatalogUrl(j.url))];
    if(this.s.cursor===this.s.queue.length){this.s.mode='done';this.s.reason='目录队列已结束；JPE Just Accepted 已停用，历史结果保留。';}
    this.owned = await this.env.loadSession();
    if (!Number.isInteger(this.owned?.tabId)) this.owned = null;
    await this.persist();
  }
  async start() {
    if (this.s.mode === 'running') return;
    if (!this.current()) return;
    this.epoch++; this.reads = 0; this.lastSignature = null;
    // Resume a legacy pending entry at its replacement without rewriting stored
    // pages or history. Completed jobs remain available for audit.
    const job=this.current(), target=updatedEntry(job.url,this.task());
    if(target!==job.url){
      job.url=target;
      // A restored queue may contain both the legacy and replacement entry.
      // Keep the current job once, preserving all other pending work.
      const before=this.s.queue.slice(0,this.s.cursor).filter(j=>key(j)!==key(job));
      const after=this.s.queue.slice(this.s.cursor+1).filter(j=>key(j)!==key(job));
      this.s.queue=[...before,job,...after];this.s.cursor=before.length;
      this.owned=null;await this.env.saveSession(null);
    }
    this.s.run_started_at ||= new Date(this.env.now()).toISOString();
    this.s.mode = 'running'; this.nextAt = this.env.now() + 1000;
    this.s.reason = '正在自动读取目录；本轮采集结束后自动进行 AI 原文核对。'; await this.persist();
  }
  async pause(reason = '已暂停，已保存的目录保留。') { this.epoch++; this.s.mode = 'paused'; this.s.reason = reason; await this.persist(); }
  async adoptManual(tabId, taskId) {
    await this.pause('正在核对你选择的目录页……');
    if (this.busy) throw Error('上一轮读取正在结束，请稍后再点一次。');
    this.busy = true; const epoch = this.epoch;
    try {
      const task = CATALOG_TASKS.find(t => t.id === taskId), tab = await this.env.getTab(tabId);
      if(disabledCatalogUrl(task?.url))throw Error('JPE Just Accepted 已按要求停用。');
      const url = task && catalogUrl(tab.url, task);
      if (!url || tab.status === 'loading') throw Error('请在对应期刊目录加载成功后再读取。');
      const raw = await this.env.inspect(tabId), check = assessCatalog(task, raw);
      const after = await this.env.getTab(tabId);
      if (epoch !== this.epoch) return;
      if (catalogUrl(after.url, task) !== url || catalogUrl(raw.url, task) !== url || !['catalog_candidates','catalog_landing','catalog_empty'].includes(check.status))
        throw Error('本页尚未读到该期刊的有效目录；请完成验证并确认选对目录类型。');
      const prior = this.s.queue.find(j => j.task_id === taskId && j.url === url);
      const job = prior || { task_id: taskId, url, depth: 0 };
      // Keep history/results; move only this explicit page to the front of remaining work.
      const remaining = this.s.queue.slice(this.s.cursor).filter(j => key(j) !== key(job) &&
        !(j.task_id === taskId && j.depth === 0));
      this.s.queue = [job, ...remaining]; this.s.cursor = 0;
      this.owned = { tabId, job_key: key(job), manual: true }; await this.env.saveSession(this.owned);
      this.reads = 1; this.lastSignature = JSON.stringify(check.items.map(x => [x.title, x.doi, x.url]));
      this.s.mode = 'running'; this.nextAt = this.env.now() + 1000;
      this.s.reason = '已接续你手动打开的目录；稳定读取后自动继续。不会改动这个手动标签页。';
      await this.persist();
    } finally { this.busy = false; }
  }
  async recheck() {
    if (this.s.mode === 'running' || this.busy) return;
    this.epoch++; this.s.queue = this.s.scope_task_ids ? [...new Map(this.s.queue.filter(j=>j.depth===0).map(j=>[key(j),j])).values()] : ACTIVE_CATALOG_TASKS.map(t => ({ task_id: t.id, url: t.url, depth: 0 }));
    this.s.cursor = 0; this.s.mode = 'paused'; this.owned = null; await this.env.saveSession(null);
    this.s.run_started_at = new Date(this.env.now()).toISOString();
    this.s.reason = `${this.s.queue.length} 个入口已重新排队；旧结果保留，更新时归入历史。点击开始。`; await this.persist();
  }
  async finish(result) {
    const job = this.current(), captured = new Date(this.env.now()).toISOString();
    const page = { ...result, job_key: key(job), requested_url: job.url, captured_at: captured, pagination_depth: job.depth,
      items: (result.items || []).map(x => ({ ...x, discovered_at: captured })) };
    const old = this.s.pages.findIndex(x => x.job_key === page.job_key);
    const repeated = page.items.length && this.s.pages.some(p => p.task_id === job.task_id && p.job_key !== page.job_key && p.items?.length &&
      JSON.stringify(p.items.map(x => [x.title, x.doi, x.url])) === JSON.stringify(page.items.map(x => [x.title, x.doi, x.url])));
    if (old >= 0 && this.s.pages[old].items?.length && !page.items.length) {
      // A transient failed/empty retry must not remove previously captured papers.
      this.s.history.push(page); this.s.last_attempts ||= {};
      this.s.last_attempts[page.job_key] = {status:page.status,captured_at:captured};
    } else {
      if (old >= 0) { this.s.history.push(this.s.pages[old]); this.s.pages[old] = page; } else this.s.pages.push(page);
      if (this.s.last_attempts) delete this.s.last_attempts[page.job_key];
    }
    if (page.status === 'catalog_landing' && page.issue_target && job.depth === 0 &&
        !this.s.queue.some(j => j.task_id === job.task_id && j.url === page.issue_target)) {
      this.s.queue.splice(this.s.cursor + 1, 0, {task_id:job.task_id,url:page.issue_target,depth:1});
    }
    if (page.status === 'catalog_candidates' && page.next_links?.length) {
      // Explicit same-list pagination only; no next issue or next article.
      const sameList = page.next_links.filter(u => sameCatalogList(page.source_url, u, this.task()));
      const next = sameList.find(url => !this.s.queue.some(j => j.task_id === job.task_id && j.url === url) &&
        !this.s.pages.some(p => p.task_id === job.task_id && currentRead(p,this.s) && [p.source_url,p.requested_url].includes(url)));
      const pageLimit = taskPageLimit(this.task());
      if (repeated) page.pagination_note = 'repeated_catalog_page';
      else if (next && job.depth < pageLimit) this.s.queue.splice(this.s.cursor + 1, 0, { task_id: job.task_id, url: next, depth: job.depth + 1 });
      else if (next) page.pagination_note = 'catalog_page_limit_reached';
      else if (!sameList.length) page.pagination_note = 'loop_or_unsupported_next_link';
    }
    this.s.cursor++; this.reads = 0; this.lastSignature = null; this.nextAt = this.env.now() + 10000;
    if (this.owned?.manual) { this.owned = null; await this.env.saveSession(null); }
    if (!this.current()) { this.s.mode = 'done'; this.s.reason = '本轮目录采集结束；自动核对进度见下方。读取到条目不代表最近 60 天已收齐。'; }
    else this.s.reason = '本页结果已保存，10 秒后读取下一目录页。';
    await this.persist();
  }
  async skip() {
    if (!this.current()) return;
    this.epoch++; this.s.mode = 'running';
    await this.finish({ task_id: this.task().id, journal: this.task().journal, status: 'skipped', items: [], completeness: 'not_established' });
  }
  async retry() {
    if (this.s.mode === 'running' || this.busy) return;
    this.epoch++;
    this.s.queue = catalogRepairJobs(this.s);
    this.s.cursor = 0; this.s.mode = 'paused'; this.owned = null; await this.env.saveSession(null);
    this.s.repair_started_at = new Date(this.env.now()).toISOString();
    this.s.reason = this.current() ? `已排队 ${this.s.queue.length} 个失败或未完成页面；成功结果保留，点击开始。` : '没有可自动补跑的失败或未完成页面；请导出检查覆盖提示。';
    await this.persist();
  }
  async tabClosed(id) {
    if (this.owned?.tabId !== id) return;
    this.owned = null; await this.env.saveSession(null);
    if (this.current()) await this.pause('目录标签页被关闭，已暂停；点击继续会重新打开。');
  }
  async tick() {
    if (this.busy || this.s.mode !== 'running' || this.env.now() < this.nextAt) return;
    this.busy = true; const epoch = this.epoch, live = () => this.epoch === epoch && this.s.mode === 'running';
    try {
      const job = this.current(), task = this.task(); if (!job || !task) return;
      let tab;
      if (this.owned) { try { tab = await this.env.getTab(this.owned.tabId); } catch { this.owned = null; } }
      if (!live()) return;
      if (!tab || this.owned.job_key !== key(job)) {
        // Never navigate a tab the user has repurposed outside our catalog paths.
        if (tab && !this.owned.manual && CATALOG_TASKS.some(t => catalogUrl(tab.url, t))) tab = await this.env.navigate(tab.id, job.url);
        else tab = await this.env.createTab(job.url);
        this.owned = { tabId: tab.id, job_key: key(job) }; await this.env.saveSession(this.owned);
        if (!live()) return;
        this.nextAt = this.env.now() + 8000; this.s.reason = '目录已打开，等待网页加载。'; await this.persist(); return;
      }
      if (!catalogUrl(tab.url, task)) { await this.pause('页面跳到登录页、其他期刊或不支持的网址，已暂停。请处理后继续，或跳过。'); return; }
      if (this.owned.manual && catalogUrl(tab.url, task) !== job.url) { await this.pause('手动标签页已切换到其他目录；请在目标目录重新点击“读取本页并继续任务”。'); return; }
      if (tab.status === 'loading') {
        this.reads++; this.nextAt = this.env.now() + 10000;
        if (this.reads >= 6) await this.pause('页面长时间未完成加载，已暂停；请检查目录页后继续或跳过。');
        return;
      }
      const raw = await this.env.inspect(tab.id);
      if (!live()) return;
      const afterRead = await this.env.getTab(tab.id);
      if (!live()) return;
      if (catalogUrl(afterRead.url, task) !== catalogUrl(raw.url, task)) { await this.pause('读取期间目录网址发生变化，请页面稳定后继续。'); return; }
      const result = assessCatalog(task, raw); this.reads++;
      if (['needs_user_verification', 'journal_conflict', 'wrong_catalog'].includes(result.status)) {
        this.s.last_problem = { task_id: task.id, status: result.status };
        await this.pause(result.status === 'needs_user_verification' ? '遇到网页验证，已暂停。请手动完成验证，再回来点击继续。' : '期刊身份不符，已暂停；请检查或跳过。'); return;
      }
      const sig = JSON.stringify(result.items.map(x => [x.title, x.doi, x.url]));
      if (this.reads < 3 && (result.status !== 'catalog_candidates' || sig !== this.lastSignature)) {
        this.lastSignature = sig; this.nextAt = this.env.now() + 10000; this.s.reason = '等待动态目录稳定，再读取一次；最多读取 3 轮。'; await this.persist(); return;
      }
      if (result.items.length && sig !== this.lastSignature) result.warnings.push('page_not_stable_within_three_reads');
      await this.finish(result);
    } catch {
      if (live()) await this.pause('目录读取或保存失败。请确认该网站的扩展权限，再继续；也可以跳过。').catch(() => { this.s.mode = 'paused'; });
    } finally { this.busy = false; }
  }
  export() {
    const currentPages = this.s.pages.filter(p => !this.s.run_started_at || p.captured_at >= this.s.run_started_at);
    return { ...structuredClone(this.s), kind: 'paper_catalog_trial', tasks: CATALOG_TASKS, papers: mergeCatalog(this.s.pages),
      current_run_papers: mergeCatalog(currentPages),
      catalog_test_summary: CATALOG_TASKS.map(t => {const pages=currentPages.filter(p=>p.task_id===t.id);return {
        task_id:t.id,journal:t.journal,collection:t.collection,label:t.label,entry_url:t.url,
        enabled:!disabledCatalogUrl(t.url),pages_read:pages.length,candidates:mergeCatalog(pages).length,status:disabledCatalogUrl(t.url)?'excluded_by_user':pages.length?'captured_not_yet_audited':'not_tested',
        page_statuses:pages.map(p=>p.status),coverage_warnings:pages.flatMap(p=>[...(p.warnings||[]),...(p.more_controls||[]),...(p.pagination_note?[p.pagination_note]:[])])};}),
      coverage: 'selected_current_and_online_first_catalogs_only_not_a_60_day_audit', production_writes: 0, ai_calls: 0,
      exported_at: new Date(this.env.now()).toISOString() };
  }
}
