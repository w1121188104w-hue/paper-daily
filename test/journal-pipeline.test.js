import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJournalConfig, validateJournalConfig, isValidIssn, findJournal } from '../src/services/journals.js';
import { normalizeDoi, normalizeSourceRecord, cleanText, normalizePartialDate } from '../src/services/paperModel.js';
import { normalizeOpenAlexWork, normalizeCrossrefWork, abstractFromInvertedIndex } from '../src/services/sourceNormalizers.js';
import { mergePapers, dateInShanghai } from '../src/services/paperMerge.js';
import { requestSourceJson, retryAfterMs } from '../src/services/sourceHttp.js';
import { fetchOpenAlexJournal, buildOpenAlexUrl } from '../src/services/openalex.js';
import { fetchCrossrefJournal, buildCrossrefUrl } from '../src/services/crossref.js';
import { collectJournals } from '../src/services/collectJournals.js';
import { parseJournalArgs, runJournalCommand } from '../scripts/journals.js';

const config = await loadJournalConfig();
const journal = findJournal(config, 'AER');
const timestamp = '2026-09-07T01:00:00.000Z';
const mergeOptions = { checkedAt: timestamp, firstSeenDate: '2026-09-07' };
const requestOptions = { fromDate: '2026-07-10', toDate: '2026-09-07', checkedAt: timestamp,
  pageSize: 2, sleep: async () => {}, maxAttempts: 1 };

function record(source = 'openalex', overrides = {}) {
  return normalizeSourceRecord({ source, source_id: source === 'openalex' ? 'W1' : '10.1234/example',
    doi: '10.1234/example', title: 'Credit markets and firm investment',
    abstract: '', authors: [{ name: 'Alice Smith', orcid: '' }, { name: 'Bob Jones', orcid: '' }],
    journal_key: journal.key, journal_name: journal.name, journal_category: journal.category,
    print_issn: journal.print_issn, electronic_issn: journal.electronic_issn,
    publication_date: '2026-08-01', last_checked_at: timestamp, ...overrides });
}

function oaWork(id = 'W1', overrides = {}) {
  return { id: `https://openalex.org/${id}`, doi: 'https://doi.org/10.1234/example',
    title: 'Credit markets and firm investment', publication_date: '2026-08-01',
    primary_location: { source: { id: `https://openalex.org/${journal.openalex_source_id}`, issn: [journal.print_issn] } },
    authorships: [{ author: { display_name: 'Alice Smith', orcid: null } }], ...overrides };
}

function crWork(doi = '10.1234/example', overrides = {}) {
  return { DOI: doi, title: ['Credit markets and firm investment'], ISSN: [journal.print_issn],
    author: [{ given: 'Alice', family: 'Smith' }], type: 'journal-article',
    'published-online': { 'date-parts': [[2026, 8, 1]] }, ...overrides };
}

const jsonResponse = (payload) => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
const oaPage = (items, cursor = null, count = items.length) => ({ meta: { count, next_cursor: cursor }, results: items });
const crPage = (items, cursor = 'next', count = items.length) => ({ status: 'ok', message: { items, 'next-cursor': cursor, 'total-results': count } });

test('19刊名单、分类、ISSN校验位、唯一ID及例外缩写正确', () => {
  assert.equal(config.journals.length, 19);
  assert.deepEqual(config.journals.map((j) => j.key), ['TAR','AOS','JAR','JAE','CAR','RAS','AER','JPE','QJE','RES','JF','JFE','RFS','JCF','JIBS','RP','MS','JM','JOM']);
  assert.equal(findJournal(config, 'JM').name, 'Journal of Management');
  assert.equal(findJournal(config, 'JOM').name, 'Journal of Operations Management');
  assert.equal(findJournal(config, 'AR'), null);
  assert.equal(isValidIssn('0002-8282'), true);
  assert.equal(isValidIssn('0002-8283'), false);
  const bad = structuredClone(config);
  bad.journals[1].openalex_source_id = bad.journals[0].openalex_source_id;
  assert.throws(() => validateJournalConfig(bad), /重复/);
});

