import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { evidenceHash } from '../src/services/evidenceHttp.js';
import { publisherRecord } from '../src/services/publisherParsers.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { validatePapers } from '../src/services/libraryValidation.js';
import { buildMasterList } from '../src/services/masterList.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { journalGitFiles } from '../src/services/journalGitFiles.js';
import { makeBudgetedSearch } from '../src/services/searchBudget.js';
import { validateCatalogSearchState } from '../src/services/catalogSearchState.js';
import { reconcileCatalogDiscovery, runCatalogDiscovery } from '../src/services/catalogDiscoveryRun.js';
import { searchJournalCatalog, readSearchCatalog } from '../src/services/searchCatalog.js';
import { runMasterCommand } from '../scripts/master-list.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER');
const at = '2026-09-13T12:00:00.000Z', window = { fromDate: '2026-07-16', toDate: '2026-09-13' };
const title = 'International trade and the allocation of economic resources';
const catalog = 'https://www.aeaweb.org/issues/123';
function lead(patch = {}) {
  const url = patch.url || 'https://www.aeaweb.org/articles/no-doi';
  return { title, doi: '', authors: [], date: '2026-09', abstract: '', journal_confirmed: true,
    url, type: 'journal-article', evidence: { url, scope_url: catalog, fetched_at: at, body_sha256: 'a'.repeat(64), method: 'article_without_abstract' }, ...patch };
}
const reconcile = (leads, papers = []) => reconcileCatalogDiscovery({ leads, attempts: [] }, journal, papers, window,
  { checkedAt: at, runDate: '2026-09-13' });
