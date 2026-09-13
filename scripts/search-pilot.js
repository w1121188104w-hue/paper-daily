import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadJournalConfig } from '../src/services/journals.js';
import { assertLibrary } from '../src/services/libraryValidation.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { journalGitFiles, DEFAULT_REPOSITORY_ROOT } from '../src/services/journalGitFiles.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { runCatalogDiscovery } from '../src/services/catalogDiscoveryRun.js';
import { runMetadataRepair } from '../src/services/metadataRepairRun.js';
import { discoverOfficialPapers } from '../src/services/publisherDiscovery.js';
import { readSearchCatalog } from '../src/services/searchCatalog.js';
import { makeEvidenceHttp, EvidenceError } from '../src/services/evidenceHttp.js';
import { makeEnrichmentSources } from '../src/services/enrichmentSources.js';
import { loadSearchPolicy } from '../src/services/searchPolicy.js';
import { makeSearchSources } from '../src/services/searchSources.js';
import { makeSearchBudgetGitHub } from '../src/services/searchBudgetGitHub.js';
import { makeBudgetedSearch, searchAllowance } from '../src/services/searchBudget.js';
import { translationEligibility } from '../src/services/translationQueue.js';
import { repairSummary } from '../src/services/repairState.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
export const PILOT_LIMITS = Object.freeze({ journal: 'AER', lookback_days: 60, metadata_papers: 3, zhipu: 6, serpapi: 4 });

/** Copy only the validated, referenced history. Never copy locks, attempts or keys.
 * All later writers receive this freshly created root, not the source directory. */
export async function clonePilotLibrary(config, { repositoryRoot = DEFAULT_REPOSITORY_ROOT, tempParent = os.tmpdir() } = {}) {
  const repository = await fs.realpath(repositoryRoot), parent = await fs.realpath(tempParent);
  assertLibrary(parent !== repository && !inside(repository, parent), '试跑临时目录必须在原仓库外');
  const sourceRoot = path.join(repository, 'data', 'journal-store');
  const plan = await journalGitFiles(config, { root: sourceRoot, repositoryRoot: repository });
  const directory = await fs.mkdtemp(path.join(parent, 'paper-search-pilot-'));
  const root = path.join(directory, 'data', 'journal-store'), originals = [];
  for (const relative of plan.files) {
    const source = await fs.realpath(path.join(repository, relative)), target = path.resolve(directory, relative);
    assertLibrary(inside(sourceRoot, source) && inside(root, target), '试跑复制路径越界');
    const bytes = await fs.readFile(source); originals.push({ source, hash: digest(bytes) });
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx' });
  }
  const verifyOriginal = async () => {
    for (const original of originals) assertLibrary(digest(await fs.readFile(original.source)) === original.hash, '试跑期间原库发生变化');
    assertLibrary(await fs.readFile(path.join(sourceRoot, 'current.json'), 'utf8') === plan.pointerText, '原库正式版本已变化');
    return true;
  };
  await verifyOriginal(); await readJournalLibrary({ root, config });
  return { root, directory, verifyOriginal };
}

/** A per-pilot cap IN ADDITION TO the durable monthly ledger, shared by both phases.
 * Failed/unknown requests still consume the pilot allowance; no silent retry/reset. */