test('DOI规范化和JATS清洗保留数值、变量和英文原始字段', () => {
  assert.equal(normalizeDoi(' DOI: https://doi.org/10.1234/Ab C '), '10.1234/abc');
  const paper = normalizeCrossrefWork(crWork(undefined, { abstract: '<jats:p>Abstract</jats:p><jats:p>R<sub>it</sub> &amp; profit &gt; 0 in 2001–2020.</jats:p> © 2026 Publisher. All rights reserved.' }), journal, timestamp);
  assert.equal(paper.abstract, 'Rit & profit > 0 in 2001–2020.');
  assert.match(paper.raw_abstract, /<jats:p>/);
  assert.doesNotThrow(() => cleanText('&#999999999999;'));
  assert.equal(cleanText('&lt;p&gt;Value&lt;/p&gt;'), 'Value');
});

test('保留不完整日期精度，不将普通出版日期冒充在线日期', () => {
  const paper = normalizeCrossrefWork(crWork(undefined, { 'published-online': undefined,
    published: { 'date-parts': [[2025]] }, 'published-print': { 'date-parts': [[2026, 8]] } }), journal);
  assert.equal(paper.published_online_date, '');
  assert.equal(paper.published_print_date, '2026-08');
  assert.equal(paper.publication_date, '2025');
  assert.equal(normalizeOpenAlexWork(oaWork(), journal).published_online_date, '');
  assert.equal(normalizePartialDate('2026-02-30'), '');
  assert.equal(normalizePartialDate('2026-13'), '');
});

test('来源期刊标识缺失、冲突和无效DOI必须拒收', () => {
  assert.throws(() => normalizeOpenAlexWork(oaWork(undefined, { primary_location: {} }), journal), /不匹配/);
  assert.throws(() => normalizeOpenAlexWork(oaWork(undefined, { primary_location: { source: { id: 'S999' } } }), journal), /不匹配/);
  assert.throws(() => normalizeCrossrefWork(crWork(undefined, { ISSN: [] }), journal), /不匹配/);
  assert.throws(() => normalizeCrossrefWork(crWork(undefined, { ISSN: ['0021-8456'] }), journal), /不匹配/);
  assert.throws(() => record('crossref', { doi: 'not-a-doi' }), /DOI/);
});

test('OpenAlex倒排摘要按单词位置恢复且异常位置被拒绝', () => {
  assert.equal(abstractFromInvertedIndex({ firms: [1, 3], We: [0], study: [2] }), 'We firms study firms');
  assert.equal(abstractFromInvertedIndex(null), '');
  assert.throws(() => abstractFromInvertedIndex({ bad: [1e9] }), /位置/);
});

test('T01/T02：双源同DOI合并，Crossref补摘要并记录来源，输入不被修改', () => {
  const inputs = [record(), record('crossref', { abstract: 'We find that credit supply affects firm investment.' })];
  const original = structuredClone(inputs);
  const result = mergePapers(inputs, mergeOptions);
  assert.equal(result.papers.length, 1);
  const paper = result.papers[0];
  assert.deepEqual(paper.sources, ['crossref', 'openalex']);
  assert.equal(paper.abstract_original, inputs[1].abstract);
  assert.equal(paper.provenance.abstract_original.source, 'crossref');
  assert.equal(paper.abstract_translation_status, 'pending');
  assert.equal(paper.source_records.length, 2);
  assert.deepEqual(inputs, original);
  assert.deepEqual(result, mergePapers([...inputs].reverse(), mergeOptions));
});

test('T05：重复执行不重复论文、首次发现日期、原文记录或待翻译标记', () => {
  const inputs = [record(), record('crossref', { abstract: 'Abstract text here.' })];
  const first = mergePapers(inputs, mergeOptions);
  const next = mergePapers([...inputs, ...inputs], { ...mergeOptions, existingPapers: first.papers,
    firstSeenDate: '2026-09-08', checkedAt: '2026-09-08T01:00:00.000Z' });
  assert.equal(next.papers.length, 1);
  assert.equal(next.papers[0].first_seen_date, '2026-09-07');
  assert.equal(next.papers[0].source_records.length, 2);
  assert.deepEqual(next.stats, { added: 0, updated: 0, unchanged: 1, new_pending_fields: 0 });
});

