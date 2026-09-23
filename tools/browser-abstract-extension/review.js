import { makeReviewJobs } from './review-core.js';
import { CATALOG_STATE } from './catalog-core.js';
import { STATE_KEY } from './engine.js';
import {DETAIL_STATE_KEY} from './detail-queue.js';
import { REVIEW_KEY, ReviewRunner, prepareReviewPlan, browserReviewEnvironment, canRetryReview } from './review-client.js';
const $ = id => document.getElementById(id);
let plan = { jobs: [], skipped: [] }, results = {};
$('extension-id').textContent = chrome.runtime.id;
function render() {
  const completed = plan.jobs.filter(j => results[j.hash]);
  $('counts').textContent = `可核对 ${plan.jobs.length} 条；已记录 ${completed.length} 条；需重采或超出容量 ${plan.skipped.length} 条。`;
  $('run').disabled = runner.running || !plan.jobs.some(j => !results[j.hash] || canRetryReview(results[j.hash])); $('load').disabled = runner.running;
  $('stop').disabled = !runner.running; $('export').disabled = !Object.keys(results).length;
  $('results').replaceChildren(...Object.values(results).map(r => {
    const card = document.createElement('article'), title = document.createElement('h3'), detail = document.createElement('pre');
    title.textContent = r.input.identity.title; detail.textContent = JSON.stringify({ error:r.error || null, attempt:r.attempt || 1, max_attempts:r.max_attempts || 3, attempt_history:r.attempt_history || [], verdict:r.verdict }, null, 2);
    card.append(title, detail); return card;
  }));
}
async function load() {
  const stored = await chrome.storage.local.get([CATALOG_STATE, STATE_KEY, DETAIL_STATE_KEY, REVIEW_KEY]);
  const primary=makeReviewJobs(stored[CATALOG_STATE],stored[STATE_KEY]),details=makeReviewJobs(null,stored[DETAIL_STATE_KEY]);
  results = stored[REVIEW_KEY] || {}; plan = await prepareReviewPlan({jobs:[...primary.jobs,...details.jobs],skipped:[...primary.skipped,...details.skipped]},results); render();
}
const env = browserReviewEnvironment(s => { $('status').textContent = s.reason; render(); }, () => { void load(); });
const runner = new ReviewRunner(env);
$('load').addEventListener('click', () => { void load().catch(() => { $('status').textContent = '读取本地结果失败，未覆盖数据。'; }); });
$('connection').addEventListener('click', async () => {
  const health = await env.health(); $('connection-status').textContent = health.reason + (health.ok ? '密钥是否有效会在首次真实核对时确认。' : '');
});
$('stop').addEventListener('click', () => { runner.stop(); $('status').textContent = '当前请求完成后暂停。'; });
$('run').addEventListener('click', async () => {
  try { await load(); await runner.run(plan); } catch { $('status').textContent = '核对未开始；请检查本地状态。'; }
});
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ kind: 'paper_source_review', schema_version: 1, results, skipped: plan.skipped,
    production_writes: 0, exported_at: new Date().toISOString() }, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `paper-source-review-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});
chrome.storage.onChanged?.addListener((changes, area) => { if (area === 'local' && changes[REVIEW_KEY] && !runner.running) void load(); });
window.addEventListener('pagehide', () => runner.stop(), { once: true });
load().then(() => { $('status').textContent = '采集面板会在采集结束后自动核对。这里可查看结果或继续上次未完成的核对。'; })
  .catch(() => { $('status').textContent = '本地读取失败；请先导出已有结果。'; });
