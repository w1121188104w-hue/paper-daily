import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEvidenceHttp } from '../src/services/evidenceHttp.js';
import { makeEnrichmentSources } from '../src/services/enrichmentSources.js';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';

test('429整个来源冷却，不换URL抢跑；严格尊重Retry-After，冷却后可恢复且不阻塞其他来源', async () => {
  let time = 0, calls = 0;
  const http = makeEvidenceHttp({ respectRobots: false, intervalMs: 0, now: () => time,
    fetchImpl: async url => {
      calls++;
      return url.endsWith('/first') ? new Response('', { status: 429, headers: { 'retry-after': '600' } }) : new Response('ok');
    } });
  await assert.rejects(http.request('https://a.test/first', ['a.test']), e => e.code === 'RATE_LIMITED' && e.retry_after_ms === 600000);
  time = 599999;
  await assert.rejects(http.request('https://a.test/second', ['a.test']), /RATE_LIMITED/);
  assert.equal(calls, 1);
  assert.equal((await http.request('https://b.test/second', ['b.test'])).body, 'ok');
  time = 600000;
  assert.equal((await http.request('https://a.test/second', ['a.test'])).body, 'ok');
  assert.equal(calls, 3);
});

test('没有Retry-After默认等五分钟，服务器要求更久不缩短；每轮每来源最多两次恢复尝试', async () => {
  let time = 0, calls = 0;
  const http = makeEvidenceHttp({ respectRobots: false, intervalMs: 0, now: () => time,
    fetchImpl: async () => { calls++; return new Response('', { status: 429 }); } });
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(http.request('https://a.test/paper' + attempt, ['a.test']), /RATE_LIMITED/);
    assert.equal(calls, attempt + 1);
    time += 299999;
    await assert.rejects(http.request('https://a.test/other', ['a.test']), /RATE_LIMITED/);
    assert.equal(calls, attempt + 1);
    time++;
  }
  time += 24 * 60 * 60 * 1000;
  await assert.rejects(http.request('https://a.test/still-limited', ['a.test']), /RATE_LIMITED/);
  assert.equal(calls, 3);
});

test('限流恢复仍受总请求上限保护；Retry-After日期同样不能提前请求', async () => {
  let time = Date.parse('2026-09-18T00:00:00Z'), calls = 0;
  const http = makeEvidenceHttp({ respectRobots: false, intervalMs: 0, maxRequests: 1, now: () => time,
    fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': 'Fri, 18 Sep 2026 00:10:00 GMT' } }); } });
  await assert.rejects(http.request('https://a.test/paper', ['a.test']), e => e.retry_after_ms === 600000);
  time += 600000;
  await assert.rejects(http.request('https://a.test/paper', ['a.test']), /REQUEST_LIMIT/);
  assert.equal(calls, 1);
});

test('结构化来源冷却后同一DOI可恢复，失败Promise不永久缓存；成功结果仍只查询一次', async () => {
  const journal = findJournal(await loadJournalConfig(), 'JFE');
  const paper = { doi: '10.1016/j.jfineco.2026.fixture', title_original: 'A synthetic fixture for source rate recovery' };
  let time = 0, calls = 0;
  const payload = { paperId: '1'.repeat(40), title: paper.title_original, externalIds: { DOI: paper.doi },
    publicationVenue: { issn: journal.print_issn, name: journal.name, type: 'journal' },
    journal: { name: journal.name }, authors: [{ name: 'Alice Smith' }], publicationTypes: ['JournalArticle'],
    abstract: 'Synthetic test abstract only. This text is not written to any production library.' };
  const http = makeEvidenceHttp({ respectRobots: false, intervalMs: 0, now: () => time,
    fetchImpl: async () => { calls++; return calls === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '60' } }) : new Response(JSON.stringify(payload)); } });
  const sources = makeEnrichmentSources(http, { now: () => time });
  await assert.rejects(sources.semanticscholar(paper, journal), /RATE_LIMITED/);
  time = 59999;
  await assert.rejects(sources.semanticscholar(paper, journal), /RATE_LIMITED/);
  assert.equal(calls, 1);
  time = 60000;
  const result = await sources.semanticscholar(paper, journal);
  assert.equal(result.abstract, payload.abstract); assert.equal(calls, 2);
  assert.equal((await sources.semanticscholar(paper, journal)).abstract, payload.abstract);
  assert.equal(calls, 2);
});

test('401/403不是临时限流，不自动恢复认证或访问权限', async () => {
  let time = 0, calls = 0;
  const http = makeEvidenceHttp({ respectRobots: false, intervalMs: 0, now: () => time,
    fetchImpl: async () => { calls++; return new Response('', { status: 403 }); } });
  const sources = makeEnrichmentSources(http, { now: () => time });
  const paper = { doi: '10.1016/j.jfineco.2026.fixture' };
  await assert.rejects(sources.semanticscholar(paper, {}), /ACCESS_RESTRICTED/);
  time += 3600000;
  await assert.rejects(sources.semanticscholar(paper, {}), /ACCESS_RESTRICTED/);
  assert.equal(calls, 1);
});