export function pilotSearch({ budget, sources, policy, deadline = Infinity, now = Date.now }) {
  const counts = { zhipu: 0, serpapi: 0 }, blocked = { pilot_request_limit: 0, account_unverified: 0 };
  let lastAccount = null, tail = Promise.resolve();
  const run = options => {
    const pending = tail.then(async () => {
      const group = options.provider === 'zhipu' ? 'zhipu' : 'serpapi';
      if (counts[group] >= PILOT_LIMITS[group] || now() >= deadline) {
        blocked.pilot_request_limit++; return { called: false, reason: 'pilot_request_limit' };
      }
      if (group === 'serpapi') {
        try { lastAccount = await sources.account(); }
        catch { blocked.account_unverified++; return { called: false, reason: 'account_unverified' }; }
      }
      const result = await budget.run({ ...options, zhipuMonthlyLimit: policy.zhipu_monthly_limit,
        ...(group === 'serpapi' ? { account: lastAccount } : {}) });
      if (result.called) counts[group]++;
      return result;
    });
    tail = pending.catch(() => {}); return pending;
  };
  return { run, counts: () => ({ ...counts }), blocked: () => ({ ...blocked }), account: () => lastAccount,
    quotaResetsAt: () => {
      const value = lastAccount?.renewal_date;
      // A date-only account reset has unknown time-of-day. Retry after that UTC
      // day finishes, never at an invented earlier billing-cycle boundary.
      const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? Date.parse(`${value}T00:00:00Z`) + 86400000 : Date.parse(value);
      assertLibrary(Number.isFinite(timestamp) && timestamp > now(), '未获得可靠的免费额度重置日期');
      return new Date(timestamp).toISOString();
    } };
}

/** No translation client/key is accepted here: only the existing queue is inspected. */
export async function runIsolatedPilot(config, { repositoryRoot, tempParent, http, sources, search, quotaResetsAt,
  collect = runJournalCollection, catalog = runCatalogDiscovery, repair = runMetadataRepair, onStage = () => {} } = {}) {
  const copy = await clonePilotLibrary(config, { repositoryRoot, tempParent });
  const before = await readJournalLibrary({ root: copy.root, config });
  const common = { root: copy.root, journalKey: PILOT_LIMITS.journal };
  try {
    onStage({ phase: 'three_source_collection_start' });
    const collected = await collect(config, { ...common, withSemanticScholar: true, lookbackDays: 60,
      maxPages: 3, maxAttempts: 2, timeoutMs: 12000, onProgress: row => onStage({ phase: 'collection_source_done', ...row }) });
    onStage({ phase: 'official_catalog_search_start' });
    const catalogs = await catalog(config, { ...common, http, search,
      discover: (journal, window, options) => discoverOfficialPapers(journal, window, { ...options, maxPages: 3, maxArticles: 8 }),
      readCatalog: (journal, window, seeds, options) => readSearchCatalog(journal, window, seeds, { ...options, maxPages: 3, maxArticles: 8 }),
      onProgress: onStage });
    onStage({ phase: 'missing_metadata_repair_start' });
    const repaired = await repair(config, { ...common, sources, search, quotaResetsAt, maxPapers: PILOT_LIMITS.metadata_papers, onProgress: onStage });
    const after = await readJournalLibrary({ root: copy.root, config });
    const eligible = translationEligibility(after.papers), allTasks = [...eligible.ready.tasks, ...eligible.held.tasks];
    const oldById = new Map(before.papers.map(p => [p.id, p]));
    const newAbstracts = after.papers.filter(p => p.abstract_original && !oldById.get(p.id)?.abstract_original);
    for (const paper of newAbstracts) assertLibrary(allTasks.some(t => t.paper_id === paper.id && t.field === 'abstract'), '新摘要未进入翻译队列');
    assertLibrary(allTasks.every(task => task.field !== 'abstract' || after.papers.find(p => p.id === task.paper_id)?.abstract_original), '缺英文摘要却产生了摘要翻译任务');
    const journalIds = new Set(after.papers.filter(p => p.journal_key === PILOT_LIMITS.journal).map(p => p.id));
    const unresolved = repairSummary({ issues: Object.fromEntries(Object.entries(after.repairState.issues).filter(([, issue]) => journalIds.has(issue.paper_id))) });
    return { mode: 'isolated_pilot', limits: PILOT_LIMITS, coverage: 'not_proven_complete', production_unchanged: await copy.verifyOriginal(),
      website_deployed: false, translation_calls: 0, library_before: before.papers.length, library_after: after.papers.length,
      collection: { status: collected.status, discovery: collected.discovery_summary || null, stats: collected.stats || null,
        sources: collected.run?.sources || [] },
      catalog: { status: catalogs.status, stats: catalogs.stats || null, queries: catalogs.report?.search_queries || [],
        journals: (catalogs.report?.journals || []).map(j => ({ journal: j.journal_key, observed: j.official_observed_count,
          existing: j.matched_count, added: j.added_count, pending: j.pending_count,
          attempt_statuses: Object.fromEntries([...new Set(j.attempts.map(a => a.status))].map(s => [s, j.attempts.filter(a => a.status === s).length])) })) },
      metadata: { status: repaired.status, stats: repaired.stats || null, repairs: repaired.report?.repairs || [] },
      selected_journal_master: after.masterList.journals.find(j => j.journal === PILOT_LIMITS.journal),
      selected_journal_unresolved: unresolved,
      new_english_abstracts: newAbstracts.length, new_abstracts_queued: newAbstracts.filter(p => allTasks.some(t => t.paper_id === p.id && t.field === 'abstract')).length,
      selected_journal_translation_ready: eligible.ready.tasks.filter(t => journalIds.has(t.paper_id)).length };
  } finally { await copy.verifyOriginal(); }
}