async function temporary(t) {
  const parent = path.resolve(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'catalog-discovery-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), parent); assert.ok(path.basename(directory).startsWith('catalog-discovery-test-')); await fs.rm(directory, { recursive: true, force: true }); });
  return { repositoryRoot: directory, root: path.join(directory, 'data', 'journal-store') };
}

test('清单入库：缺DOI、作者、月份均可保留，首次发现精确，边界月份不伪造日期', () => {
  for (const date of ['2026-09', '2026', '']) {
    const result = reconcile([lead({ date })]);
    assert.equal(result.papers.length, 1); validatePapers(result.papers, config);
    const master = buildMasterList(result.papers, { generatedAt: at, ...window });
    assert.equal(master.entries[0].doi, null); assert.equal(master.entries[0].doi_status, 'no_doi_yet');
    assert.equal(master.entries[0].publication_month, date.length >= 7 ? date : null);
    assert.equal(master.entries[0].discovered_at, at); assert.equal(result.report.official_in_window_count, 0);
    assert.equal(result.papers[0].abstract_zh, ''); assert.equal(result.report.added_count, 1);
  }
  assert.equal(reconcile([lead({ date: '2025-01' })]).papers.length, 0);
  assert.equal(reconcile([lead({ date: '2026-12' })]).papers.length, 0);
});

test('清单去重：大小写、标点、连字符不新增，已有日期译文与DOI完全保留', () => {
  const old = mergePapers([publisherRecord(lead({ title: 'International-trade: and the allocation of economic resources' }), journal)],
    { firstSeenDate: '2026-09-12', checkedAt: '2026-09-12T01:00:00.000Z' }).papers[0];
  old.title_zh = '已有中文标题'; old.title_translation_status = 'done';
  const result = reconcile([lead({ title: title.toUpperCase(), doi: '10.1257/new' })], [old]);
  assert.equal(result.papers.length, 1); assert.equal(result.report.entries[0].status, 'existing');
  assert.deepEqual(result.papers[0], old); // DOI repair belongs to phase two, not this admission step.
});

test('清单冲突：同DOI异标题、同标题异DOI及作者冲突不任意合并', () => {
  const sameDoi = reconcile([lead({ doi: '10.1257/one' }), lead({ doi: '10.1257/one', title: title + ' A different paper' })]);
  assert.equal(sameDoi.papers.length, 0); assert.equal(sameDoi.report.pending_count, 2);
  const old = mergePapers([publisherRecord(lead({ doi: '10.1257/one', authors: ['Alice Smith'] }), journal)],
    { firstSeenDate: '2026-09-12', checkedAt: at }).papers[0];
  assert.equal(reconcile([lead({ doi: '10.1257/two' })], [old]).report.pending_count, 1);
  assert.equal(reconcile([lead({ authors: ['Bob Jones'] })], [old]).report.pending_count, 1);
});

test('清单证据：外站链接、未核实期刊与编辑报告不得新增研究论文', () => {
  for (const candidate of [lead({ url: 'https://evil.example/article' }), lead({ journal_confirmed: false }), lead({ title: 'Report of the Editor' })]) {
    assert.equal(reconcile([candidate]).papers.length, 0);
  }
});

test('清单搜索：相同目录覆盖多个月时复用响应，不丢失后续月份、不滥用兜底', async () => {
  const visits = [], calls = [], bodies = new Map([[catalog, '<a href="/articles/july">July</a><a href="/articles/august">August</a>']]);
  for (const [slug, month] of [['july', '2026-07'], ['august', '2026-08']]) bodies.set(`https://www.aeaweb.org/articles/${slug}`,
    `<meta name="citation_title" content="${title} ${slug}"><meta name="citation_journal_title" content="${journal.name}"><meta name="citation_publication_date" content="${month}">`);
  const result = await searchJournalCatalog(journal, window, { months: ['2026-07', '2026-08'],
    search: async options => { calls.push(options.provider); return { called: true, result: { leads: [{ url: catalog }] } }; },
    http: { request: async url => { visits.push(url); const body = bodies.get(url); assert.ok(body); return { url, body, sha256: evidenceHash(body), fetched_at: at, content_type: 'text/html' }; } } });
  assert.deepEqual(calls, ['zhipu', 'zhipu']); assert.equal(visits.length, 3);
  assert.ok(result.search_queries.every(row => row.status === 'catalog_checked_partial'));
});

test('清单搜索：访问失败的网址保留到下次，不把部分失败标成已走完未找到', async () => {
  const blocked = await readSearchCatalog(journal, window, [catalog], { http: { request: async () => { throw new Error('blocked'); } } });
  assert.deepEqual(blocked.pending_urls, [catalog]);
  const result = await searchJournalCatalog(journal, window, { months: ['2026-09'], search: async ({ provider }) => {
    if (provider === 'zhipu') throw new Error('down'); return { called: true, result: { leads: [] } };
  }, readCatalog: async () => ({ leads: [], attempts: [], checked_urls: [], verified_list_read: false, incomplete: false }) });
  assert.equal(result.search_queries[0].status, 'source_unavailable');
});

test('清单端到端：搜索→官方页面→新名册→持久化→次日复用，不改历史、不生成摘要', async t => {
  const dirs = await temporary(t); let clock = new Date(at), apiCalls = 0, directCalls = 0;
  const events = [], bodies = new Map([[catalog, '<a href="/articles/july">July</a><a href="/articles/august">August</a><a href="/articles/september">September</a>']]);
  for (const [slug, month] of [['july', '2026-07'], ['august', '2026-08'], ['september', '2026-09']]) bodies.set(`https://www.aeaweb.org/articles/${slug}`,
    `<meta name="citation_title" content="${title} ${slug}"><meta name="citation_journal_title" content="${journal.name}"><meta name="citation_publication_date" content="${month}">`);
  const budget = makeBudgetedSearch({ now: () => clock, persist: async state => events.push(state.requests.at(-1).status),
    request: async () => { apiCalls++; events.push('request'); return { charged: 1, leads: [{ url: catalog, snippet: 'Never use this as an abstract' }] }; } });
  const options = { ...dirs, journalKey: 'AER', now: () => clock,
    discover: async () => { directCalls++; throw new Error('Official home unavailable'); },
    search: request => budget.run({ ...request, zhipuMonthlyLimit: 2000 }),
    http: { request: async url => { const body = bodies.get(url); assert.ok(body); return { url, body, sha256: evidenceHash(body), fetched_at: clock.toISOString(), content_type: 'text/html' }; } } };
  const first = await runCatalogDiscovery(config, options);
  assert.equal(first.stats.added, 3); assert.equal(apiCalls, 3);
  assert.deepEqual(events, Array(3).fill(['reserved', 'request', 'succeeded']).flat());
  const saved = await readJournalLibrary({ root: dirs.root, config });
  assert.equal(saved.papers.length, 3); assert.ok(saved.papers.every(p => p.doi === '' && p.abstract_original === '' && p.abstract_zh === ''));
  assert.equal(saved.masterList.from_date, window.fromDate); assert.equal(saved.masterList.to_date, window.toDate);
  assert.ok(saved.masterList.entries.every(p => p.found_official_site && !p.found_crossref));
  assert.equal(Object.keys(saved.enrichmentState.catalog_search).length, 3);
  const skipped = await runCatalogDiscovery(config, options);
  assert.equal(skipped.committed, false); assert.equal(apiCalls, 3); assert.equal(directCalls, 1);
  clock = new Date('2026-09-14T01:00:00.000Z'); // Next Shanghai calendar day, less than 24h later.
  const next = await runCatalogDiscovery(config, options);
  assert.equal(next.stats.added, 0); assert.equal(apiCalls, 3); assert.equal(directCalls, 2);
  assert.ok(next.report.search_queries.every(q => q.reused_catalog));
  const latest = await readJournalLibrary({ root: dirs.root, config });
  assert.deepEqual(latest.papers, saved.papers); assert.equal(latest.masterList.to_date, '2026-09-14');
  const files = await journalGitFiles(config, dirs);
  assert.equal(files.versions, 2); assert.ok(files.files.some(file => file.endsWith('enrichment-state.json')));
});

test('清单缓存：未知结果与免费额度耗尽区分保存，次日可重新调度', async t => {
  const { root } = await temporary(t);
  const result = await runCatalogDiscovery(config, { root, journalKey: 'AER', now: () => new Date(at), http: { request: () => assert.fail('No page') },
    discover: async () => ({ leads: [], attempts: [] }),
    search: async ({ provider }) => provider === 'zhipu' ? { called: true, result: { leads: [] } } : { called: false, reason: 'quota_exhausted' } });
  assert.ok(result.report.search_queries.every(q => q.status === 'quota_exhausted'));
  const library = await readJournalLibrary({ root, config });
  assert.ok(Object.values(library.enrichmentState.catalog_search).every(row => row.status === 'quota_exhausted' && row.next_retry_at === '2026-09-13T16:00:00.000Z'));
  const outputs = [];
  await runMasterCommand(['--unresolved'], { read: async () => library, now: () => new Date(at), log: text => outputs.push(JSON.parse(text)) });
  assert.equal(outputs[0].catalog_tasks.length, 3); assert.equal(outputs[0].manual_review_required, false);
  await runMasterCommand(['--unresolved', '--due'], { read: async () => library, now: () => new Date(at), log: text => outputs.push(JSON.parse(text)) });
  assert.equal(outputs[1].catalog_tasks.length, 0);
  const corrupted = structuredClone(library.enrichmentState.catalog_search);
  corrupted['AER:2026-09'].urls.push('https://example.com/?api_key=secret');
  assert.throws(() => validateCatalogSearchState(corrupted));
});

test('清单来源隔离：某刊官网和搜索不可用，不阻止另一刊保存已核实论文', async t => {
  const { root } = await temporary(t), second = findJournal(config, 'JPE');
  const secondUrl = 'https://www.journals.uchicago.edu/doi/10.1086/example';
  const result = await runCatalogDiscovery(config, { root, now: () => new Date(at), http: { request: () => assert.fail('No page') },
    discover: async j => {
      if (j.key === 'AER') throw new Error('home unavailable');
      return { attempts: [], leads: j.key === second.key ? [lead({ url: secondUrl, doi: '10.1086/example',
        evidence: { ...lead().evidence, url: secondUrl, scope_url: 'https://www.journals.uchicago.edu/toc/jpe/current' } })] : [] };
    }, search: async () => { throw new Error('search unavailable'); } });
  assert.equal(result.stats.added, 1);
  const library = await readJournalLibrary({ root, config });
  assert.equal(library.papers[0].journal_key, 'JPE'); assert.ok(result.report.search_queries.some(q => q.journal_key === 'AER' && q.status === 'source_unavailable'));
});

test('清单记账失败：不降级绕过错误、不发布版本、不调用下一个引擎', async t => {
  const { root } = await temporary(t); let calls = 0;
  await assert.rejects(runCatalogDiscovery(config, { root, journalKey: 'AER', now: () => new Date(at), http: { request: () => assert.fail('No page') },
    discover: async () => ({ leads: [], attempts: [] }), search: async () => { calls++;
      throw Object.assign(new Error('checkpoint failed'), { code: 'SEARCH_LEDGER_CHECKPOINT_FAILED' }); } }));
  assert.equal(calls, 1); assert.equal((await readJournalLibrary({ root, config })).pointer, null);
});

test('清单保存中断：旧版本仍可读取，不能因半成品替换当前论文库', async t => {
  const { root } = await temporary(t); let clock = new Date(at);
  const options = { root, journalKey: 'AER', now: () => clock, http: { request: () => assert.fail('No page') },
    discover: async () => ({ leads: [lead()], attempts: [] }), search: async () => ({ called: false, reason: 'quota_exhausted' }) };
  await runCatalogDiscovery(config, options); const previous = await readJournalLibrary({ root, config });
  clock = new Date('2026-09-14T01:00:00.000Z');
  await assert.rejects(runCatalogDiscovery(config, { ...options, beforePublish: () => { throw new Error('Simulated storage interruption'); } }));
  assert.equal((await readJournalLibrary({ root, config })).pointerText, previous.pointerText);
});
