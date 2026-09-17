import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { DEFAULT_LIBRARY_ROOT, readJournalLibrary } from '../src/services/journalLibrary.js';
import { assertLibrary } from '../src/services/libraryValidation.js';
import { loadSearchPolicy } from '../src/services/searchPolicy.js';
import { runJournalPipeline } from '../src/services/journalPipeline.js';
import { makeEvidenceHttp, EvidenceError } from '../src/services/evidenceHttp.js';
import { makeEnrichmentSources } from '../src/services/enrichmentSources.js';
import { makeSearchSources } from '../src/services/searchSources.js';
import { makeSearchBudgetGitHub } from '../src/services/searchBudgetGitHub.js';
import { makeBudgetedSearch, searchAllowance } from '../src/services/searchBudget.js';
import { clonePilotLibrary } from './search-pilot.js';
import { savePipelineCheckpoint, restorePipelineCheckpoint, checkpointOutput } from './pipeline-checkpoint.js';

export function parsePipelineArgs(args) {
  const { values: v } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, plan: { type: 'boolean' }, run: { type: 'boolean' }, save: { type: 'boolean' },
    isolate: { type: 'boolean' }, all: { type: 'boolean' }, journal: { type: 'string' },
    'max-papers': { type: 'string' }, 'max-pages': { type: 'string' }, 'max-abstracts': { type: 'string' },
    checkpoint: { type: 'boolean' }, 'resume-from': { type: 'string' }, 'source-repository': { type: 'string' }
  } });
  if (!Object.keys(v).length || v.help) return { mode: 'help' };
  assertLibrary(Boolean(v.plan) !== Boolean(v.run), '请选择只读plan或明确run');
  assertLibrary(Boolean(v.all) !== Boolean(v.journal), '必须指定all或journal');
  assertLibrary(!v.plan || (!v.save && !v.isolate), '只读plan不能请求保存或复制');
  assertLibrary(!v.run || Boolean(v.save) !== Boolean(v.isolate), '运行必须选择save正式库或isolate副本');
  assertLibrary(!(v.checkpoint || v['resume-from']) || (v.run && v.isolate), '存档和续跑仅允许隔离模式');
  if (v['source-repository'] !== undefined) assertLibrary(v.run && v.isolate && v['source-repository'].trim() &&
    !/[\r\n\0]/.test(v['source-repository']), '外部数据基线仅允许隔离运行，路径不能为空');
  const maxPapers = Number(v['max-papers'] ?? 100), maxPages = Number(v['max-pages'] ?? 1000);
  const maxAbstracts = Number(v['max-abstracts'] ?? 300);
  assertLibrary(Number.isInteger(maxAbstracts) && maxAbstracts >= 0 && maxAbstracts <= 1000, '摘要批次上限无效');
  assertLibrary(Number.isInteger(maxPapers) && maxPapers >= 0 && maxPapers <= 1000 && Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 1000, '批量或页数上限无效');
  return { mode: v.plan ? 'plan' : 'run', isolate: Boolean(v.isolate), journalKey: v.journal, maxPapers, maxAbstracts, maxPages,
    checkpoint: Boolean(v.checkpoint), resumeFrom: v['resume-from'], sourceRepository: v['source-repository'] };
}