test('T06：摘要补齐仅修改摘要状态；标题译文保留且不重新排队', () => {
  const first = mergePapers([record()], mergeOptions).papers;
  first[0].title_zh = '信贷市场与企业投资';
  first[0].title_translation_status = 'done';
  const result = mergePapers([record('crossref', { abstract: 'Credit supply drives investment.' })],
    { ...mergeOptions, firstSeenDate: '2026-09-08', existingPapers: first });
  assert.equal(result.papers[0].title_translation_status, 'done');
  assert.equal(result.papers[0].abstract_translation_status, 'pending');
  assert.equal(result.papers[0].first_seen_date, '2026-09-07');
  assert.equal(result.stats.new_pending_fields, 1);
});

test('同源缩短的标题修正被采用；旧译文保留并标记outdated', () => {
  const first = mergePapers([record()], mergeOptions).papers;
  first[0].title_zh = '旧译文'; first[0].title_translation_status = 'done';
  const next = mergePapers([record('openalex', { title: 'Credit markets', last_checked_at: '2026-09-08T01:00:00.000Z' })],
    { ...mergeOptions, existingPapers: first });
  assert.equal(next.papers[0].title_original, 'Credit markets');
  assert.equal(next.papers[0].title_zh, '旧译文');
  assert.equal(next.papers[0].title_translation_status, 'outdated');
  assert.equal(next.papers[0].source_records.length, 2);
});

test('后续来源缺字段，不删除已获得的摘要', () => {
  const first = mergePapers([record('openalex', { abstract: 'Known abstract.' })], mergeOptions).papers;
  const next = mergePapers([record('openalex', { last_checked_at: '2026-09-08T01:00:00.000Z' })],
    { ...mergeOptions, existingPapers: first });
  assert.equal(next.papers[0].abstract_original, 'Known abstract.');
});

test('无DOI时标题标点差异+第一作者+年份可靠匹配', () => {
  const result = mergePapers([record('openalex', { doi: '', title: 'Credit markets: and firm investment' }),
    record('crossref', { doi: '', title: 'Credit markets—and firm investment' })], mergeOptions);
  assert.equal(result.papers.length, 1);
  assert.match(result.papers[0].id, /^fp:/);
});

test('DOI后补保持稳定ID和首次发现日期', () => {
  const first = mergePapers([record('openalex', { doi: '' })], mergeOptions).papers;
  const next = mergePapers([record('crossref')], { ...mergeOptions, existingPapers: first });
  assert.equal(next.papers.length, 1);
  assert.equal(next.papers[0].id, first[0].id);
  assert.equal(next.papers[0].doi, '10.1234/example');
});

test('相似标题及作者只能进入疑似重复，不强行合并', () => {
  const result = mergePapers([record('openalex', { doi: '' }), record('crossref', { doi: '',
    title: 'Credit markets and firm investment decisions' })], mergeOptions);
  assert.equal(result.papers.length, 2);
  assert.equal(result.audit[0].type, 'suspected_duplicate');
});

test('不同DOI的同标题记录分开，疑似无DOI桥接不能将其合并', () => {
  const inputs = [record('openalex', { doi: '10.1234/a', source_id: 'W1' }),
    record('crossref', { doi: '10.1234/b', source_id: '10.1234/b' }),
    record('openalex', { doi: '', source_id: 'W3' })];
  const first = mergePapers(inputs, mergeOptions);
  assert.equal(first.papers.length, 3);
  assert.ok(first.audit.some((row) => row.type === 'doi_conflict'));
  assert.ok(first.audit.some((row) => row.type === 'ambiguous_match'));
  assert.equal(mergePapers(inputs, { ...mergeOptions, existingPapers: first.papers }).papers.length, 3);
});

