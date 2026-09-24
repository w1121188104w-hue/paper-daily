import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSearchSources, searchLeads, safeSearchLink, paperSearchQuery, journalSearchQuery, searchWithFallback } from '../src/services/searchSources.js';
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
test('native filters preserve complete query and validate before network calls',async()=>{
 let payload,calls=0;
 const api=makeSearchSources({zhipuKey:'dummy-search-key',fetchImpl:async(url,init)=>{calls++;payload=JSON.parse(init.body);return response({search_result:[]});}});
 const query='Journal of Accounting Research 2026 Early View';
 await api.request({provider:'zhipu',query,searchDomainFilter:'onlinelibrary.wiley.com',searchRecencyFilter:'oneMonth'});
 assert.equal(payload.search_query,query);assert.equal(payload.search_domain_filter,'onlinelibrary.wiley.com');assert.equal(payload.search_recency_filter,'oneMonth');
 await assert.rejects(api.request({provider:'zhipu',query,searchDomainFilter:'https://example.com/path'}));
 await assert.rejects(api.request({provider:'zhipu',query,searchRecencyFilter:'unbounded'}));
 assert.equal(calls,1);
});

test('搜索来源：智谱固定官方接口，不调用聊天模型，只有显式传入密钥才请求', async () => {
  let request, calls = 0;
  const fetchImpl = async (url, init) => { calls++; request = { url, ...init }; return response({ search_result: [lead] }); };
  const missing = makeSearchSources({ fetchImpl }); await assert.rejects(missing.request({ provider: 'zhipu', query: 'test' })); assert.equal(calls, 0);
  const api = makeSearchSources({ zhipuKey: 'secret-zhipu-fixture', fetchImpl, now: () => new Date(at) });
  const result = await api.request({ provider: 'zhipu', query: 'Published research paper' });
  assert.equal(request.url, 'https://open.bigmodel.cn/api/paas/v4/web_search'); assert.equal(request.redirect, 'error');
  assert.equal(JSON.parse(request.body).search_intent, false); assert.equal(result.leads[0].requires_original_page_verification, true);
  assert.equal('abstract' in result.leads[0], false); assert.equal(JSON.stringify(result).includes('secret-zhipu-fixture'), false);
});

test('搜索来源：SerpAPI仅使用Scholar/Google，不开启续费、不购买额度', async () => {
  const urls = [], api = makeSearchSources({ serpapiKey: 'secret-serp-fixture', fetchImpl: async url => { urls.push(new URL(url));
    return response({ search_metadata: { status: 'Success' }, organic_results: [{ ...lead, snippet: lead.content }] }); } });
  for (const provider of ['serpapi_scholar', 'serpapi_google']) {
    const result = await api.request({ provider, query: 'test' }); assert.equal(result.charged, 1);
    assert.equal(JSON.stringify(result).includes('secret-serp-fixture'), false);
  }
  assert.deepEqual(urls.map(url => url.searchParams.get('engine')), ['google_scholar', 'google']);
  assert.ok(urls.every(url => url.origin === 'https://serpapi.com' && url.pathname === '/search.json'));
});

test('搜索来源：账户响应回显密钥和邮箱必须丢弃，付费方案不通过', async () => {
  const api = makeSearchSources({ serpapiKey: 'secret-serp-fixture', now: () => new Date(at), fetchImpl: async () => response({
    account_status: 'Active', plan_monthly_price: 0, searches_per_month: 250, plan_searches_left: 249,
    this_month_usage: 1, extra_credits: 0, plan_renewal_date: '2026-10-12', api_key: 'echo-secret-key', account_email: 'private@example.com' }) });
  const account = await api.account(); assert.equal(account.remaining, 249); assert.equal(account.free_plan, true);
  assert.equal(JSON.stringify(account).includes('echo-secret-key'), false); assert.equal(JSON.stringify(account).includes('private@'), false);
});

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