/** No production secrets are accessed before the command/mode/library gates. */
export async function makePipelineRuntime({ env, policy }) {
  const providers = makeSearchSources({ zhipuKey: env.ZHIPU_API_KEY || '', serpapiKey: env.SERPAPI_API_KEY || '', zhipuEngine: policy.zhipu_engine });
  const ledger = makeSearchBudgetGitHub({ token: env.GITHUB_TOKEN, repositoryName: env.GITHUB_REPOSITORY });
  const budget = makeBudgetedSearch({ initialState: await ledger.read({ initialize: true }), persist: s => ledger.persist(s), request: o => providers.request(o) });
  const counts = { zhipu: 0, serpapi: 0 }, skipped = {}; let account = null, tail = Promise.resolve();
  const deadline = Date.now() + 45 * 60 * 1000;
  const search = options => {
    const task = tail.then(async () => {
      if (Date.now() >= deadline) return { called: false, reason: 'run_deadline' };
      const serp = options.provider.startsWith('serpapi_');
      if (serp && (!account || Date.now() - Date.parse(account.checked_at) >= 50000)) { try { account = await providers.account(); } catch { skipped.account_unverified = (skipped.account_unverified || 0) + 1; return { called: false, reason: 'account_unverified' }; } }
      const result = await budget.run({ ...options, zhipuMonthlyLimit: policy.zhipu_monthly_limit, ...(serp ? { account } : {}) });
      if (result.called) counts[serp ? 'serpapi' : 'zhipu']++;
      else skipped[result.reason] = (skipped[result.reason] || 0) + 1;
      return result;
    }); tail = task.catch(() => {}); return task;
  };
  const publicHttp = makeEvidenceHttp({ timeoutMs: 12000, maxRequests: 1200 });
  const http = { request: (...args) => { if (Date.now() >= deadline) throw new EvidenceError('REQUEST_LIMIT'); return publicHttp.request(...args); } };
  const sources = makeEnrichmentSources(http, { semanticScholarKey: env.SEMANTIC_SCHOLAR_API_KEY || '' });
  sources.searchExtract = async extraction => {
    const result = await search({ provider: 'zhipu', query: `extract:${extraction.paper.doi}:${extraction.evidence.map(row => row.url).join('|')}`.slice(0, 2000),
      taskId: `extract:${extraction.paper.doi}`, extraction });
    return result.result?.extracted || null;
  };
  sources.searchArticle = async (paper, journal) => {
    const article = { title: paper.title_original, doi: paper.doi, journal: journal.name };
    return search({ provider: 'zhipu', query: `article:${JSON.stringify(article)}`.slice(0, 2000),
      taskId: `article:${paper.id}`, article });
  };
  return { http, search, sources,
    collectionOptions: { semanticScholarKey: env.SEMANTIC_SCHOLAR_API_KEY || '', maxAttempts: 2, timeoutMs: 12000 },
    quotaResetsAt: () => {
      const value = account?.renewal_date, reset = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? Date.parse(`${value}T00:00:00Z`) + 86400000 : Date.parse(value);
      assertLibrary(Number.isFinite(reset) && reset > Date.now(), '缺少真实免费额度重置时间'); return new Date(reset).toISOString();
    }, summary: () => ({ search_calls: counts, search_skipped: skipped,
      zhipu_used: searchAllowance(budget.state(), { provider: 'zhipu', zhipuMonthlyLimit: policy.zhipu_monthly_limit }).local_used,
      serpapi_used: searchAllowance(budget.state(), { provider: 'serpapi_google', account }).local_used,
      monthly_limits: { zhipu: policy.zhipu_monthly_limit, serpapi: policy.serpapi_monthly_limit } }) };
}

