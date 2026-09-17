import test from 'node:test';
import assert from 'node:assert/strict';
import { runJournalPipeline } from '../src/services/journalPipeline.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { runCatalogDiscovery } from '../src/services/catalogDiscoveryRun.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
const library = { papers: [], repairState: { issues: {} }, masterList: { statistics: { total: 0 }, journals: [] } };
function options(events, patch = {}) {
  const search = async () => assert.fail('No network in ordering tests');
  return { root: 'explicit-test-root', http: { request: search }, sources: {}, search,
    readLibrary: async () => { events.push('validate'); return library; },
    collect: async (config, o) => { events.push('collect'); assert.equal(o.withSemanticScholar, true);
      assert.equal(o.lookbackDays, 60); assert.equal(o.onlyIfNeeded, true); assert.equal(o.root, 'explicit-test-root'); return { status: 'partial' }; },
    catalog: async (config, o) => { events.push('catalog'); assert.equal(o.search, search); return { status: 'partial' }; },
    repair: async (config, o) => { events.push('repair'); assert.equal(o.search, search); return { status: 'success' }; },
    resolveDuplicates: async () => { events.push('merge'); return { status: 'skipped' }; }, ...patch };
}
test('每日顺序：三源→官网清单→复用归并→字段→新归并→队列，阶段间校验，来源部分失败仍继续', async () => {
  const events = [], result = await runJournalPipeline({}, options(events, { collectionOptions: { withSemanticScholar: false, root: 'wrong', lookbackDays: 1 } }));
  assert.deepEqual(events, ['validate', 'collect', 'validate', 'catalog', 'validate', 'merge', 'validate', 'repair', 'validate', 'merge', 'validate', 'validate']);
  assert.equal(result.status, 'partial'); assert.equal(result.translation_calls, 0); assert.equal(result.coverage, 'not_proven_complete');
});
test('每日流程损坏预检、存储和账本错误必须停止，不能继续到翻译或后续阶段', async () => {
  for (const failure of ['readLibrary', 'collect', 'catalog', 'repair', 'resolveDuplicates']) {
    const events = [];
    await assert.rejects(runJournalPipeline({}, options(events, { [failure]: async () => { throw Object.assign(new Error('stop'), { code: 'EVIDENCE_STORAGE_ERROR' }); } })), { code: 'EVIDENCE_STORAGE_ERROR' });
    if (failure === 'readLibrary') assert.deepEqual(events, []);
    if (failure === 'collect') assert.ok(!events.includes('catalog'));
    if (failure === 'catalog') assert.ok(!events.includes('repair'));
  }
});
test('每日流程无默认生产目录，非法批量在任何读取或联网前拒绝', async () => {
  const events = [];
  for (const patch of [{ root: '' }, { maxPapers: 1001 }, { maxPages: 0 }, { search: null }]) await assert.rejects(runJournalPipeline({}, options(events, patch)));
  assert.deepEqual(events, []);
});

test('统一入口真实保存路径：独立三源、官网故障隔离、元数据补齐、队列重读', async t => {
  const parent = path.resolve(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'journal-pipeline-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), parent); assert.ok(path.basename(root).startsWith('journal-pipeline-test-')); await fs.rm(root, { recursive: true, force: true }); });
  const config = await loadJournalConfig(), journal = findJournal(config, 'AER'), at = '2026-09-15T01:00:00.000Z';
  const abstract = 'We study economic outcomes using detailed firm-level records and identify how investment responds to changes in financial market conditions.';
  const base = normalizeSourceRecord({ source: 'crossref', source_id: '10.1257/pipeline', doi: '10.1257/pipeline',
    title: 'Investment responses to changes in financial market conditions', authors: ['Alice Smith'],
    journal_key: journal.key, journal_name: journal.name, journal_category: journal.category, journal_category_zh: journal.category_zh,
    print_issn: journal.print_issn, electronic_issn: journal.electronic_issn, publication_date: '2026-09-10', last_checked_at: at });
  const invoked = [];
  const clients = Object.fromEntries(['crossref', 'openalex', 'semanticscholar'].map(source => [source, async () => {
    invoked.push(source);
    return { source, journal_key: 'AER', records: source === 'crossref' ? [base] : [], ok: source !== 'semanticscholar', complete: source !== 'semanticscholar',
      raw_count: source === 'crossref' ? 1 : 0, raw_pages: [], rejected: [], duration_ms: 0, error: source === 'semanticscholar' ? { code: 'HTTP_ERROR' } : null };
  }]));
  const unavailable = async () => { throw Object.assign(new Error(), { code: 'ACCESS_RESTRICTED' }); };
  const result = await runJournalPipeline(config, { root, journalKey: 'AER', now: () => new Date(at), collectionOptions: { clients },
    http: { request: unavailable }, search: async () => ({ called: true, result: { leads: [] } }),
    sources: { crossref: async () => normalizeSourceRecord({ ...base, abstract, source_evidence: {
      url: 'https://api.crossref.org/works/10.1257%2Fpipeline', scope_url: 'https://api.crossref.org/works/10.1257%2Fpipeline', fetched_at: at, body_sha256: 'a'.repeat(64), method: 'crossref_api' } }),
      openalex: unavailable, semanticscholar: unavailable, publisherArticle: unavailable },
    catalog: (c, o) => runCatalogDiscovery(c, { ...o, discover: unavailable }) });
  assert.deepEqual(invoked.sort(), ['crossref', 'openalex', 'semanticscholar']);
  const saved = await readJournalLibrary({ root, config });
  assert.equal(saved.papers.length, 1); assert.equal(saved.papers[0].abstract_original, abstract);
  assert.equal(result.translation_calls, 0); assert.equal(result.translation_ready.fields, 2);
  assert.equal(result.status, 'partial'); assert.equal(result.stages.length, 5);
  assert.equal(saved.papers[0].abstract_zh, ''); assert.equal(saved.masterList.statistics.missing_abstract, 0);
});
