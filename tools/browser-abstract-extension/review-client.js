import { validateReviewOutput } from './review-core.js';
import {verdictOutput,expectsAbstract,canonicalEvidence} from './article-review.js';
import {canRetryReview,reviewErrorPolicy,MAX_REVIEW_ATTEMPTS} from './retry-policy.js';
export {canRetryReview} from './retry-policy.js';
export const REVIEW_KEY = 'paper_source_review_v1';
export const REVIEW_PROGRESS_KEY = 'paper_source_review_progress_v1';
// Never persist arbitrary exception text (it may contain request data). Classify
// the failed operation separately; storage exhaustion is not an API/key error.
export function reviewFailure(error, stage) {
  const message=String(error?.message || ''), storage=['load','save','progress'].includes(stage);
  let code='review_internal_error', reason='核对处理未完成，请导出结果以便检查。';
  if(storage){
    if(/quota|QUOTA_BYTES|exceed.*(?:storage|limit)|storage.*exceed/i.test(message)){
      code='storage_quota_exceeded';reason='插件本地存储额度已满。请重新加载 0.10.1 或更新版本并允许扩展存储权限，再点继续待核对；不要卸载或清空数据。';
    }else{
      code=stage==='load'?'storage_read_failed':'storage_write_failed';reason=stage==='load'?'无法读取插件本地记录。请保留数据，重新加载扩展后再试。':'浏览器未能保存核对结果或进度。请检查磁盘空间和扩展权限，再点继续待核对；不要清空数据。';
    }
  }else if(stage==='request'){
    const http=message.match(/^BRIDGE_HTTP_(\d+)$/);
    code=http?message:'review_request_failed';
    reason=http?.[1]==='429'?'本地核对服务达到本次运行的调用上限，已暂停；这不是浏览器存储错误。请保留结果，确认额度安排后再继续。':
      http?.[1]==='409'?'本地核对服务正忙或已有请求待处理。请等待当前请求结束后再点继续，不要反复点击。':
      http?.[1]==='403'?'本地服务拒绝扩展身份，请检查扩展 ID 和服务配置；不代表 DeepSeek Key 错误。':
      http?`本地核对接口返回 HTTP ${http[1]}，已暂停；请保留结果并检查本地服务。`:
      '核对请求未完成或响应格式无法读取。请检查本地服务连接，稍后点继续待核对。';
  }else if(['validate','plan','summary'].includes(stage)){
    code='review_validation_failed';reason='核对结果未通过本地原文校验，已暂停。原始证据保留，请导出结果检查；不要重采或清空缓存。';
  }
  return {phase:'paused',code,failure_stage:stage,reason:`核对暂停：${reason} 已保存的结果保留；继续时相同请求优先读取服务端缓存，不自动重发付费重试。`};
}
export async function bridgeHealth(fetchImpl = fetch) {
  try {
    // Real extension GET requests may omit Origin. POST carries the browser's
    // extension origin, preserving strict server authentication (no GET bypass).
    const r = await fetchImpl('http://127.0.0.1:17327/health', { method:'POST', headers: { 'X-Paper-Review': '1', 'Content-Type':'application/json' }, body:'{}', signal: AbortSignal.timeout(3000) });
    if (r.status === 403) return {ok:false,code:'bridge_identity_rejected',reason:'本地服务身份校验未通过，可能是插件/服务版本不一致或来源不匹配。不代表 Key 错误；请先核对版本和扩展 ID，不要重复配置密钥。'};
    const data = await r.json();
    return r.ok && data.status === 'ready' ? {ok:true,code:'ready',reason:'本地服务已连接。'} : {ok:false,code:'service_error',reason:'本地服务返回异常，请查看服务窗口。'};
  } catch { return {ok:false,code:'service_unreachable',reason:'未连接本地服务。请双击 start-review.cmd；Key 已保存，无需重输。面板会每15秒免费检查连接，连接恢复后自动继续。'}; }
}
export async function reviewFingerprint(input) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function prepareReviewPlan(plan, results = {}) {
  const jobs = [];
  for (const job of plan.jobs) {
    let input=job.input, hash=await reviewFingerprint(input);
    if(!results[hash] && job.legacy_input){
      const oldHash=await reviewFingerprint(job.legacy_input), old=results[oldHash];
      if(old && !old.error && old.verdict?.status==='source_checked_candidate' && canonicalEvidence(old.input)===canonicalEvidence(job.legacy_input)){
        const checked=validateReviewOutput(job.legacy_input,verdictOutput(job.legacy_input,old.verdict));
        if(checked.status==='source_checked_candidate' && (!expectsAbstract(job.legacy_input)||checked.fields.abstract)){
          input=job.legacy_input;hash=oldHash;
        }
      }
    }
    jobs.push({...job,input,hash});
  }
  return { ...plan, jobs: [...new Map(jobs.map(j => [j.hash, j])).values()] };
}
export function checkedResponse(input, value) {
  let verdict;
  if (value.verdict) {
    verdict = validateReviewOutput(input, verdictOutput(input,value.verdict));
  }
  return { input, verdict, error: value.error || (!verdict ? 'INVALID_RESPONSE' : null), cached: !!value.cached,
    validation_diagnostics:value.verdict?.states, usage: value.usage, checked_at: value.checked_at, fingerprint: value.fingerprint,
    attempt:value.attempt || 1, max_attempts:value.max_attempts || MAX_REVIEW_ATTEMPTS,
    attempt_history:value.attempt_history || [], elapsed_ms:value.elapsed_ms,
    ...reviewErrorPolicy(value.error) };
}
export function articleReviewCounts(plan,results){
  const jobs=plan.jobs.filter(j=>j.input.kind==='article');
  let saved=0,unresolved=0,noEvidence=0;
  for(const j of jobs){
    const r=results[j.hash];
    const checked=r?.verdict?validateReviewOutput(j.input,verdictOutput(j.input,r.verdict)):null;
    if(checked?.fields.abstract)saved++;
    else if(expectsAbstract(j.input))unresolved++;
    else noEvidence++;
  }
  return {abstracts_saved:saved,abstract_evidence_unresolved:unresolved,without_text_abstract_evidence:noEvidence};
}
export class ReviewRunner {
  constructor(env) { this.env = env; this.running = false; this.stopping = false; this.state = {}; }
  async report(state) {
    this.state = {...state,updated_at:new Date().toISOString()};
    const prior=this.stage;this.stage='progress';await this.env.progress?.(this.state);this.stage=prior;
    this.env.report(this.state);
  }
  stop() { this.stopping = true; }
  async run(rawPlan) {
    if (this.running) return;
    this.running = true; this.stopping = false; this.stage='lock';
    try {
      return await this.env.lock(async acquired => {
        if (!acquired) { await this.report({ phase: 'paused', code:'other_panel', reason: '另一个面板正在核对，请稍后继续。' }); return; }
        this.stage='load'; const results = await this.env.load();
        this.stage='plan'; const plan = await prepareReviewPlan(rawPlan,results);
        const pending = plan.jobs.filter(j => !results[j.hash]); let completed = plan.jobs.length - pending.length;
        const health = pending.length || plan.jobs.some(j=>canRetryReview(results[j.hash])) ? await this.env.health() : true;
        if (this.stopping) { await this.report({phase:'paused',code:'user_paused',completed,total:plan.jobs.length,reason:'核对已暂停；点击继续待核对恢复。'}); return; }
        if (health === false || health?.ok === false) {
          await this.report({ phase: 'waiting_service', code:health?.code || 'service_unreachable', completed, total:plan.jobs.length, reason: health?.reason || '采集结果已保存，等待本地服务连接；无需重新采集或重新输入 Key。' }); return;
        }
        const reviewOne = async (job, retry = false) => {
          this.stage='request';
          const value = await this.env.request(job.input, retry ? {retryAttempt:Number(results[job.hash]?.attempt || 1)} : {});
          this.stage='validate';
          results[job.hash] = checkedResponse(job.input, value);
          this.stage='save';
          await this.env.save(results);
          if (reviewErrorPolicy(results[job.hash].error).global_failure) {
            await this.report({phase:'paused',code:results[job.hash].error,completed,total:plan.jobs.length,
              reason:`核对暂停：${results[job.hash].error}。这是账号、额度或服务级错误；不继续消耗其他条目。`}); return false;
          }
          return true;
        };
        for (const job of pending) {
          if (this.stopping) break;
          await this.report({ phase: 'running', completed, total: plan.jobs.length, reason: `自动核对 ${completed + 1}/${plan.jobs.length}：${job.input.identity.title}` });
          if (!await reviewOne(job)) return;
          completed++;
        }
        // Finish other records first. Two bounded retry rounds; server caches
        // and enforces a lifetime total of three attempts for identical evidence.
        for (let round=1; round<MAX_REVIEW_ATTEMPTS && !this.stopping; round++) {
          const retryJobs=plan.jobs.filter(j=>canRetryReview(results[j.hash]));
          if (!retryJobs.length) break;
          if (this.env.wait) await this.env.wait(round*1500);
          for (const job of retryJobs) {
            if (this.stopping) break;
            await this.report({phase:'running',completed,total:plan.jobs.length,
              reason:`重试 ${Number(results[job.hash].attempt || 1)+1}/${MAX_REVIEW_ATTEMPTS}：${job.input.identity.title}（${results[job.hash].error}）`});
            if (!await reviewOne(job,true)) return;
          }
        }
        this.stage='summary';
        const failed = plan.jobs.filter(j => results[j.hash]?.error).length, counts=articleReviewCounts(plan,results);
        await this.report({ phase: this.stopping ? 'paused' : failed ? 'done_with_errors' : 'done', code:this.stopping ? 'user_paused' : null, completed, total: plan.jobs.length,
          reason: this.stopping ? '已暂停自动核对；当前已发出的请求已保存，不再发起下一条。' :
            `核对结束：已记录 ${completed}/${plan.jobs.length} 条，其中失败 ${failed} 条（每份证据最多3次，不会因刷新重置）；${plan.skipped.length} 条因缺少完整证据等原因暂未核对。` +
            (plan.jobs.some(j=>j.input.kind==='article')?`摘要已保存 ${counts.abstracts_saved} 条；有文本证据待处理 ${counts.abstract_evidence_unresolved} 条；未捕获可用文字摘要 ${counts.without_text_abstract_evidence} 条。`:'') + '结果仅保存在本机。' });
      });
    } catch (error) {
      const state = {...reviewFailure(error,this.stage),completed:this.state.completed,total:this.state.total};
      try { const d=await this.env.storageDiagnostics?.();if(d)state.storage_diagnostics=d; } catch { /* Diagnostics must not block pause/export. */ }
      this.state = state; try { await this.report(state); } catch { this.env.report(state); } }
    finally { this.running = false; this.env.settled?.(); }
  }
}
export function browserReviewEnvironment(report, settled, scope = 'all') {
  return {
    report, settled,
    lock: callback => navigator.locks.request('paper-source-review', { ifAvailable: true }, lock => callback(!!lock)),
    load: async () => (await chrome.storage.local.get(REVIEW_KEY))[REVIEW_KEY] || {},
    save: results => chrome.storage.local.set({ [REVIEW_KEY]: results }),
    storageDiagnostics: async () => ({
      bytes_in_use:await chrome.storage.local.getBytesInUse(null),
      default_quota_bytes:chrome.storage.local.QUOTA_BYTES,
      unlimited_storage:await chrome.permissions.contains({permissions:['unlimitedStorage']}),
      extension_version:chrome.runtime.getManifest().version
    }),
    health: bridgeHealth,
    wait: ms => new Promise(resolve=>setTimeout(resolve,ms)),
    progress: value => chrome.storage.local.set({ [REVIEW_PROGRESS_KEY + '_' + scope]: value }),
    request: async (input, options = {}) => {
      const response = await fetch('http://127.0.0.1:17327/review', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Paper-Review': '1',
        ...(options.retryAttempt ? {'X-Paper-Retry':String(options.retryAttempt)} : {}) },
        body: JSON.stringify(input), signal: AbortSignal.timeout(70000) });
      if (!response.ok) throw Error('BRIDGE_HTTP_' + response.status); return response.json();
    }
  };
}
export function mountAutoReview(getPlan, scope = 'all', onSaved = () => {}) {
  const status = document.getElementById('ai-status'), run = document.getElementById('ai-run'), stop = document.getElementById('ai-stop');
  let attempted = false, active = true, nextHealthAt = 0, ready = false;
  const runner = new ReviewRunner(browserReviewEnvironment(s => { status.textContent = s.reason; run.disabled = s.phase === 'running'; stop.disabled = !['running','waiting_service'].includes(s.phase); },
    () => { run.disabled = false; stop.disabled = runner.state.phase !== 'waiting_service'; void Promise.resolve(onSaved()).catch(() => { status.textContent += '（界面更新失败，请刷新查看已保存结果）'; }); }, scope));
  const begin = () => { if (!active) return; attempted = true; run.disabled = true; return runner.run(getPlan()); };
  void chrome.storage.local.get(REVIEW_PROGRESS_KEY + '_' + scope).then(stored => {
    const prior = stored[REVIEW_PROGRESS_KEY + '_' + scope];
    if (prior?.phase === 'paused' || prior?.phase === 'done_with_errors') {
      attempted = true; runner.state = prior; status.textContent = prior.reason || '核对已暂停；点继续待核对恢复。';
    }
    ready = true;
  }).catch(() => { attempted = true; ready = true; status.textContent = '读取上次核对状态失败，请先导出结果。'; });
  const pause = () => {
    attempted = true; runner.stop();
    if (!runner.running) void runner.report({phase:'paused',code:'user_paused',reason:'自动核对已暂停；点击继续待核对恢复。'}).catch(() => { status.textContent = '暂停状态保存失败，请先导出结果。'; });
  };
  run.addEventListener('click', () => { void begin(); }); stop.addEventListener('click', pause);
  return {
    isRunning:()=>runner.running,
    getState:()=>runner.state,
    tick: mode => {
      if (!ready || !active || mode !== 'done' || runner.running) return;
      if (!attempted || (runner.state.phase === 'waiting_service' && runner.state.code === 'service_unreachable' && Date.now() >= nextHealthAt)) {
        nextHealthAt = Date.now() + 15000; void begin();
      }
    },
    reset: () => { attempted = false; }, stop: pause,
    close: () => { active = false; runner.stop(); },
    export: async () => {
      const stored = await browserReviewEnvironment().load(), plan = await prepareReviewPlan(getPlan(),stored);
      const results = Object.fromEntries(plan.jobs.filter(j => stored[j.hash]).map(j => [j.hash, stored[j.hash]]));
      const success = Object.values(results).filter(r => !r.error && r.verdict?.status === 'source_checked_candidate').length;
      return { ai_review_progress: runner.state, ai_review_summary:{total:plan.jobs.length,checked:success,failed:Object.keys(results).length-success,pending:plan.jobs.length-Object.keys(results).length,skipped:plan.skipped.length,...articleReviewCounts(plan,results)},
        ai_review_results: results, ai_review_links: plan.jobs.map(j => ({ job_id: j.id, hash: j.hash, status: stored[j.hash]?.error || stored[j.hash]?.verdict?.status || 'pending' })),
        ai_review_skipped: plan.skipped, ai_calls: null, ai_call_count_note: '精确调用次数见本地服务 calls.jsonl；缓存命中和网络中断不能按结果条数当作新调用。' };
    }
  };
}