test('搜索来源：网络异常不重试、原始报错正文和密钥不回显，过大响应拒绝', async () => {
  let calls = 0;
  const failed = makeSearchSources({ zhipuKey: 'secret-zhipu-fixture', fetchImpl: async () => { calls++; throw new Error('echo-secret-key'); } });
  await assert.rejects(failed.request({ provider: 'zhipu', query: 'test' }), error => !String(error).includes('echo-secret-key'));
  assert.equal(calls, 1);
  const large = makeSearchSources({ zhipuKey: 'secret-zhipu-fixture', maxBytes: 10, fetchImpl: async () => response({ search_result: [lead] }) });
  await assert.rejects(large.request({ provider: 'zhipu', query: 'test' }), /SEARCH_RESPONSE_TOO_LARGE/);
});

test('安全搜索诊断：保留标准业务错误码，不保留远端消息和密钥，不重试', async () => {
  let calls = 0;
  for (const remoteCode of ['1113', 1113]) {
    const api = makeSearchSources({ zhipuKey: 'secret-zhipu-fixture', fetchImpl: async () => { calls++;
      return new Response(JSON.stringify({ error: { code: remoteCode, message: 'private-secret@example.com' }, api_key: 'secret-zhipu-fixture' }), { status: 429 }); } });
    await assert.rejects(api.request({ provider: 'zhipu', query: 'test' }), error => {
      assert.deepEqual(safeSearchDiagnostic(error, 'zhipu'), { code: 'RATE_LIMITED', http_status: 429, provider_error_code: '1113' });
      assert.doesNotMatch(String(error) + JSON.stringify(error), /private|secret|example.com/); return true;
    });
  }
  assert.equal(calls, 2); // Exactly one request per explicit test invocation.
});

test('安全搜索诊断：200中的业务错误、非JSON错误和空正文均不泄漏正文', async () => {
  for (const [body, status, code, providerCode] of [
    [JSON.stringify({ error: { code: '1002', message: 'private-secret' } }), 401, 'ACCESS_RESTRICTED', '1002'],
    [JSON.stringify({ error: { code: '1004', message: 'private-secret' } }), 401, 'ACCESS_RESTRICTED', '1004'],
    [JSON.stringify({ error: { code: '1210', message: 'private-secret' } }), 200, 'SEARCH_PROVIDER_ERROR', '1210'],
    ['<html>private-secret</html>', 502, 'SEARCH_HTTP_ERROR', null],
    [null, 403, 'ACCESS_RESTRICTED', null],
    [JSON.stringify({ error: { code: 'private-secret', message: 'private-secret' } }), 429, 'RATE_LIMITED', null]
  ]) {
    const api = makeSearchSources({ zhipuKey: 'secret-zhipu-fixture', fetchImpl: async () => new Response(body, { status }) });
    await assert.rejects(api.request({ provider: 'zhipu', query: 'test' }), error => {
      assert.deepEqual(safeSearchDiagnostic(error, 'zhipu'), { code, http_status: status, provider_error_code: providerCode });
      assert.doesNotMatch(String(error) + JSON.stringify(error), /private-secret/); return true;
    });
  }
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

test('安全搜索诊断：错误正文受大小限制，未知代码和非智谱业务代码不输出', async () => {
  const api = makeSearchSources({ zhipuKey: 'secret-zhipu-fixture', maxBytes: 20,
    fetchImpl: async () => new Response('private-secret'.repeat(20), { status: 500 }) });
  await assert.rejects(api.request({ provider: 'zhipu', query: 'test' }), error => {
    assert.equal(error.code, 'SEARCH_RESPONSE_TOO_LARGE'); assert.equal(error.http_status, 500);
    assert.doesNotMatch(JSON.stringify(error), /private-secret/); return true;
  });
  assert.deepEqual(safeSearchDiagnostic({ code: 'PRIVATE_SECRET', http_status: 'private-secret', provider_error_code: 'unknown-secret' }, 'zhipu'),
    { code: 'SEARCH_REQUEST_FAILED', http_status: null, provider_error_code: null });
  assert.equal(safeSearchDiagnostic({ provider_error_code: '1113' }, 'serpapi_google').provider_error_code, null);
  assert.equal(safeSearchDiagnostic({ provider_error_code: '9999' }, 'zhipu').provider_error_code, null);
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
