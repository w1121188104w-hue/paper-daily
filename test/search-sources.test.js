import test from 'node:test';
import assert from 'node:assert/strict';
import { searchLeads, safeSearchLink, paperSearchQuery, journalSearchQuery, searchWithFallback } from '../src/services/searchSources.js';
import { safeSearchDiagnostic, safeSearchCredentialCheck } from '../src/services/searchDiagnostics.js';
test('搜索诊断区分接口、来源过滤和页面错误，禁止输出任意错误正文或链接', async () => {
  const result = await searchWithFallback({ queryFor: () => 'test', search: async ({ provider }) => provider === 'zhipu' ?
    { called: true, diagnostic: { code: 'TIMEOUT', http_status: null, message: 'secret' } } :
    { called: true, result: { leads: [{ url: 'https://example.com/secret' }, { url: 'https://example.org/' }] } },
    verifyLead: async lead => {
      if (lead.url.includes('example.com')) return { resolved: false, reason: 'NOT_OFFICIAL_HOST' };
      throw Object.assign(new Error('secret body'), { code: 'ROBOTS_DISALLOWED' });
    } });
  assert.equal(result.attempts[0].stage, 'search_response');
  assert.equal(result.attempts[0].diagnostic.code, 'TIMEOUT');
  assert.deepEqual(result.attempts[1].lead_statuses, { NOT_OFFICIAL_HOST: 1, ROBOTS_DISALLOWED: 1 });
  assert.equal(result.attempts[1].leads_returned, 2);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
const at = '2026-09-12T01:00:00.000Z';
const response = data => new Response(JSON.stringify(data));
const lead = { title: 'Published research paper', link: 'https://www.aeaweb.org/articles?id=10.1257/example', content: 'This is a search snippet, not an original abstract.' };




test('搜索来源：搜索片段不产生Abstract，AI概括字段一律忽略', () => {
  const rows = searchLeads({ search_result: [{ ...lead, abstract: 'invented', summary: 'invented' }] }, 'zhipu');
  assert.equal(rows.length, 1); assert.equal('abstract' in rows[0], false); assert.equal('summary' in rows[0], false);
  assert.equal(rows[0].snippet, lead.content);
});

test('搜索来源：不接受本机地址、认证信息、密钥链接或非HTTPS', () => {
  for (const url of ['http://example.com', 'https://127.0.0.1/a', 'https://localhost/a', 'https://[::1]/a',
    'https://user:pass@example.com/a', 'https://example.com/a?api_key=secret', 'javascript:alert(1)']) assert.equal(safeSearchLink(url), null);
});

test('搜索查询：长标题适配智谱70字上限，原始标题不被修改，支持期刊月份查询', () => {
  const paper = { title: 'A very long research title about international trade and financial markets in developing economies and institutions' };
  const before = paper.title;
  assert.ok(paperSearchQuery(paper, 'zhipu').length <= 70); assert.equal(paper.title, before);
  assert.equal(paperSearchQuery({ doi: '10.1234/test' }, 'zhipu'), '10.1234/test');
  assert.equal(paperSearchQuery({ doi: '10.1234/test', title: 'A complete paper title' }, 'zhipu'), 'A complete paper title');
  assert.equal(paperSearchQuery({ doi: '10.1234/test', title: 'A complete paper title' }, 'serpapi_scholar'), '10.1234/test');
  assert.equal(paperSearchQuery({ doi: '10.1234/test', title: 'A complete paper title' }, 'serpapi_google'), '"A complete paper title"');
  assert.match(journalSearchQuery({ name: 'American Economic Review' }, '2026-09', 'zhipu'), /2026-09/);
});




test('密钥格式诊断：只输出固定枚举与是否误用同一个密钥，不泄漏任何片段', () => {
  for (const [key, format] of [['', 'missing'], ['private secret', 'contains_whitespace'], ['"private-secret"', 'wrapped_in_quotes'],
    ['https://example.com/private-secret', 'url_instead_of_key'], ['private-***-secret', 'possibly_masked'],
    ['private-id.private-secret', 'id_secret_pair'], ['private-id.private-secret.private-signature', 'jwt_like'], ['private-secret', 'opaque']]) {
    const result = safeSearchCredentialCheck({ zhipuKey: key, serpapiKey: 'different-secret' });
    assert.deepEqual(result, { format, same_as_serpapi_key: false });
    assert.doesNotMatch(JSON.stringify(result), /private-|example.com|signature/);
  }
  assert.equal(safeSearchCredentialCheck({ zhipuKey: 'same-private-key', serpapiKey: 'same-private-key' }).same_as_serpapi_key, true);
});


test('搜索顺序：智谱查到已核实原文即停，否则Scholar再Google', async () => {
  const visited = [], evidence = { resolved: true, record: { title: 'Verified paper', source_evidence: { url: lead.link } } };
  const result = await searchWithFallback({ queryFor: () => 'test', search: async ({ provider }) => { visited.push(provider);
    return { called: true, result: { leads: provider === 'serpapi_google' ? [lead] : [] } }; }, verifyLead: async () => evidence });
  assert.deepEqual(visited, ['zhipu', 'serpapi_scholar', 'serpapi_google']); assert.equal(result.status, 'resolved');
  visited.length = 0;
  await searchWithFallback({ queryFor: () => 'test', search: async ({ provider }) => { visited.push(provider); return { called: true, result: { leads: [lead] } }; }, verifyLead: async () => evidence });
  assert.deepEqual(visited, ['zhipu']);
});

test('搜索顺序：只有页面线索或只解决其他字段，不得冒充当前问题已解决', async () => {
  const result = await searchWithFallback({ queryFor: () => 'test', search: async () => ({ called: true, result: { leads: [lead] } }),
    verifyLead: async () => ({ resolved: false, url: lead.link }) });
  assert.equal(result.status, 'not_found'); assert.equal(result.confirmed, null);
});

test('搜索顺序：免费额度耗尽不再调用第二个SerpAPI引擎，不标成not_found', async () => {
  const calls = [];
  const result = await searchWithFallback({ queryFor: () => 'test', search: async ({ provider }) => { calls.push(provider);
    return provider === 'zhipu' ? { called: true, result: { leads: [] } } : { called: false, reason: 'quota_exhausted' }; }, verifyLead: async () => null });
  assert.equal(result.status, 'quota_exhausted'); assert.deepEqual(calls, ['zhipu', 'serpapi_scholar']);
});

test('搜索顺序：来源异常可继续后续来源，全流程有未查成项则不声称查完未找到', async () => {
  const result = await searchWithFallback({ queryFor: () => 'test', search: async ({ provider }) => {
    if (provider === 'zhipu') throw new Error('unavailable'); return { called: true, result: { leads: [] } }; }, verifyLead: async () => null });
  assert.equal(result.status, 'source_unavailable'); assert.equal(result.attempts.length, 3);
});
