import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pilotSearch, runIsolatedPilot, clonePilotLibrary, searchPilot } from '../scripts/search-pilot.js';
import { makeBudgetedSearch } from '../src/services/searchBudget.js';
import { loadJournalConfig } from '../src/services/journals.js';
import { runCatalogDiscovery } from '../src/services/catalogDiscoveryRun.js';
import { verifyPilotReuse } from '../src/services/pilotReuseCheck.js';

const policy = { zhipu_monthly_limit: 2000 };
const at = new Date('2026-09-13T14:00:00Z');
const account = () => ({ free_plan: true, checked_at: at.toISOString(), used: 0, remaining: 250, monthly_limit: 250, renewal_date: '2026-10-13' });

test('联合试跑共享单次上限：并发请求也不超6次Pro/4次Serp；每次Serp刷新免费账户', async () => {
  let snapshots = 0, requests = 0, checkpoints = 0;
  const budget = makeBudgetedSearch({ now: () => at, persist: async () => { checkpoints++; },
    request: async () => { requests++; return { charged: 1, leads: [] }; } });
  const search = pilotSearch({ budget, policy, now: () => at.getTime(), sources: { account: async () => { snapshots++; return account(); } } });
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => search.run({ provider: i < 15 ? 'zhipu' : i % 2 ? 'serpapi_google' : 'serpapi_scholar', query: `query ${i}`, taskId: `task ${i}` })));
  assert.equal(requests, 10); assert.equal(checkpoints, 20); assert.equal(snapshots, 4);
  assert.deepEqual(search.counts(), { zhipu: 6, serpapi: 4 });
  assert.equal(results.filter(r => r.reason === 'pilot_request_limit').length, 20);
  assert.ok(results.every(r => r.reason !== 'quota_exhausted'));
  assert.equal(search.quotaResetsAt(), '2026-10-14T00:00:00.000Z');
});

test('实际失败仍占次数；账户无法验证只禁Serp；检查点失败不伪装为来源失败', async () => {
  let attempts = 0;
  const budget = makeBudgetedSearch({ now: () => at, persist: async () => {}, request: async () => { attempts++; throw new Error('private remote text'); } });
  const search = pilotSearch({ budget, policy, sources: { account: async () => { throw new Error('private account text'); } } });
  for (let i = 0; i < 8; i++) await search.run({ provider: 'zhipu', query: `q ${i}`, taskId: `task ${i}` });
  assert.equal(attempts, 6); assert.equal(budget.state().requests.length, 6);
  assert.equal((await search.run({ provider: 'serpapi_google', query: 'q', taskId: 't' })).reason, 'account_unverified');
  const broken = pilotSearch({ policy, sources: {}, budget: { run: async () => { throw Object.assign(new Error(), { code: 'SEARCH_LEDGER_CHECKPOINT_FAILED' }); } } });
  await assert.rejects(broken.run({ provider: 'zhipu' }), { code: 'SEARCH_LEDGER_CHECKPOINT_FAILED' });
});

test('真实月额度耗尽仍保持quota_exhausted；截止后不再查账户或发送收费请求', async () => {
  const monthly = pilotSearch({ policy, sources: {}, budget: { run: async () => ({ called: false, reason: 'quota_exhausted' }) } });
  assert.equal((await monthly.run({ provider: 'zhipu' })).reason, 'quota_exhausted');
  const expired = pilotSearch({ policy, deadline: 1, now: () => 2, sources: { account: () => assert.fail() }, budget: { run: () => assert.fail() } });
  assert.equal((await expired.run({ provider: 'serpapi_google' })).reason, 'pilot_request_limit');
});

async function seed(t) {
  const parent = await fs.realpath(os.tmpdir()), repo = await fs.mkdtemp(path.join(parent, 'pilot-test-'));
  t.after(async () => { assert.equal(path.dirname(repo), parent); assert.ok(path.basename(repo).startsWith('pilot-test-')); await fs.rm(repo, { recursive: true, force: true }); });
  const config = await loadJournalConfig(), root = path.join(repo, 'data', 'journal-store');
  await runCatalogDiscovery(config, { root, journalKey: 'AER', now: () => at, http: { request: () => assert.fail() },
    discover: async () => ({ leads: [], attempts: [] }), search: async () => ({ called: false, reason: 'quota_exhausted' }) });
  return { config, repo, root, parent };
}

test('临时副本只含已验证历史；拒绝仓库内临时目录，发现原库变化', async t => {
  const { config, repo, root, parent } = await seed(t);
  await fs.writeFile(path.join(root, 'ignored-secret.txt'), 'do not copy');
  await assert.rejects(clonePilotLibrary(config, { repositoryRoot: repo, tempParent: repo }));
  const copy = await clonePilotLibrary(config, { repositoryRoot: repo, tempParent: parent });
  t.after(async () => { assert.equal(path.dirname(copy.directory), parent); assert.ok(path.basename(copy.directory).startsWith('paper-search-pilot-')); await fs.rm(copy.directory, { recursive: true, force: true }); });
  assert.equal(await copy.verifyOriginal(), true);
  await assert.rejects(fs.readFile(path.join(copy.root, 'ignored-secret.txt')), { code: 'ENOENT' });
  await fs.appendFile(path.join(root, 'current.json'), '\n');
  await assert.rejects(copy.verifyOriginal());
});

