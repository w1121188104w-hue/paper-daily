import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSearchSources } from '../src/services/searchSources.js';
import { verifiedSearchRecord } from '../src/services/searchExtraction.js';
import { publisherReaderProbe } from '../scripts/publisher-reader-probe.js';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { safeSearchDiagnostic } from '../src/services/searchDiagnostics.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'JFE');
const url = 'https://www.sciencedirect.com/science/article/pii/S0304405X26001236';
const paper = { doi: '10.1016/j.jfineco.2026.104352', title_original: 'Macroprudential regulation and banks’ supply of liquidity services' };
const abstract = 'We study how regulation affects the supply of liquidity services using bank data. Our findings identify the effects of financial constraints on lending and liquidity provision.';
const content = `${paper.title_original}\nDOI: ${paper.doi}\nAbstract\n${abstract}\nKeywords: banking`;

test('阅读诊断只保留本地固定错误码，不输出远端正文、URL或密钥', () => {
  assert.deepEqual(safeSearchDiagnostic({ code: 'INVALID_READER_RESPONSE', message: 'private-key', url }, 'zhipu'),
    { code: 'INVALID_READER_RESPONSE', http_status: null, provider_error_code: null });
});

test('智谱阅读调用已核实reader端点，禁用摘要生成，只采纳返回原正文并区分来源', async () => {
  let calls = 0;
  const source = makeSearchSources({ zhipuKey: 'fixture-private-key', fetchImpl: async (endpoint, init) => {
    calls++; assert.equal(endpoint, 'https://open.bigmodel.cn/api/paas/v4/reader');
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, 'Bearer fixture-private-key');
    const body = JSON.parse(init.body);
    assert.equal(body.url, url); assert.equal(body.return_format, 'markdown');
    assert.equal(body.with_images_summary, false); assert.equal(body.with_links_summary, false);
    assert.equal(body.retain_images, false); assert.equal(body.no_cache, false);
    assert.equal('messages' in body, false);
    return new Response(JSON.stringify({ reader_result: { url, title: paper.title_original, content,
      description: 'This description must not be used as an abstract.' } }));
  } });
  const result = await source.request({ provider: 'zhipu', query: 'reader:' + url, reader: { url } });
  assert.equal(calls, 1); assert.equal(result.charged, 1);
  const record = verifiedSearchRecord(result.leads, paper, journal, '2026-09-18T01:00:00Z');
  assert.equal(record.abstract, abstract); assert.equal(record.raw_abstract, content);
  assert.equal(record.source_evidence.scope_url, 'https://open.bigmodel.cn/api/paas/v4/reader');
  assert.equal(record.source_evidence.method, 'zhipu_reader_verbatim_abstract');
});

test('阅读拒绝不安全网址、跳转后的陌生页面、登录页、空正文及只有描述的回答', async () => {
  const invalid = ['http://example.com', 'https://localhost/a', 'https://127.0.0.1/a', url + '?api_key=private'];
  const noNetwork = makeSearchSources({ zhipuKey: 'fixture-private-key', fetchImpl: () => assert.fail('No unsafe request') });
  for (const value of invalid) await assert.rejects(noNetwork.request({ provider: 'zhipu', query: 'reader', reader: { url: value } }));
  for (const patch of [{ url: 'https://example.com/wrong' }, { title: 'Access denied' }, { content: '' }, { content: null }]) {
    const source = makeSearchSources({ zhipuKey: 'fixture-private-key', fetchImpl: async () => new Response(JSON.stringify({
      reader_result: { url, title: paper.title_original, content, description: abstract, ...patch } })) });
    await assert.rejects(source.request({ provider: 'zhipu', query: 'reader', reader: { url } }));
  }
});

const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'w1121188104w-hue/paper-daily' };
const targets = [
  { ...paper, journal_key: 'JFE', abstract_original: '' },
  { doi: '10.1111/1911-3846.70065', title_original: 'A synthetic CAR title', journal_key: 'CAR', abstract_original: 'RÉSUMÉ French fixture only.' },
  { doi: '10.1016/j.respol.2026.105508', title_original: 'A synthetic Research Policy title', journal_key: 'RP', abstract_original: abstract }
];
const library = { papers: targets, pointerText: 'original pointer' };

test('阅读验证仅手动受控运行，固定三次且不改库、不翻译、不开启每日阅读', async () => {
  let calls = 0; const logs = [];
  const result = await publisherReaderProbe({ env, configLoader: async () => config, policyLoader: async () => ({}),
    readLibrary: async () => library, log: row => logs.push(row), runtimeFactory: async ({ enableReaderProbe }) => {
      assert.equal(enableReaderProbe, true);
      return { sources: { readerArticle: async () => { calls++; return { called: true, result: { leads: [] } }; } }, summary: () => ({}) };
    } });
  assert.equal(calls, 3); assert.equal(result.production_writes, 0); assert.equal(result.translation_calls, 0);
  assert.equal(result.records.length, 3); assert.ok(result.records.every(row => row.verified === false));
  assert.ok(logs.every(row => !row.includes('fixture-private-key')));
  await assert.rejects(publisherReaderProbe({ env: { ...env, GITHUB_EVENT_NAME: 'schedule' }, configLoader: () => assert.fail('No runtime on schedule') }));
});

test('阅读验证记账失败立即停止，正式指针发生变化不能误报无写入验证通过', async () => {
  let calls = 0, reads = 0;
  const options = { env, configLoader: async () => config, policyLoader: async () => ({}), log: () => {},
    readLibrary: async () => library, runtimeFactory: async () => ({ sources: { readerArticle: async () => {
      calls++; throw Object.assign(new Error(), { code: 'SEARCH_LEDGER_CHECKPOINT_FAILED' }); } }, summary: () => ({}) }) };
  await assert.rejects(publisherReaderProbe(options), { code: 'SEARCH_LEDGER_CHECKPOINT_FAILED' }); assert.equal(calls, 1);
  await assert.rejects(publisherReaderProbe({ ...options,
    readLibrary: async () => ({ ...library, pointerText: reads++ ? 'changed pointer' : library.pointerText }),
    runtimeFactory: async () => ({ sources: { readerArticle: async () => ({ called: false, reason: 'unavailable' }) }, summary: () => ({}) })
  }));
});
