import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { clonePilotLibrary, pilotSearch } from './search-pilot.js';
import { loadJournalConfig } from '../src/services/journals.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { runMetadataRepair } from '../src/services/metadataRepairRun.js';
import { assertLibrary } from '../src/services/libraryValidation.js';
import { makeEvidenceHttp, EvidenceError } from '../src/services/evidenceHttp.js';
import { makeEnrichmentSources } from '../src/services/enrichmentSources.js';
import { loadSearchPolicy } from '../src/services/searchPolicy.js';
import { makeSearchSources } from '../src/services/searchSources.js';
import { makeSearchBudgetGitHub } from '../src/services/searchBudgetGitHub.js';
import { makeBudgetedSearch, searchAllowance } from '../src/services/searchBudget.js';
import { buildTranslationQueue } from '../src/services/translationQueue.js';
export const TARGET_IDS = Object.freeze(['doi:10.1086/742421', 'doi:10.1086/742424', 'doi:10.1086/740222']);

export async function runAbstractPilot(config, { sources, search, quotaResetsAt, repositoryRoot, tempParent, onProgress = () => {} } = {}) {
  const copy = await clonePilotLibrary(config, { repositoryRoot, tempParent });
  try {
    const before = await readJournalLibrary({ root: copy.root, config });
    assertLibrary(TARGET_IDS.every(id => before.papers.some(p => p.id === id && p.journal_key === 'JPE' && !p.abstract_original)), '指定旧缺摘要论文不存在或已补齐');
    const result = await runMetadataRepair(config, { root: copy.root, journalKey: 'JPE', paperIds: TARGET_IDS, maxPapers: 3,
      sources, search, quotaResetsAt, onProgress });
    const after = await readJournalLibrary({ root: copy.root, config }), tasks = buildTranslationQueue(after.papers).tasks;
    const records = after.papers.filter(p => TARGET_IDS.includes(p.id)).map(p => {
      const entry = after.masterList.entries.find(e => e.id === p.id);
      const queued = tasks.some(t => t.paper_id === p.id && t.field === 'abstract');
      assertLibrary(Boolean(p.abstract_original) === queued && !p.abstract_zh, '摘要与翻译队列不一致');
      return { doi: p.doi, title: p.title_original, abstract_length: p.abstract_original.length,
        abstract_source: entry.abstract_source, abstract_source_url: entry.abstract_source_url, translation_queued: queued };
    });
    return { status: result.status, repairs: result.report?.repairs || [], records,
      original_unchanged: await copy.verifyOriginal(), production_writes: 0, translation_calls: 0 };
  } finally { await copy.verifyOriginal(); }
}

export async function abstractSearchPilot({ env = process.env, log = console.log } = {}) {
  assertLibrary(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'w1121188104w-hue/paper-daily' &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch', '仅允许手动GitHub隔离试跑');
  const config = await loadJournalConfig(), policy = await loadSearchPolicy();
  const providers = makeSearchSources({ zhipuKey: env.ZHIPU_API_KEY || '', serpapiKey: env.SERPAPI_API_KEY || '', zhipuEngine: policy.zhipu_engine });
  const ledger = makeSearchBudgetGitHub({ token: env.GITHUB_TOKEN, repositoryName: env.GITHUB_REPOSITORY });
  const budget = makeBudgetedSearch({ initialState: await ledger.read({ initialize: true }), persist: state => ledger.persist(state), request: options => providers.request(options) });
  const deadline = Date.now() + 360000, search = pilotSearch({ budget, sources: providers, policy, deadline, maxSerpapi: 6 });
  const publicHttp = makeEvidenceHttp({ timeoutMs: 12000, maxRequests: 90 });
  const http = { request: (...args) => { if (Date.now() >= deadline) throw new EvidenceError('REQUEST_LIMIT'); return publicHttp.request(...args); } };
  const report = await runAbstractPilot(config, { tempParent: env.RUNNER_TEMP || os.tmpdir(), sources: makeEnrichmentSources(http),
    search: search.run, quotaResetsAt: search.quotaResetsAt, onProgress: row => log(`PILOT_PROGRESS ${JSON.stringify(row)}`) });
  report.search_calls = search.counts(); report.search_blocked = search.blocked();
  report.zhipu_local_used = searchAllowance(budget.state(), { provider: 'zhipu', zhipuMonthlyLimit: policy.zhipu_monthly_limit }).local_used;
  report.serpapi_local_used = searchAllowance(budget.state(), { provider: 'serpapi_google', account: search.account() }).local_used;
  log(`PILOT_REPORT ${JSON.stringify(report)}`); return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { assertLibrary(process.argv.slice(2).join(' ') === '--run', '必须显式指定试跑'); await abstractSearchPilot(); }
  catch (error) { console.error(`ABSTRACT_PILOT_FAILED ${/^[A-Z_]{3,50}$/.test(error.code || '') ? error.code : 'CHECK_FAILED'}`); process.exitCode = 1; }
}
