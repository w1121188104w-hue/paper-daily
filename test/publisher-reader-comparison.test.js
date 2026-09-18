import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { PUBLISHER_GROUPS, selectPublisherSamples, officialArticleUrl, knownArticleUrl, publisherReaderComparison } from '../scripts/publisher-reader-comparison.js';
const config = await loadJournalConfig();
const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'w1121188104w-hue/paper-daily' };
function paper(key, n = 0, abstract = '') {
  return { id: key + n, journal_key: key, doi: `10.1234/${key}-${n}`, title_original: 'Credit markets and investment',
    abstract_original: abstract, publication_date: '2026-09-15', source_records: [{ title: 'Credit markets and investment', type: 'journal-article' }] };
}
const text = 'We study firm investment and credit supply using administrative records. We find that tighter financial constraints reduce investment and employment substantially across firms.';
test('按9个出版单位分组，不把Chicago、INFORMS、SAGE合成Atypon；先覆盖各组、最多27篇', () => {
  const rows = PUBLISHER_GROUPS.flatMap(([, keys]) => [paper(keys[0]), paper(keys.at(-1), 1), paper(keys[0], 2, text), paper(keys[0], 3)]);
  const p = selectPublisherSamples(rows, config);
  assert.equal(p.groups.length, 9); assert.equal(p.selected.length, 27);
  assert.equal(new Set(p.selected.slice(0, 9).map(t => t.publisher)).size, 9);
  assert.equal(p.selected.filter(t => t.control).length, 9);
  assert.deepEqual(new Set(PUBLISHER_GROUPS.flatMap(([, k]) => k)), new Set(config.journals.filter(j => j.enabled).map(j => j.key)));
});
test('官网候选不能含站外、凭据、API、订阅目录、PDF或任意私网地址；无已知地址时才搜索', () => {
  const j = findJournal(config, 'CAR');
  for (const url of ['https://evil.example/doi/x', 'https://onlinelibrary.wiley.com/toc/1/0/0',
    'https://onlinelibrary.wiley.com/doi/a?token=secret', 'https://user:secret@onlinelibrary.wiley.com/doi/a',
    'https://localhost/article/a', 'https://onlinelibrary.wiley.com/article/a.pdf']) assert.equal(officialArticleUrl(url, j), null);
  assert.ok(knownArticleUrl(paper('CAR'), j).startsWith('https://onlinelibrary.wiley.com/doi/abs/'));
  assert.equal(knownArticleUrl(paper('JFE'), findJournal(config, 'JFE')), null);
});
test('测试无密钥日志、无正式库写入；Reader和Search分开记数，失败继续其他出版社', async () => {
  const papers = PUBLISHER_GROUPS.map(([, k]) => paper(k[0])), library = { papers, pointerText: 'unchanged', pointer: { manifest: { path: 'snapshot.json' } } };
  let reader = 0, search = 0, direct = 0;
  const result = await publisherReaderComparison({ env, configLoader: async () => config, policyLoader: async () => ({}), readLibrary: async () => library, log: () => {},
    runtimeFactory: async options => { assert.equal(options.enableReaderProbe, true); return { sources: {
      publisherArticle: async () => { direct++; throw Object.assign(new Error('not logged'), { code: 'ROBOTS_DISALLOWED' }); },
      readerArticle: async () => { reader++; return { called: true, result: { leads: [] } }; } },
      search: async () => { search++; return { called: true, result: { leads: [] } }; }, summary: () => ({}) }; } });
  assert.equal(result.records.length, 9); assert.equal(result.searches, search); assert.equal(result.reads, reader);
  assert.equal(result.requested, reader + search); assert.equal(direct, reader); assert.equal(result.production_writes, 0);
  assert.ok(result.groups.every(g => g.tested === 1 && g.verified === 0));
});
test('欠费和账本失败必须停止付费，不把它们归因为出版社防爬；本地或定时执行拒绝', async () => {
  const library = { papers: [paper('AOS'), paper('CAR')], pointerText: 'same', pointer: { manifest: {} } };
  const options = { env, configLoader: async () => config, policyLoader: async () => ({}), readLibrary: async () => library, log: () => {} };
  let calls = 0;
  const result = await publisherReaderComparison({ ...options, runtimeFactory: async () => ({ sources: {},
    search: async () => { calls++; return { called: true, diagnostic: { provider_error_code: '1113' } }; }, summary: () => ({}) }) });
  assert.equal(calls, 1); assert.equal(result.stopped, 'provider_payment_required');
  assert.equal(result.records[1].skipped, 'provider_payment_required');
  await assert.rejects(publisherReaderComparison({ ...options, env: {}, configLoader: () => assert.fail() }));
  await assert.rejects(publisherReaderComparison({ ...options, runtimeFactory: async () => ({ sources: {}, search: async () => {
    throw Object.assign(new Error('secret'), { code: 'SEARCH_LEDGER_CHECKPOINT_FAILED' }); } }) }), { code: 'SEARCH_LEDGER_CHECKPOINT_FAILED' });
});
test('返回完整原文才算成功，保留可复核摘录，对照与新增成功分开，不改变指针', async () => {
  const p = paper('CAR'), j = findJournal(config, 'CAR'), url = knownArticleUrl(p, j);
  const library = { papers: [p], pointerText: 'same', pointer: { manifest: {} } };
  const options = { env, configLoader: async () => config, policyLoader: async () => ({}), readLibrary: async () => library, log: () => {},
    runtimeFactory: async () => ({ sources: { publisherArticle: async () => ({ abstract: '' }), readerArticle: async () => ({ called: true, result: { leads: [{
      title: p.title_original, url, search_endpoint: 'reader', content: `${p.title_original} ${p.doi}\nAbstract\n${text}\nKeywords: credit` }] } }) },
      search: () => assert.fail('No repeated search after verified reading'), summary: () => ({}) }) };
  const result = await publisherReaderComparison(options);
  assert.equal(result.records[0].newly_verified, true); assert.equal(result.requested, 1);
  assert.equal(result.records[0].attempts[1].verified_evidence.abstract, text);
  let reads = 0;
  await assert.rejects(publisherReaderComparison({ ...options, readLibrary: async () => ({ ...library, pointerText: reads++ ? 'changed' : 'same' }) }));
});
