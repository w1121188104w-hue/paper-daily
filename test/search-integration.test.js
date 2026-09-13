import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJournalConfig } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { validatePapers } from '../src/services/libraryValidation.js';
import { evidenceHash } from '../src/services/evidenceHttp.js';
import { canonicalPublisherUrl } from '../src/services/publisherCatalog.js';
import { readSearchCatalog, searchJournalCatalog, catalogSearchQuery, catalogMonths } from '../src/services/searchCatalog.js';
import { repairPaperMetadata, fillMissingMetadata } from '../src/services/searchMetadata.js';
import { loadSearchPolicy, validateSearchPolicy } from '../src/services/searchPolicy.js';
import { makeSearchBudgetGitHub } from '../src/services/searchBudgetGitHub.js';
import { emptySearchBudget, reserveSearchRequest, safeSerpAccountDiagnostics } from '../src/services/searchBudget.js';
import { searchPreflight } from '../scripts/search-preflight.js';
const config = await loadJournalConfig(), journal = config.journals.find(row => row.key === 'AER');
const at = '2026-09-13T02:00:00.000Z', window = { fromDate: '2026-07-16', toDate: '2026-09-13' };
const title = 'International trade and the allocation of economic resources';
const abstract = 'We investigate the allocation of economic resources across international markets using a detailed panel of firms and workers.';
function response(body, url) { return { body, url, fetched_at: at, sha256: evidenceHash(body), content_type: 'text/html' }; }
function article(doi = '10.1257/example', paperTitle = title, withDoi = true) { return `<meta name="citation_title" content="${paperTitle}"><meta name="citation_journal_title" content="American Economic Review">${withDoi ? `<meta name="citation_doi" content="${doi}">` : ''}<meta name="citation_author" content="Alice Smith"><meta name="citation_publication_date" content="2026-09"><div id="abstract">${abstract}</div>`; }
function source(overrides = {}) { return normalizeSourceRecord({ source: 'publisher', source_id: 'https://www.aeaweb.org/articles?id=10.1257/example',
  journal_key: journal.key, journal_name: journal.name, journal_category: journal.category, journal_category_zh: journal.category_zh,
  print_issn: journal.print_issn, electronic_issn: journal.electronic_issn, title, doi: '10.1257/example', authors: [], abstract: '',
  publication_date: '2026-09', url: 'https://www.aeaweb.org/articles?id=10.1257/example', last_checked_at: at,
  source_evidence: { url: 'https://www.aeaweb.org/articles?id=10.1257/example', scope_url: 'https://www.aeaweb.org/issues/123', fetched_at: at, body_sha256: 'a'.repeat(64), method: 'article_metadata_abstract' }, ...overrides }); }
const seed = overrides => mergePapers([source(overrides)], { firstSeenDate: '2026-09-13', checkedAt: at }).papers[0];