export async function searchPilot({ env = process.env, log = console.log } = {}) {
  assertLibrary(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'w1121188104w-hue/paper-daily' &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch', '联合试跑只能在明确手动触发的GitHub任务执行');
  const config = await loadJournalConfig(), policy = await loadSearchPolicy();
  const searchSources = makeSearchSources({ zhipuKey: env.ZHIPU_API_KEY || '', serpapiKey: env.SERPAPI_API_KEY || '', zhipuEngine: policy.zhipu_engine });
  const ledger = makeSearchBudgetGitHub({ token: env.GITHUB_TOKEN, repositoryName: env.GITHUB_REPOSITORY });
  const budget = makeBudgetedSearch({ initialState: await ledger.read({ initialize: true }), persist: state => ledger.persist(state), request: options => searchSources.request(options) });
  const deadline = Date.now() + 360000;
  const search = pilotSearch({ budget, sources: searchSources, policy, deadline });
  const publicHttp = makeEvidenceHttp({ timeoutMs: 12000, maxRequests: 90 });
  const http = { request: (...args) => { if (Date.now() >= deadline) throw new EvidenceError('REQUEST_LIMIT'); return publicHttp.request(...args); } };
  const report = await runIsolatedPilot(config, { tempParent: env.RUNNER_TEMP || os.tmpdir(), http, sources: makeEnrichmentSources(http),
    search: search.run, quotaResetsAt: search.quotaResetsAt, onStage: row => log(`PILOT_PROGRESS ${JSON.stringify(row)}`) });
  report.search_calls = search.counts(); report.search_blocked = search.blocked();
  report.zhipu_local_used = searchAllowance(budget.state(), { provider: 'zhipu', zhipuMonthlyLimit: policy.zhipu_monthly_limit }).local_used;
  report.serpapi_local_used = searchAllowance(budget.state(), { provider: 'serpapi_google', account: search.account() }).local_used;
  report.monthly_limits = { zhipu: policy.zhipu_monthly_limit, serpapi: policy.serpapi_monthly_limit };
  log(`PILOT_REPORT ${JSON.stringify(report)}`);
  if (path.isAbsolute(env.GITHUB_STEP_SUMMARY || '')) await fs.appendFile(env.GITHUB_STEP_SUMMARY,
    `## AER 联合试跑（不发布）\n\n只在临时副本运行；最多 6 次 Pro、4 次共享免费 SerpAPI、3 篇缺字段论文。来源受限不等于论文没有发表；此次不证明完整收录。没有调用翻译，也没有发布网站。\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`, 'utf8');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { assertLibrary(process.argv.slice(2).join(' ') === '--run', '必须显式指定试跑'); await searchPilot(); }
  catch (error) { console.error(`SEARCH_PILOT_FAILED ${/^[A-Z_]{3,50}$/.test(error.code || '') ? error.code : 'CHECK_FAILED'}；未输出密钥或远端错误正文。`); process.exitCode = 1; }
}