test('联合入口强制三源→官网清单→缺字段，原库不变，不调用翻译；部分失败继续', async t => {
  const { config, repo, root, parent } = await seed(t), phases = [];
  const original = await fs.readFile(path.join(root, 'current.json'), 'utf8');
  let pilotRoot;
  const stage = name => async (_, options) => {
    phases.push(name); assert.notEqual(options.root, root); pilotRoot = options.root; assert.equal(options.journalKey, 'QJE');
    if (name === 'collect') { assert.equal(options.withSemanticScholar, true); assert.equal(options.lookbackDays, 60); }
    if (name === 'repair') assert.equal(options.maxPapers, 20);
    return { status: 'partial_failure' };
  };
  const report = await runIsolatedPilot(config, { repositoryRoot: repo, tempParent: parent, journalKey: 'QJE', maxMetadataPapers: 20,
    collect: stage('collect'), catalog: stage('catalog'), repair: stage('repair') });
  const directory = path.resolve(pilotRoot, '../..');
  t.after(async () => { assert.equal(path.dirname(directory), parent); assert.ok(path.basename(directory).startsWith('paper-search-pilot-')); await fs.rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(phases, ['collect', 'catalog', 'repair']);
  assert.equal(await fs.readFile(path.join(root, 'current.json'), 'utf8'), original);
  assert.equal(report.production_unchanged, true); assert.equal(report.translation_calls, 0); assert.equal(report.website_deployed, false);
  assert.equal(report.coverage, 'not_proven_complete');
  assert.equal(report.limits.journal, 'QJE');
  assert.equal(report.limits.metadata_papers, 20);
});

test('不得从本地或定时触发入口读取搜索密钥', async () => {
  await assert.rejects(searchPilot({ env: {} }));
  await assert.rejects(searchPilot({ env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'w1121188104w-hue/paper-daily', GITHUB_EVENT_NAME: 'schedule' } }));
  await assert.rejects(searchPilot({ env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'w1121188104w-hue/paper-daily', GITHUB_EVENT_NAME: 'workflow_dispatch', PILOT_METADATA_BATCH: '1000' } }));
  await assert.rejects(runIsolatedPilot({}, { maxMetadataPapers: 1000, repositoryRoot: '/must-not-read' }));
});

test('真实持久化状态立即重开：清单与字段都跳过，零网络且版本不变', async t => {
  const { config, root } = await seed(t);
  const report = await verifyPilotReuse(config, { root, journalKey: 'AER', now: () => at });
  assert.equal(report.status, 'verified_no_repeat_requests'); assert.equal(report.network_calls, 0);
  assert.equal(report.catalog.status, 'verified_skipped'); assert.equal(report.metadata.status, 'verified_skipped');
  assert.equal(report.pointer_unchanged, true);
});

test('跨北京时间午夜仍有到期清单：复用检查如实标记未测试，不执行新的网络任务', async t => {
  const { config, root } = await seed(t);
  const report = await verifyPilotReuse(config, { root, journalKey: 'AER', now: () => new Date('2026-09-13T16:00:00Z') });
  assert.equal(report.status, 'partial_not_tested_due_work'); assert.equal(report.catalog.status, 'not_tested_due_work');
  assert.equal(report.catalog.due_months, 3); assert.equal(report.network_calls, 0);
});

test('真实原文新增记录保留可核对的目录证据与边界日期，摘要进入队列但不输出摘要正文', async t => {
  const { config, repo, parent } = await seed(t);
  const title = 'Trade and the allocation of economic resources', url = 'https://www.aeaweb.org/articles?id=10.1257/pilot.example';
  const abstract = 'We study the allocation of economic resources across firms and sectors using a quantitative model and newly assembled microeconomic data.';
  let directory;
  const report = await runIsolatedPilot(config, { repositoryRoot: repo, tempParent: parent,
    collect: async () => ({ status: 'partial_failure' }), repair: async () => ({ status: 'skipped' }),
    catalog: async (cfg, options) => {
      directory = path.resolve(options.root, '../..');
      return runCatalogDiscovery(cfg, { ...options, now: () => new Date('2026-09-14T01:00:00Z'),
        http: { request: () => assert.fail() }, search: async () => ({ called: false, reason: 'pilot_request_limit' }),
        discover: async () => ({ leads: [{ title, doi: '10.1257/pilot.example', url, date: '2026-07', authors: ['Alice Smith'], abstract,
          journal_confirmed: true, evidence: { url, scope_url: 'https://www.aeaweb.org/issues/123', fetched_at: '2026-09-14T01:00:00.000Z',
            method: 'citation_meta_abstract', body_sha256: 'a'.repeat(64) } }], attempts: [] }) });
    } });
  t.after(async () => { assert.equal(path.dirname(directory), parent); assert.ok(path.basename(directory).startsWith('paper-search-pilot-')); await fs.rm(directory, { recursive: true, force: true }); });
  assert.equal(report.catalog.added_records.length, 1); assert.equal(report.catalog.added_records[0].original_date, '2026-07');
  assert.notEqual(report.catalog.added_records[0].window_status, 'inside');
  assert.equal(report.new_english_abstracts, 1); assert.equal(report.new_abstracts_queued, 1);
  assert.equal(report.new_abstract_records[0].source_url, url); assert.equal(report.new_abstract_records[0].newly_discovered_paper, true);
  assert.ok(!JSON.stringify(report).includes(abstract)); assert.equal(report.metadata.papers_with_fields_filled, 0);
});
