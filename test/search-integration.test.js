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
import { publicationFor } from '../src/services/masterList.js';
import { validateMetadataRepairOnlyChange } from '../src/services/metadataRepairValidation.js';
import { emptySearchBudget, reserveSearchRequest, settleSearchRequest, safeSerpAccountDiagnostics } from '../src/services/searchBudget.js';
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
test('字段修复：三源之后先读已知官网，成功则不调用收费搜索', async () => {
  const paper = seed({ authors: ['Alice Smith'] }), calls = [];
  const sources = Object.fromEntries(['crossref', 'openalex', 'semanticscholar'].map(name => [name, async () => { calls.push(name); return source({ authors: ['Alice Smith'] }); }]));
  sources.publisher = async () => { calls.push('publisher'); return source({ authors: ['Alice Smith'], abstract }); };
  const result = await repairPaperMetadata(paper, journal, { sources, search: () => assert.fail('No paid search required') });
  assert.deepEqual(calls, ['crossref', 'openalex', 'semanticscholar', 'publisher']);
  assert.equal(result.status, 'resolved'); assert.equal(result.paper.abstract_original, abstract);
  assert.equal(result.paper.abstract_translation_status, 'pending'); assert.equal(result.paper.abstract_zh, '');
  assert.equal(result.paper.provenance.abstract_original.source, 'publisher');
});

test('字段修复：官网受限后继续搜索兜底，不能把搜索片段当摘要', async () => {
  const paper = seed({ authors: ['Alice Smith'] }), calls = [];
  const sources = Object.fromEntries(['crossref', 'openalex', 'semanticscholar'].map(name => [name, async () => source({ authors: ['Alice Smith'] })]));
  sources.publisher = async () => { calls.push('publisher'); throw Object.assign(new Error(), { code: 'ACCESS_RESTRICTED' }); };
  sources.publisherArticle = async () => source({ authors: ['Alice Smith'] });
  const result = await repairPaperMetadata(paper, journal, { sources, search: async ({ provider }) => {
    calls.push(provider); return { called: true, result: { leads: [{ url: paper.url, snippet: abstract }] } };
  } });
  assert.deepEqual(calls, ['publisher', 'zhipu', 'serpapi_scholar', 'serpapi_google']);
  assert.equal(result.paper.abstract_original, ''); assert.equal(result.paper.abstract_zh, '');
  assert.ok(result.attempts.some(a => a.source === 'publisher' && a.status === 'ACCESS_RESTRICTED'));
});

test('字段修复：官网证据存储失败必须停止，禁止搜索绕过；已有摘要不再读官网', async () => {
  const sources = Object.fromEntries(['crossref', 'openalex', 'semanticscholar'].map(name => [name, async () => source({ authors: ['Alice Smith'] })]));
  sources.publisher = async () => { throw Object.assign(new Error(), { code: 'EVIDENCE_STORAGE_ERROR' }); };
  await assert.rejects(repairPaperMetadata(seed({ authors: ['Alice Smith'] }), journal, { sources, search: () => assert.fail('Must stop') }), { code: 'EVIDENCE_STORAGE_ERROR' });
  const result = await repairPaperMetadata(seed({ authors: ['Alice Smith'], abstract }), journal, { sources, search: () => assert.fail('Complete') });
  assert.equal(result.status, 'resolved'); assert.deepEqual(result.attempts, []);
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

test('摘要修复不被月份分歧拖累：相同DOI标题可单独补原文，保留既有日期和冲突证据', async () => {
  const paper = seed({ authors: ['Alice Smith'] });
  const conflicting = source({ authors: ['Alice Smith'], abstract, publication_date: '2026-10', last_checked_at: '2026-09-14T02:00:00.000Z' });
  const sources = { crossref: async () => conflicting };
  const result = await repairPaperMetadata(paper, journal, { sources, fields: ['abstract'],
    search: () => assert.fail('No search after original abstract obtained') });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.changed_fields, ['abstract']);
  assert.equal(result.paper.abstract_original, abstract);
  assert.equal(publicationFor(result.paper).publication_month, publicationFor(paper).publication_month);
  assert.equal(result.paper.publication_date, paper.publication_date);
  assert.deepEqual(result.paper.authors, paper.authors);
  const added = result.paper.source_records.at(-1);
  assert.equal(added.raw_dates.metadata_repair_excluded_dates.publication_date, '2026-10');
  assert.deepEqual(added.source_evidence, conflicting.source_evidence);
  validatePapers([result.paper], config);
  validateMetadataRepairOnlyChange([paper], [result.paper]);
});

test('月份分歧不能放宽身份：错误DOI或标题的摘要继续拒绝', async () => {
  const paper = seed({ authors: ['Alice Smith'] });
  for (const wrong of [{ doi: '10.1257/wrong' }, { title: title + ' Part Two' }]) {
    const sources = Object.fromEntries(['crossref', 'openalex', 'semanticscholar'].map(name =>
      [name, async () => source({ abstract, publication_date: '2026-10', ...wrong })]));
    const result = await repairPaperMetadata(paper, journal, { sources, fields: ['abstract'] });
    assert.equal(result.paper.abstract_original, '');
  }
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






test('账户只读诊断：仅允许枚举、数值和格式标记，禁止密钥邮箱及任意字符串', () => {
  const result = safeSerpAccountDiagnostics({ api_key: 'private-secret', account_email: 'private@example.com', account_status: 'private-secret',
    plan_monthly_price: 'private-secret', searches_per_month: 250, plan_searches_left: 250, this_month_usage: 0, extra_credits: 0,
    plan_renewal_date: '2026-10-13 00:00:00 UTC' }, at);
  assert.equal(result.verified_free_account, false); assert.equal(result.renewal_format, 'space_separated');
  assert.equal(JSON.stringify(result).includes('private'), false);
});