test('同DOI跨期刊冲突隔离并记录，不收敛成一条', () => {
  const result = mergePapers([record(), record('crossref', { journal_key: 'JAR', journal_name: 'Journal of Accounting Research' })], mergeOptions);
  assert.equal(result.papers.length, 2);
  assert.equal(new Set(result.papers.map((p) => p.id)).size, 2);
  assert.equal(result.audit[0].type, 'journal_conflict');
});

test('作者顺序保持，不拼入身份不明的第三位作者；精确姓名补ORCID', () => {
  const result = mergePapers([record(), record('crossref', { authors: [
    { name: 'Alice Smith', orcid: 'https://orcid.org/0000-0002-1825-0097' }
  ] })], mergeOptions);
  assert.deepEqual(result.papers[0].authors.map((a) => a.name), ['Alice Smith', 'Bob Jones']);
  assert.equal(result.papers[0].authors[0].orcid, '0000-0002-1825-0097');
  assert.equal(result.papers[0].provenance.authors[0].orcid, 'crossref');
});

test('没有任何新数据时，历史论文完整保留', () => {
  const papers = mergePapers([record()], mergeOptions).papers;
  assert.deepEqual(mergePapers([], { ...mergeOptions, existingPapers: papers }).papers, papers);
});

test('日历首次发现时间按北京时间跨日', () => {
  assert.equal(dateInShanghai(new Date('2026-09-06T16:01:00Z')), '2026-09-07');
});

test('查询使用精确source ID/ISSN、日期和游标，不含密钥', () => {
  const oa = buildOpenAlexUrl(journal, requestOptions);
  const cr = buildCrossrefUrl(journal, requestOptions);
  assert.match(oa.searchParams.get('filter'), /primary_location.source.id:S23254222/);
  assert.equal(oa.searchParams.get('cursor'), '*');
  assert.equal(cr.pathname, '/journals/0002-8282/works');
  assert.match(cr.searchParams.get('filter'), /from-pub-date:2026-07-10/);
  assert.equal(oa.searchParams.has('api_key'), false);
});

test('OpenAlex读取后续页，保留每页原始结果', async () => {
  const urls = [];
  const pages = [oaPage([oaWork('W1'), oaWork('W2')], 'cursor2', 3), oaPage([oaWork('W3')])];
  const result = await fetchOpenAlexJournal(journal, { ...requestOptions,
    fetchImpl: async (url) => { urls.push(url); return jsonResponse(pages.shift()); } });
  assert.equal(result.ok, true); assert.equal(result.raw_count, 3);
  assert.equal(result.raw_pages.length, 2);
  assert.equal(urls[1].searchParams.get('cursor'), 'cursor2');
});

test('Crossref游标可不变，持续读取直至不足一页', async () => {
  const pages = [crPage([crWork('10.1234/a'), crWork('10.1234/b')], 'same'),
    crPage([crWork('10.1234/c'), crWork('10.1234/d')], 'same'), crPage([])];
  const result = await fetchCrossrefJournal(journal, { ...requestOptions, fetchImpl: async () => jsonResponse(pages.shift()) });
  assert.equal(result.complete, true); assert.equal(result.raw_count, 4);
  assert.equal(result.raw_pages.length, 3);
});

test('第二页失败保留第一页，但不声称采集成功', async () => {
  let calls = 0;
  const result = await fetchOpenAlexJournal(journal, { ...requestOptions,
    fetchImpl: async () => ++calls === 1 ? jsonResponse(oaPage([oaWork()], 'next', 2)) : new Response('', { status: 503 }) });
  assert.equal(result.ok, false); assert.equal(result.complete, false);
  assert.equal(result.records.length, 1);
  assert.equal(result.error.code, 'HTTP_ERROR');
});