export async function pipelineCommand(args, { root = DEFAULT_LIBRARY_ROOT, env = process.env, log = console.log,
  loadPolicy = loadSearchPolicy, loadConfig = loadJournalConfig, readLibrary = readJournalLibrary,
  runtime = makePipelineRuntime, execute = runJournalPipeline, clone = clonePilotLibrary,
  saveCheckpoint = savePipelineCheckpoint, restoreCheckpoint = restorePipelineCheckpoint, outputCheckpoint = checkpointOutput } = {}) {
  const options = parsePipelineArgs(args);
  if (options.mode === 'help') { log('只读：--plan --all；隔离运行：--run --isolate --all；可加--source-repository <数据基线仓库目录>使用最新生产数据副本，--checkpoint导出存档，--resume-from <存档目录>续跑；正式运行：--run --save --all（需配置与GitHub开关同时开启）。可用--journal AER；本命令不翻译、不提交Git、不发布网站。'); return { status: 'help' }; }
  // Reviewed code and the current production data may come from different commits.
  // The alternate baseline is read and cloned only; save mode cannot select it.
  if (options.sourceRepository) root = path.resolve(options.sourceRepository, 'data', 'journal-store');
  const config = await loadConfig(), policy = await loadPolicy();
  if (options.journalKey) assertLibrary(findJournal(config, options.journalKey)?.enabled, '期刊无效');
  const before = await readLibrary({ root, config });
  if (options.mode === 'plan') { const plan = { status: 'plan', production_enabled: policy.production_enabled, papers: before.papers.length,
    journal: options.journalKey || 'all', lookback_days: 60, max_papers: options.maxPapers, max_abstracts: options.maxAbstracts,
    phases: ['three_source_discovery', 'official_catalog_search', 'saved_duplicate_resolution', 'metadata_repair', 'duplicate_resolution', 'translation_queue'],
    monthly_limits: { zhipu: policy.zhipu_monthly_limit, serpapi: policy.serpapi_monthly_limit } }; log(JSON.stringify(plan)); return plan; }
  if (!options.isolate && (!policy.production_enabled || env.JOURNAL_SEARCH_ENABLED !== 'true')) {
    log('PIPELINE_DISABLED：新生产流程未获启用，不读取密钥、不联网、不写库。'); return { status: 'disabled' };
  }
  assertLibrary(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'w1121188104w-hue/paper-daily' &&
    (options.isolate ? env.GITHUB_EVENT_NAME === 'workflow_dispatch' : ['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) &&
      env.DATA_BRANCH && env.GITHUB_REF === `refs/heads/${env.DATA_BRANCH}`), '仅允许受控GitHub运行，正式模式必须为默认分支');
  if (options.checkpoint) assertLibrary(env.GITHUB_OUTPUT && env.RUNNER_TEMP, '存档需要受控Runner输出与临时目录');
  let copy, resumed, executionStarted = false;
  if (options.isolate) copy = await clone(config, { repositoryRoot: path.resolve(root, '../..'), tempParent: env.RUNNER_TEMP || os.tmpdir() });
  try {
    // Keep the formal library guard even when continuing from an earlier artifact.
    if (options.resumeFrom) resumed = await restoreCheckpoint(config, { directory: options.resumeFrom, tempParent: env.RUNNER_TEMP || os.tmpdir() });
    const services = await runtime({ env, policy });
    executionStarted = true;
    const report = await execute(config, { ...services, root: resumed?.root || copy?.root || root, journalKey: options.journalKey,
      maxPapers: options.maxPapers, maxAbstracts: options.maxAbstracts, maxPages: options.maxPages, onProgress: row => log(`PIPELINE_PROGRESS ${JSON.stringify(row)}`) });
    const result = { ...report, ...services.summary(), isolated: options.isolate,
      baseline_papers: before.papers.length, baseline_snapshot_sha256: before.pointer?.manifest?.sha256 || null };
    if (copy) result.original_unchanged = await copy.verifyOriginal();
    log(`PIPELINE_REPORT ${JSON.stringify(result)}`); return result;
  } finally {
    if (copy) await copy.verifyOriginal();
    if (resumed) await resumed.verifyOriginal();
    if (options.checkpoint && copy && executionStarted) {
      const checkpoint = await saveCheckpoint(config, { root: resumed?.root || copy.root, tempParent: env.RUNNER_TEMP,
        secrets: [env.ZHIPU_API_KEY, env.SERPAPI_API_KEY, env.SEMANTIC_SCHOLAR_API_KEY, env.GITHUB_TOKEN] });
      await outputCheckpoint(env.GITHUB_OUTPUT, checkpoint);
      log(`PIPELINE_CHECKPOINT ${JSON.stringify({ files: checkpoint.files, versions: checkpoint.versions })}`);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const result = await pipelineCommand(process.argv.slice(2)); process.exitCode = result.status === 'partial' ? 1 : 0; }
  catch (error) { console.error(`PIPELINE_FAILED ${/^[A-Z_]{3,50}$/.test(error.code || '') ? error.code : 'CHECK_FAILED'}；未输出密钥或远程响应。`); process.exitCode = 1; }
}
