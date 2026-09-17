import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { buildSemanticScholarUrl, fetchSemanticScholarJournal, semanticScholarJournalMatches } from '../src/services/semanticScholar.js';
import { requestSourceJson } from '../src/services/sourceHttp.js';

const journal = findJournal(await loadJournalConfig(), 'AER'), at = '2026-09-12T01:00:00.000Z';
const options = { fromDate: '2026-07-15', toDate: '2026-09-12', checkedAt: at, maxAttempts: 1, sleep: async () => {} };
const item = (id = 'a', patch = {}) => ({ paperId: id.repeat(40), title: 'A scholarly paper', journal: { name: journal.name },
  venue: journal.name, publicationVenue: { type: 'journal', name: journal.name, issn: journal.print_issn },
  authors: [{ name: 'Alice Smith' }], year: 2026, publicationDate: '2026-08-21', externalIds: { DOI: `10.1234/${id}` }, ...patch });
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('JAR：正确ISSN不能覆盖文章自身的错刊名称；已核实印尼DOI始终拒收', async () => {
  const jar = findJournal(await loadJournalConfig(), 'JAR');
  const work = { journal: { name: jar.name }, venue: jar.name,
    publicationVenue: { name: jar.name, issn: '00218456', type: 'journal' }, externalIds: { DOI: '10.1111/1475-679x.12345' } };
  assert.equal(semanticScholarJournalMatches(work, jar), true);
  assert.equal(semanticScholarJournalMatches({ ...work, journal: { name: 'Journal Dialectica (Journal of Accounting Research)' } }, jar), false);
  assert.equal(semanticScholarJournalMatches({ ...work, externalIds: { DOI: '10.67983/journaldialectica.v1i2.100' } }, jar), false);
  assert.equal(semanticScholarJournalMatches({ ...work, publicationVenue: { issn: '3163-821X' } }, jar), false);
  assert.equal(semanticScholarJournalMatches({ ...work, publicationVenue: { issn: '1475-679x' } }, jar), true);
});

test('S2独立发现：按期刊与年份检索，不依赖已有DOI；跨年范围正确', () => {
  const url = buildSemanticScholarUrl(journal, options);
  assert.equal(url.searchParams.get('venue'), journal.name); assert.equal(url.searchParams.get('year'), '2026');
  assert.equal(url.searchParams.has('query'), false); assert.equal(url.searchParams.has('publicationDateOrYear'), false);
  assert.equal(buildSemanticScholarUrl(journal, { fromDate: '2025-12-15', toDate: '2026-02-01' }).searchParams.get('year'), '2025-2026');
});

test('S2：AOS期刊名称中的逗号不能被当作两本期刊的分隔符', async () => {
  const aos = findJournal(await loadJournalConfig(), 'AOS');
  const url = buildSemanticScholarUrl(aos, options);
  assert.equal(url.searchParams.get('venue'), 'Accounting Organizations and Society');
});

test('S2分页：持续令牌读取全部页面，年度原始页保留但已知窗口外不入库', async () => {
  const calls = [], pages = [{ total: 3, token: 'next-page', data: [item('a'), item('b', { publicationDate: '2026-01-01' })] },
    { total: 3, data: [item('c', { publicationDate: null, year: 2026, externalIds: {} })] }];
  const result = await fetchSemanticScholarJournal(journal, { ...options, fetchImpl: async url => { calls.push(String(url)); return response(pages.shift()); } });
  assert.equal(result.ok, true); assert.equal(result.complete, true); assert.equal(result.raw_count, 3); assert.equal(result.records.length, 2);
  assert.equal(result.records[1].doi, ''); assert.equal(result.records[1].publication_date, '2026');
  assert.equal(new URL(calls[1]).searchParams.get('token'), 'next-page'); assert.equal(result.raw_pages.length, 2);
  assert.equal(result.records[0].source_evidence.method, 'semanticscholar_discovery_api');
});

test('S2：错刊ISSN、会议、坏DOI、缺标题保留原始页但拒收，成功不能虚报', async () => {
  const bad = [item('a', { publicationVenue: { type: 'journal', issn: '0021-8456', name: journal.name } }),
    item('b', { publicationVenue: { type: 'conference', issn: journal.print_issn } }),
    item('c', { externalIds: { DOI: 'bad' } }), item('d', { title: '' })];
  const result = await fetchSemanticScholarJournal(journal, { ...options, fetchImpl: async () => response({ total: bad.length, data: bad }) });
  assert.equal(result.ok, false); assert.equal(result.complete, true); assert.equal(result.records.length, 0);
  assert.equal(result.rejected.length, 4); assert.equal(result.error.code, 'INVALID_RECORDS'); assert.equal(result.raw_pages[0].data.length, 4);
});

test('S2：无ISSN即使刊名完全相同也保留待核实原始页，不进入正式名册', async () => {
  const result = await fetchSemanticScholarJournal(journal, { ...options, fetchImpl: async () => response({ total: 2, data: [
    item('a', { publicationVenue: null, journal: { name: 'The American Economic Review' } }),
    item('b', { publicationVenue: null, journal: { name: 'Wrong Journal' }, venue: 'Wrong Journal' })] }) });
  assert.equal(result.records.length, 0); assert.equal(result.rejected.length, 2); assert.equal(result.raw_pages.length, 1);
});

test('S2：页数上限、重复页、坏结构都明确报告不完整', async () => {
  const incomplete = await fetchSemanticScholarJournal(journal, { ...options, maxPages: 1, fetchImpl: async () => response({ total: 2, token: 'next', data: [item()] }) });
  assert.equal(incomplete.complete, false); assert.equal(incomplete.error.code, 'PAGE_LIMIT');
  const repeat = await fetchSemanticScholarJournal(journal, { ...options, fetchImpl: async () => response({ total: 2, token: 'next', data: [item()] }) });
  assert.equal(repeat.error.code, 'REPEATED_PAGE');
  const invalid = await fetchSemanticScholarJournal(journal, { ...options, fetchImpl: async () => response({ total: 2 }) });
  assert.equal(invalid.error.code, 'INVALID_RESPONSE');
});

test('S2：密钥只进入固定主机请求头，禁止携带密钥跳转且不写进证据', async () => {
  let request;
  const result = await fetchSemanticScholarJournal(journal, { ...options, semanticScholarKey: 'secret-test-key',
    fetchImpl: async (url, init) => { request = { url: String(url), ...init }; return response({ total: 1, data: [item()] }); } });
  assert.equal(request.headers['x-api-key'], 'secret-test-key'); assert.equal(request.redirect, 'error');
  assert.equal(new URL(request.url).hostname, 'api.semanticscholar.org'); assert.equal(JSON.stringify(result).includes('secret-test-key'), false);
  await assert.rejects(requestSourceJson('https://api.crossref.org/works', { requestHeaders: { 'x-api-key': 'secret-test-key' }, fetchImpl: async () => { throw new Error('must not call'); } }));
});

test('S2：429与长Retry-After不伪装成没有论文，也不回显敏感响应', async () => {
  const result = await fetchSemanticScholarJournal(journal, { ...options, fetchImpl: async () => new Response('private-error-secret', { status: 429, headers: { 'retry-after': '600' } }) });
  assert.equal(result.ok, false); assert.equal(result.complete, false); assert.equal(result.error.code, 'RETRY_LATER');
  assert.equal(JSON.stringify(result).includes('private-error-secret'), false);
});