test('截断、重复页、结构错误和记录校验失败都不能显示没有新增', async () => {
  const capped = await fetchOpenAlexJournal(journal, { ...requestOptions, maxPages: 1,
    fetchImpl: async () => jsonResponse(oaPage([oaWork()], 'next', 2)) });
  assert.equal(capped.error.code, 'PAGE_LIMIT');
  const repeated = await fetchCrossrefJournal(journal, { ...requestOptions,
    fetchImpl: async () => jsonResponse(crPage([crWork(), crWork('10.1234/b')])) });
  assert.equal(repeated.error.code, 'REPEATED_PAGE');
  const invalid = await fetchOpenAlexJournal(journal, { ...requestOptions, fetchImpl: async () => jsonResponse({}) });
  assert.equal(invalid.error.code, 'INVALID_RESPONSE');
  const rejected = await fetchCrossrefJournal(journal, { ...requestOptions,
    fetchImpl: async () => jsonResponse(crPage([crWork(undefined, { ISSN: ['9999-9999'] })])) });
  assert.equal(rejected.ok, false); assert.equal(rejected.rejected.length, 1);
});

test('HTTP 429遵守Retry-After；500递增重试；错误不泄露响应正文', async () => {
  const waits = []; let calls = 0;
  const result = await requestSourceJson(new URL('https://example.org'), { sleep: async (ms) => waits.push(ms),
    fetchImpl: async () => ++calls === 1 ? new Response('secret text', { status: 429, headers: { 'Retry-After': '2' } })
      : calls === 2 ? new Response('secret text', { status: 500 }) : jsonResponse({ ok: true }) });
  assert.deepEqual(waits, [2000, 2000]); assert.deepEqual(result, { ok: true });
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs('Mon, 07 Sep 2026 01:00:05 GMT', Date.parse(timestamp)), 5000);
  await assert.rejects(requestSourceJson(new URL('https://example.org'), {
    fetchImpl: async () => new Response('secret text', { status: 401 }) }), (error) => !error.message.includes('secret') && error.code === 'HTTP_ERROR');
});

test('长时间限流、网络错误和超时有界退出', async () => {
  await assert.rejects(requestSourceJson(new URL('https://example.org'), {
    fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }) }), { code: 'RETRY_LATER' });
  let calls = 0;
  await assert.rejects(requestSourceJson(new URL('https://example.org'), { sleep: async () => {},
    fetchImpl: async () => { calls++; throw new Error('secret connection information'); } }), { code: 'NETWORK_ERROR' });
  assert.equal(calls, 3);
  await assert.rejects(requestSourceJson(new URL('https://example.org'), { timeoutMs: 5, maxAttempts: 1,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('abort')));
    }) }), { code: 'TIMEOUT' });
});

function clientResult(source, records = [], ok = true) {
  return { source, journal_key: journal.key, records, ok, complete: ok, raw_count: records.length,
    raw_pages: [], rejected: [], duration_ms: 0, error: ok ? null : { code: 'TEST_FAILURE' } };
}

test('T03/T08：不配置密钥，始终查询两源；一方失败另一方入库并标为partial_failure', async () => {
  const calls = [];
  const result = await collectJournals(config, { ...requestOptions, ...mergeOptions, journalKey: 'AER', clients: {
    openalex: async () => { calls.push('openalex'); return clientResult('openalex', [record()]); },
    crossref: async () => { calls.push('crossref'); throw new Error('failed'); }
  } });
  assert.deepEqual(calls, ['openalex', 'crossref']);
  assert.equal(result.status, 'partial_failure');
  assert.equal(result.papers.length, 1);
  assert.equal(result.papers[0].title_translation_status, 'pending');
  assert.equal(result.papers[0].abstract_translation_status, 'no_abstract');
});

test('T04：两源均失败保留历史；均成功但无变化才是no_updates', async () => {
  const existing = mergePapers([record()], mergeOptions).papers;
  const options = { ...requestOptions, ...mergeOptions, journalKey: 'AER', existingPapers: existing };
  const failed = await collectJournals(config, { ...options, clients: {
    openalex: async () => clientResult('openalex', [], false), crossref: async () => clientResult('crossref', [], false)
  } });
  assert.equal(failed.status, 'full_failure'); assert.deepEqual(failed.papers, existing);
  const empty = await collectJournals(config, { ...options, clients: {
    openalex: async () => clientResult('openalex'), crossref: async () => clientResult('crossref')
  } });
  assert.equal(empty.status, 'no_updates');
});

