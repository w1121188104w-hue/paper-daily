import { safeSourceUrl } from './core.js';
import {abstractRetryComplete} from './abstract-availability.js';
import {excludedJpePaper,excludedJpeRecord} from './collection-policy.js';

export const STATE_KEY = 'paper_abstract_trial_v1';
export class QueueEngine {
  constructor(papers, env) {
    this.papers = papers; this.env = env; this.epoch = 0; this.busy = false; this.saveChain = Promise.resolve();
    this.s = { schema_version: 1, sample_dois: papers.map(p => p.doi), queue: papers.map(p => p.doi), cursor: 0,
      mode: 'paused', reason: '准备好了，点击“开始补摘要”。', records: [], history: [], attempts: 0 };
    this.owned = null; this.nextAt = 0;
  }
  current() { return this.papers.find(p => p.doi === this.s.queue[this.s.cursor]); }
  excluded(p){return excludedJpePaper(p)||excludedJpeRecord(this.s.records.find(r=>r.doi===p.doi))||!!this.env.excludedDois?.includes(p.doi);}
  async init() {
    const saved = await this.env.load();
    if (saved) {
      if (saved.schema_version !== 1 || JSON.stringify(saved.sample_dois) !== JSON.stringify(this.s.sample_dois)
          || !Array.isArray(saved.records) || !Array.isArray(saved.history) || !Array.isArray(saved.queue)
          || saved.queue.some(d => !this.s.sample_dois.includes(d)) || new Set(saved.queue).size !== saved.queue.length
          || !Number.isInteger(saved.cursor) || saved.cursor < 0 || saved.cursor > saved.queue.length) {
        throw Error('旧进度格式不匹配，已停止，避免覆盖数据。');
      }
      const done=saved.cursor===saved.queue.length && saved.records.length>0;
      this.s = { ...saved, mode: done?'done':'paused', attempts: 0, reason: done?'采集已完成，正在恢复核对结果。':'已恢复进度；点击开始/继续，不会自动访问网页。' };
    }
    this.s.queue=[...this.s.queue.slice(0,this.s.cursor),...this.s.queue.slice(this.s.cursor).filter(doi=>!this.excluded(this.papers.find(p=>p.doi===doi)))];
    if(this.s.cursor===this.s.queue.length){this.s.mode='done';this.s.reason='本轮已结束；已放弃的 JPE 图片文章不再采集，历史记录保留。';}
    this.owned = await this.env.loadSession();
    if (this.owned && (!Number.isInteger(this.owned.tabId) || !this.s.sample_dois.includes(this.owned.doi))) this.owned = null;
    await this.persist();
  }
  async persist() {
    this.s.updated_at = new Date(this.env.now()).toISOString();
    const copy = structuredClone(this.s);
    this.saveChain = this.saveChain.then(() => this.env.save(copy));
    await this.saveChain;
    this.env.render(this.s);
  }
  async start() {
    if (this.s.mode === 'running') return;
    if (!this.current()) { this.s.mode = 'done'; this.s.reason = '队列已完成，可导出结果或重试未成功项。'; await this.persist(); return; }
    this.epoch++; this.s.mode = 'running'; this.s.attempts = 0; this.nextAt = this.env.now() + 1000;
    this.s.reason = '运行中；只使用助手自己的论文标签页。'; await this.persist();
  }
  async pause(reason = '已暂停。点击继续可从当前论文接着读。') {
    this.epoch++; this.s.mode = 'paused'; this.s.reason = reason; await this.persist();
  }
  async finish(result) {
    const paper = this.current(); if (!paper) return;
    const record = { ...paper, ...result, extracted_at: new Date(this.env.now()).toISOString() };
    const old = this.s.records.findIndex(r => r.doi === paper.doi);
    if (old >= 0) { this.s.history.push(this.s.records[old]); this.s.records[old] = record; }
    else this.s.records.push(record);
    this.s.cursor++; this.s.attempts = 0; this.nextAt = this.env.now() + 10000;
    if (!this.current()) { this.s.mode = 'done'; this.s.reason = '本轮采集完成。原始结果已保存在本地，自动核对进度见下方。'; }
    else this.s.reason = '当前结果已保存，至少等待 10 秒后打开下一篇。';
    await this.persist();
  }
  async skip() {
    if (!this.current()) return;
    this.epoch++; this.s.mode = 'running';
    await this.finish({ status: 'skipped', abstract: null, source_url: null });
  }
  async retry({excludedDois=[],checkedDois=[]}={}) {
    if (this.s.mode === 'running' || this.busy) return;
    this.epoch++;
    const success = new Set([...checkedDois,...excludedDois,...this.s.records.filter(r => r.status === 'candidate_extracted'||abstractRetryComplete(r)).map(r => r.doi)]);
    this.s.queue = this.papers.filter(p => !this.excluded(p)&&!success.has(p.doi)).map(p => p.doi);
    this.s.cursor = 0; this.s.attempts = 0;
    this.s.mode = 'paused'; this.s.reason = `未成功项 ${this.s.queue.length} 篇已重新排队；点击开始。已有成功结果、已确认无摘要和已确认的“其他”条目不会重跑。`;
    await this.persist();
  }
  async recheck() {
    if (this.s.mode === 'running' || this.busy) return;
    this.epoch++; this.s.queue = this.papers.filter(p=>!this.excluded(p)).map(p => p.doi); this.s.cursor = 0; this.s.attempts = 0;
    this.s.mode = 'paused'; this.s.reason = `${this.s.queue.length} 篇已重新排队；已放弃的 JPE 图片文章除外，旧结果保留。点击开始。`; await this.persist();
  }
  async retryJpe(checkedDois=[]){
    if(this.s.mode==='running'||this.busy)return;
    this.s.reason='JPE 图片摘要采集已按要求停用；历史记录保留。';await this.persist();
  }
  async adoptManual(tabId) {
    await this.pause('正在核对你手动打开的论文页……');
    if(this.busy)throw Error('上一轮读取正在结束，请稍后再点。');
    this.busy=true;const epoch=this.epoch;
    try {
      const paper=this.current();if(!paper)throw Error('当前队列已结束。');
      const tab=await this.env.getTab(tabId),url=safeSourceUrl(tab.url);
      if(!url||tab.status==='loading')throw Error('请等待论文页面加载完成。');
      const result=await this.env.inspect(tabId,paper),after=await this.env.getTab(tabId);
      if(epoch!==this.epoch)return;
      if(safeSourceUrl(after.url)!==url || result.source_url!==url || !result.identity?.ok || result.status==='needs_user_verification')
        throw Error('本页不是当前论文、尚未通过验证或读取时发生跳转；未保存。');
      if(result.pending_affiliations)throw Error('已展开作者信息，请稍等再点读取本页。');
      this.owned=null;await this.env.saveSession(null);this.s.mode='running';await this.finish(result);
    }finally{this.busy=false;}
  }
  async tabClosed(id) {
    if (this.owned?.tabId !== id) return;
    this.owned = null; await this.env.saveSession(null);
    if (this.current()) await this.pause('论文标签页已关闭，队列暂停。点击继续会创建新的论文标签页。');
  }
  async tick() {
    if (this.busy || this.s.mode !== 'running' || this.env.now() < this.nextAt) return;
    this.busy = true; const epoch = this.epoch;
    const live = () => epoch === this.epoch && this.s.mode === 'running';
    try {
      const paper = this.current(); if (!paper) return;
      let tab = null;
      if (this.owned) { try { tab = await this.env.getTab(this.owned.tabId); } catch { this.owned = null; } }
      if (!live()) return;
      if (!tab) {
        // Never search for or take over an existing user tab.
        tab = await this.env.createTab(paper.url);
        this.owned = { tabId: tab.id, doi: paper.doi };
        await this.env.saveSession(this.owned);
        if (!live()) return;
        this.nextAt = this.env.now() + 7000; this.s.reason = '论文已打开，等待网页加载……'; await this.persist(); return;
      }
      if (this.owned.doi !== paper.doi) {
        // If the user repurposed the owned tab to another website, leave it alone and create a new one.
        if (!safeSourceUrl(tab.url)) {
          this.owned = null; await this.env.saveSession(null); this.nextAt = this.env.now(); return;
        }
        await this.env.navigate(tab.id, paper.url);
        this.owned = { tabId: tab.id, doi: paper.doi }; await this.env.saveSession(this.owned);
        if (!live()) return;
        this.nextAt = this.env.now() + 7000; this.s.reason = '已打开下一篇，等待网页加载……'; await this.persist(); return;
      }
      if (tab.status === 'loading' && this.s.attempts < 3) {
        this.s.attempts++; this.nextAt = this.env.now() + 10000; await this.persist(); return;
      }
      const url = safeSourceUrl(tab.url);
      if (!url) { await this.pause('当前是登录页、未授权网站或浏览器错误页。请手动处理后点击继续，或跳过当前篇。'); return; }
      const result = await this.env.inspect(tab.id, paper);
      if (!live()) return; // Ignore stale extraction when the user paused/skipped during an async read.
      if(result.panel_cleanup_failed){await this.pause('作者侧栏未能自动关闭，已暂停。请关闭论文页的作者侧栏后继续；不会操作其他弹窗。');return;}
      this.s.attempts++;
      if (['candidate_extracted', 'no_abstract_stated'].includes(result.status) && (!result.pending_affiliations || this.s.attempts>=3)) { await this.finish(result); return; }
      if (['needs_user_verification', 'doi_conflict', 'unsupported_page'].includes(result.status)) {
        await this.pause(result.status === 'needs_user_verification'
          ? '遇到网页验证，已暂停。请在论文标签页手动通过，再点击“继续 / 已通过验证”。'
          : '当前页面身份冲突或不是支持的论文页，已暂停；确认页面后继续，或跳过。'); return;
      }
      if (this.s.attempts >= 3) { await this.finish(result); return; }
      this.nextAt = this.env.now() + 10000;
      this.s.reason = '尚未读到完整摘要，等待动态内容；最多读取 3 轮，不反复刷新网页。'; await this.persist();
    } catch (error) {
      if (live()) await this.pause('页面读取或本地保存失败，已暂停。请确认已授权该网站，然后继续或跳过。').catch(() => {
        this.s.mode = 'paused'; this.s.reason = '本地保存失败，停止运行。请先导出当前结果。'; this.env.render(this.s);
      });
    } finally { this.busy = false; }
  }
}