test('用户搜索授权：Pro、2000次、免费250，拒绝升额和自动支付', async () => {
  const policy = await loadSearchPolicy(); assert.equal(policy.zhipu_engine, 'search_pro'); assert.equal(policy.production_enabled, false);
  for (const change of [{ zhipu_monthly_limit: 2001 }, { zhipu_engine: 'search_std' }, { automatic_payment: true }, { serpapi_monthly_limit: 251 }]) assert.throws(() => validateSearchPolicy({ ...policy, ...change }));
});
test('清单搜索：按期刊月份查询，不依赖已有论文标题，不丢失月份', () => {
  assert.deepEqual(catalogMonths(window), ['2026-07', '2026-08', '2026-09']);
  const q = catalogSearchQuery({ name: 'Extremely '.repeat(20) }, '2026-09', 'zhipu');
  assert.ok(q.length <= 70); assert.match(q, /^2026-09 /); assert.match(q, /contents online first$/);
});
test('清单搜索：读取目录全部论文及下一页，不找到一篇就停止', async () => {
  const first = 'https://www.aeaweb.org/issues/123', second = 'https://www.aeaweb.org/issues/124';
  const one = 'https://www.aeaweb.org/articles?id=10.1257/one', two = 'https://www.aeaweb.org/articles?id=10.1257/two';
  const html = new Map([[first, `<a href="${one}">Paper one</a><a rel="next" href="${second}">Next</a>`], [second, `<a href="${two}">Paper two</a>`],
    [one, article('10.1257/one')], [two, article('10.1257/two', title + ' II')]]);
  const canonical = new Map([...html].map(([url, body]) => [canonicalPublisherUrl(url), body]));
  const fetched = [], http = { request: async url => { fetched.push(url); assert.ok(canonical.has(url)); return response(canonical.get(url), url); } };
  const result = await readSearchCatalog(journal, window, [{ url: first, snippet: 'invented abstract' }], { http });
  assert.equal(result.leads.length, 2); assert.equal(result.verified_list_read, true); assert.equal(result.incomplete, false);
  assert.equal(result.coverage, 'partial'); assert.equal(result.leads[0].abstract, abstract); assert.ok(fetched.includes(second));
});
test('清单搜索：独立发现无DOI论文，期刊和结构化标题确认后保留', async () => {
  const url = 'https://www.aeaweb.org/articles/no-doi';
  const result = await readSearchCatalog(journal, window, [url], { http: { request: async () => response(article('', title, false), url) } });
  assert.equal(result.leads.length, 1); assert.equal(result.leads[0].doi, ''); assert.equal(result.verified_list_read, false);
});
test('清单搜索：搜索片段、其他网站和错误期刊不能写成清单', async () => {
  let calls = 0;
  const result = await readSearchCatalog(journal, window, [{ url: 'https://evil.example/catalog', snippet: article() }], { http: { request: () => { calls++; } } });
  assert.equal(calls, 0); assert.equal(result.leads.length, 0);
  const wrong = await readSearchCatalog(journal, window, ['https://www.aeaweb.org/articles?id=10.1257/example'], { http: { request: async url => response(article().replace('American Economic Review', 'Journal of Economic Literature'), url) } });
  assert.equal(wrong.leads.length, 0);
});
test('清单搜索：仅发现一篇文章继续兜底，不把它当作已读完整目录', async () => {
  const visited = []; let index = 0;
  const result = await searchJournalCatalog(journal, window, { months: ['2026-09'], search: async ({ provider, query }) => {
    visited.push(provider); assert.match(query, /2026-09/); return { called: true, result: { leads: [{ url: `https://www.aeaweb.org/issues/${++index}` }] } }; },
    readCatalog: async () => ({ leads: [{ doi: `10.1257/${index}`, url: `https://www.aeaweb.org/articles/${index}`, title, date: '2026-09' }],
      verified_list_read: index > 1, incomplete: false, checked_urls: [], attempts: [] }) });
  assert.deepEqual(visited, ['zhipu', 'serpapi_scholar']); assert.equal(result.leads.length, 2);
});
test('清单搜索：限额不冒充查完未找到；分页超限保留待查网址', async () => {
  const result = await searchJournalCatalog(journal, window, { months: ['2026-09'], search: async ({ provider }) => provider === 'zhipu' ?
    { called: true, result: { leads: [] } } : { called: false, reason: 'quota_exhausted' }, readCatalog: async () => ({ leads: [], verified_list_read: false, incomplete: false, checked_urls: [], attempts: [] }) });
  assert.equal(result.search_queries[0].status, 'quota_exhausted');
  const url = 'https://www.aeaweb.org/issues/123';
  const limited = await readSearchCatalog(journal, window, [url], { maxPages: 1, http: { request: async u => response('<a rel="next" href="/issues/124">Next</a>', u) } });
  assert.equal(limited.incomplete, true); assert.ok(limited.pending_urls.includes('https://www.aeaweb.org/issues/124'));
});
test('字段修复：先三源再搜索，真实摘要补齐后进入翻译队列，保留ID', async () => {
  const paper = seed(), calls = [], sources = Object.fromEntries(['crossref', 'openalex', 'semanticscholar'].map(name => [name, async () => { calls.push(name); return source(); }]));
  sources.publisherArticle = async () => source({ authors: [{ name: 'Alice Smith' }], abstract });
  const result = await repairPaperMetadata(paper, journal, { sources, search: async ({ provider }) => { calls.push(provider);
    return { called: true, result: { leads: [{ url: paper.url, snippet: 'Invented abstract' }] } }; } });
  assert.deepEqual(calls, ['crossref', 'openalex', 'semanticscholar', 'zhipu']); assert.equal(result.status, 'resolved');
  assert.equal(result.paper.id, paper.id); assert.equal(result.paper.abstract_original, abstract); assert.equal(result.paper.abstract_zh, '');
  assert.equal(result.paper.abstract_translation_status, 'pending'); validatePapers([result.paper], config);
});
test('字段修复：无原始摘要时不生成中英文摘要，完整论文不重复搜索', async () => {
  const paper = seed({ authors: ['Alice Smith'] }), sources = Object.fromEntries(['crossref', 'openalex', 'semanticscholar', 'publisherArticle'].map(name => [name, async () => source({ authors: ['Alice Smith'] })]));
  let count = 0;
  const search = async () => { count++; return { called: true, result: { leads: [{ url: paper.url, snippet: abstract }] } }; };
  const result = await repairPaperMetadata(paper, journal, { sources, search });
  assert.equal(result.paper.abstract_original, ''); assert.equal(result.paper.abstract_zh, ''); assert.equal(result.status, 'not_found');
  assert.equal(count, 3); count = 0;
  await repairPaperMetadata(seed({ authors: ['Alice Smith'], abstract }), journal, { sources, search }); assert.equal(count, 0);
});
test('字段修复：可补无DOI记录，不覆盖既有摘要、月份、译文，不错绑相似论文', () => {
  const paper = seed({ doi: '', authors: ['Alice Smith'], abstract }); paper.title_zh = '既有中文标题'; paper.title_translation_status = 'done';
  const result = fillMissingMetadata(paper, source({ authors: ['Alice Smith'], abstract: abstract + ' Changed.' }));
  assert.equal(result.paper.doi, '10.1257/example'); assert.equal(result.paper.id, paper.id); assert.equal(result.paper.title_zh, paper.title_zh); assert.equal(result.paper.abstract_original, abstract);
  validatePapers([result.paper], config);
  assert.throws(() => fillMissingMetadata(paper, source({ title: title + ' different' })));
  assert.throws(() => fillMissingMetadata(paper, source({ publication_date: '2025-09' })));
  assert.throws(() => fillMissingMetadata(paper, source(), { otherPapers: [{ id: 'other', doi: '10.1257/example' }] }));
});
test('远端搜索账本：读取现有用量，写入必须携带原SHA且限固定仓库/路径', async () => {
  const calls = [], oldSha = 'a'.repeat(40), nextSha = 'b'.repeat(40);
  const budget = reserveSearchRequest(emptySearchBudget(), { provider: 'zhipu', query: 'q', taskId: 'task', now: new Date(at), zhipuMonthlyLimit: 2000 }).state;
  const ledger = makeSearchBudgetGitHub({ token: 'fake-token-for-test', repositoryName: 'w1121188104w-hue/paper-daily', fetchImpl: async (url, init) => {
    calls.push({ url, init }); if (init.method === 'PUT') { assert.equal(JSON.parse(init.body).sha, oldSha); return new Response(JSON.stringify({ content: { sha: nextSha } })); }
    return new Response(JSON.stringify(url.includes('/git/ref/') ? { object: { sha: oldSha } } : { sha: oldSha, encoding: 'base64', content: Buffer.from(JSON.stringify(budget)).toString('base64') })); } });
  const state = await ledger.read(); assert.equal(state.requests.length, 1); await ledger.persist(state);
  assert.equal(calls.length, 3); assert.ok(calls.every(row => row.init.redirect === 'error'));
  assert.throws(() => makeSearchBudgetGitHub({ token: 'fake-token-for-test', repositoryName: 'other/repo' }));
});
test('远端搜索账本：已存在分支却丢失账本时停止，禁止将历史用量重置为0', async () => {
  const ledger = makeSearchBudgetGitHub({ token: 'fake-token-for-test', repositoryName: 'w1121188104w-hue/paper-daily', fetchImpl: async url =>
    url.includes('/git/ref/') ? new Response(JSON.stringify({ object: { sha: 'a'.repeat(40) } })) : new Response('', { status: 404 }) });
  await assert.rejects(ledger.read({ initialize: true }));
});
test('密钥验证：先查免费账户，再远端预记账，仅调用一次Pro且不输出密钥', async () => {
  const events = [], outputs = [];
  const result = await searchPreflight({ env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'w1121188104w-hue/paper-daily',
    ZHIPU_API_KEY: 'private-zhipu-secret', SERPAPI_API_KEY: 'private-serp-secret' },
    sourceFactory: options => { assert.equal(options.zhipuEngine, 'search_pro'); return {
      account: async () => { events.push('account'); return { free_plan: true, remaining: 250, used: 0, renewal_date: '2026-10-13' }; },
      request: async ({ provider }) => { events.push(provider); return { charged: 1, leads: [] }; } }; },
    ledgerFactory: () => ({ read: async () => emptySearchBudget(), persist: async () => { events.push('checkpoint'); } }), log: row => outputs.push(row) });
  assert.equal(result, 0); assert.deepEqual(events, ['account', 'checkpoint', 'zhipu', 'checkpoint']);
  assert.ok(!outputs.join('').includes('private-')); assert.equal(JSON.parse(outputs[0]).papers_changed, 0);
});

test('账户只读诊断：仅允许枚举、数值和格式标记，禁止密钥邮箱及任意字符串', () => {
  const result = safeSerpAccountDiagnostics({ api_key: 'private-secret', account_email: 'private@example.com', account_status: 'private-secret',
    plan_monthly_price: 'private-secret', searches_per_month: 250, plan_searches_left: 250, this_month_usage: 0, extra_credits: 0,
    plan_renewal_date: '2026-10-13 00:00:00 UTC' }, at);
  assert.equal(result.verified_free_account, false); assert.equal(result.renewal_format, 'space_separated');
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('账户只读诊断：不创建账本，不调用任何搜索接口', async () => {
  const result = await searchPreflight({ env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'w1121188104w-hue/paper-daily' },
    accountOnly: true, sourceFactory: () => ({ accountDiagnostics: async () => ({ verified_free_account: false }), request: () => assert.fail('No search') }),
    ledgerFactory: () => assert.fail('No ledger'), log: row => { assert.equal(JSON.parse(row).search_calls, 0); } });
  assert.equal(result, 0);
});