test('19刊每刊各查两源，部分期刊失败会反映总体状态', async () => {
  const calls = [];
  const result = await collectJournals(config, { ...requestOptions, ...mergeOptions, clients: {
    openalex: async (j) => { calls.push(j.key); return { ...clientResult('openalex'), journal_key: j.key }; },
    crossref: async (j) => ({ ...clientResult('crossref', [], j.key !== 'JOM'), journal_key: j.key })
  } });
  assert.equal(calls.length, 19); assert.equal(result.source_results.length, 38);
  assert.equal(result.status, 'partial_failure');
});

test('配置拒绝夹杂字母的ISSN和会造成查找失败的非规范key', () => {
  assert.equal(isValidIssn('text0002-8282'), false);
  const bad = structuredClone(config);
  bad.journals[0].key = ' tar ';
  assert.throws(() => validateJournalConfig(bad), /规范格式/);
});

test('多个无DOI歧义记录的指纹冲突不使整轮失败，重复执行保持ID', () => {
  const inputs = [record('openalex', { doi: '10.1234/a' }),
    record('crossref', { doi: '10.1234/b', source_id: '10.1234/b' }),
    ...['W3', 'W4', 'W5'].map((source_id) => record('openalex', { doi: '', source_id }))];
  const first = mergePapers(inputs, mergeOptions);
  assert.equal(first.papers.length, 5);
  assert.equal(new Set(first.papers.map((p) => p.id)).size, 5);
  const second = mergePapers(inputs, { ...mergeOptions, existingPapers: first.papers });
  assert.deepEqual(second.papers.map((p) => p.id), first.papers.map((p) => p.id));
  assert.equal(second.stats.added, 0);
});

test('下载JSON正文期间超时同样重试，不误报格式错误', async () => {
  let calls = 0;
  const result = await requestSourceJson(new URL('https://example.org'), { timeoutMs: 5, sleep: async () => {},
    fetchImpl: async (_url, { signal }) => {
      calls++;
      return calls > 1 ? jsonResponse({ ok: true }) : { ok: true,
        json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')))) };
    } });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test('离线检查命令不会调用采集；联网必须明确选刊和日期', async () => {
  assert.deepEqual(parseJournalArgs([]), { collect: false });
  assert.throws(() => parseJournalArgs(['--collect']), /指定/);
  assert.throws(() => parseJournalArgs(['--collect', '--journal', 'AER']), /日期/);
  assert.throws(() => parseJournalArgs(['--collect', '--all', '--journal', 'AER']), /不能/);
  assert.throws(() => parseJournalArgs(['--collect', '--all', '--from', '2026-09-07', '--to', '2026-08-01']), /日期/);
  const logs = [];
  const exitCode = await runJournalCommand([], { log: (line) => logs.push(line),
    collect: () => { throw new Error('离线命令不应联网'); } });
  assert.equal(exitCode, 0);
  assert.match(logs[0], /19 本期刊/);
});

test('联网试抓只报告概况，部分失败返回非零退出码', async () => {
  const logs = [];
  const args = ['--collect', '--journal', 'AER', '--from', '2026-08-01', '--to', '2026-08-31', '--max-pages', '2'];
  const exitCode = await runJournalCommand(args, { log: (line) => logs.push(line), collect: async (_config, options) => {
    assert.equal(options.journalKey, 'AER'); assert.equal(options.maxPages, 2);
    return { status: 'partial_failure', papers: [], audit: [], stats: {},
      source_results: [clientResult('openalex'), clientResult('crossref', [], false)] };
  } });
  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(logs[1]).mode, 'dry_run');
  assert.match(logs.at(-1), /没有写入正式论文库/);
});
