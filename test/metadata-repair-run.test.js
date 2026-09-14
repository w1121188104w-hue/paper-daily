import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { publisherRecord } from '../src/services/publisherParsers.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { journalGitFiles } from '../src/services/journalGitFiles.js';
import { runCatalogDiscovery } from '../src/services/catalogDiscoveryRun.js';
import { runMetadataRepair } from '../src/services/metadataRepairRun.js';
import { fillMissingMetadata } from '../src/services/searchMetadata.js';
import { validateMetadataRepairOnlyChange } from '../src/services/metadataRepairValidation.js';
import { dueRepairIssues } from '../src/services/repairState.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER');
const at = '2026-09-13T12:00:00.000Z', title = 'International trade and the allocation of economic resources';
const abstract = 'We investigate how international trade affects resource allocation using firm-level panel data and a quantitative model of heterogeneous producers.';
const url = 'https://www.aeaweb.org/articles/no-doi';
const lead = { title, url, authors: [], doi: '', date: '', abstract: '', journal_confirmed: true,
  evidence: { url, scope_url: 'https://www.aeaweb.org/issues/123', fetched_at: at, body_sha256: 'a'.repeat(64), method: 'article_without_abstract' } };
function record(source = 'crossref', patch = {}) {
  return normalizeSourceRecord({ ...publisherRecord(lead, journal), source, source_id: `${source}-test-paper`,
    doi: '10.1257/example', authors: ['Alice Smith'], publication_date: '2026-09', abstract,
    source_evidence: { url: 'https://api.crossref.org/works/10.1257%2Fexample', scope_url: 'https://api.crossref.org/works/10.1257%2Fexample',
      fetched_at: at, body_sha256: 'b'.repeat(64), method: `${source}_api` }, ...patch });
}
const absent = async () => { throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' }); };
const sources = patch => ({ crossref: absent, openalex: absent, semanticscholar: absent, publisherArticle: absent, ...patch });
async function seed(t) {
  const parent = path.resolve(os.tmpdir()), repositoryRoot = await fs.mkdtemp(path.join(parent, 'metadata-repair-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(repositoryRoot)), parent); assert.ok(path.basename(repositoryRoot).startsWith('metadata-repair-test-')); await fs.rm(repositoryRoot, { recursive: true, force: true }); });
  const root = path.join(repositoryRoot, 'data', 'journal-store');
  await runCatalogDiscovery(config, { root, now: () => new Date(at), journalKey: 'AER', http: { request: absent },
    discover: async () => ({ leads: [lead], attempts: [] }), search: async () => ({ called: false, reason: 'quota_exhausted' }) });
  return { root, repositoryRoot };
}

test('字段写入保护：只能由新追加证据重演补全，禁止改既有标题作者日期译文', () => {
  const old = mergePapers([publisherRecord(lead, journal)], { firstSeenDate: '2026-09-13', checkedAt: at }).papers[0];
  old.title_zh = '已有中文标题'; old.title_translation_status = 'done';
  const valid = fillMissingMetadata(old, record()).paper;
  validateMetadataRepairOnlyChange([old], [valid]);
  for (const patch of [{ title_zh: '偷偷重译' }, { title_original: 'Different title' }, { first_seen_date: '2026-09-12' },
    { authors: [{ name: 'Someone else', orcid: '' }] }, { publication_date: '2025-09' }]) {
    assert.throws(() => validateMetadataRepairOnlyChange([old], [{ ...valid, ...patch }]));
  }
  assert.throws(() => validateMetadataRepairOnlyChange([old], []));
  assert.throws(() => validateMetadataRepairOnlyChange([old], [{ ...valid, source_records: [...valid.source_records].reverse() }]));
});

test('字段端到端：三源补齐后不搜索，保留ID与发现时间，新摘要进入原翻译队列', async t => {
  const dirs = await seed(t), before = await readJournalLibrary({ ...dirs, config }), calls = [];
  const result = await runMetadataRepair(config, { ...dirs, now: () => new Date(at), sources: sources({
    crossref: async () => { calls.push('crossref'); return record(); } }), search: () => assert.fail('Structured source already complete') });
  assert.equal(result.status, 'success'); assert.deepEqual(calls, ['crossref']);
  assert.equal(result.stats.abstracts_filled, 1); assert.equal(result.stats.papers_changed, 1);
  const after = await readJournalLibrary({ ...dirs, config }), paper = after.papers[0];
  assert.equal(paper.id, before.papers[0].id); assert.equal(paper.discovered_at, before.papers[0].discovered_at);
  assert.equal(paper.doi, '10.1257/example'); assert.equal(paper.abstract_original, abstract); assert.equal(paper.abstract_zh, '');
  assert.equal(paper.abstract_translation_status, 'pending'); assert.equal(after.masterList.entries[0].publication_month, '2026-09');
  assert.ok(Object.values(after.repairState.issues).every(issue => issue.status === 'resolved'));
  const skipped = await runMetadataRepair(config, { ...dirs, now: () => new Date(at), sources: sources(), search: () => assert.fail('No repeat searches') });
  assert.equal(skipped.status, 'skipped'); assert.equal((await journalGitFiles(config, dirs)).versions, 2);
});

test('字段端到端：三源无结果后才搜索，必须读取真实原始页面，不能使用snippet', async t => {
  const dirs = await seed(t), calls = [];
  const result = await runMetadataRepair(config, { ...dirs, now: () => new Date(at), sources: sources({
    ...Object.fromEntries(['crossref', 'openalex', 'semanticscholar'].map(provider => [provider, async () => { calls.push(provider); return absent(); }])),
    publisherArticle: async () => { calls.push('official-page'); return record('publisher', { source_id: url,
      source_evidence: { ...lead.evidence, method: 'article_metadata_abstract' } }); }
  }), search: async ({ provider }) => { calls.push(provider); return { called: true, result: { leads: [{ url, snippet: 'Fabricated text, never an abstract' }] } }; } });
  assert.equal(result.status, 'success'); assert.deepEqual(calls, ['crossref', 'openalex', 'semanticscholar', 'zhipu', 'official-page']);
  assert.equal((await readJournalLibrary({ ...dirs, config })).papers[0].abstract_original, abstract);
});

test('字段重试：部分补齐保存，未找到的字段保存失败记录，当天重跑不搜索', async t => {
  const dirs = await seed(t); let count = 0;
  const options = { ...dirs, now: () => new Date(at), sources: sources({ crossref: async () => record('crossref', { doi: '', publication_date: '', abstract: '' }) }),
    search: async () => { count++; return { called: true, result: { leads: [] } }; } };
  const result = await runMetadataRepair(config, options); assert.equal(result.status, 'partial'); assert.equal(count, 3);
  const library = await readJournalLibrary({ ...dirs, config });
  assert.equal(library.papers[0].authors.length, 1); assert.equal(library.papers[0].abstract_original, ''); assert.equal(library.papers[0].abstract_zh, '');
  assert.equal(Object.values(library.repairState.issues).find(issue => issue.field === 'authors').status, 'resolved');
  assert.ok(Object.values(library.repairState.issues).filter(issue => issue.field !== 'authors').every(issue => issue.status === 'not_found' && issue.attempt_count === 1));
  await runMetadataRepair(config, options); assert.equal(count, 3);
  assert.ok(dueRepairIssues(library.repairState, new Date('2026-09-15T00:00:00Z')).length > 0);
});

test('字段额度耗尽：记录真实重置时间，区别于已搜索未找到，到期后进入自动队列', async t => {
  const dirs = await seed(t), reset = '2026-10-13T00:00:00.000Z';
  await runMetadataRepair(config, { ...dirs, now: () => new Date(at), sources: sources(), quotaResetsAt: reset,
    search: async ({ provider }) => provider === 'zhipu' ? { called: true, result: { leads: [] } } : { called: false, reason: 'quota_exhausted' } });
  const library = await readJournalLibrary({ ...dirs, config });
  assert.ok(Object.values(library.repairState.issues).every(issue => issue.status === 'quota_exhausted' && issue.next_retry_at === reset));
  assert.equal(dueRepairIssues(library.repairState, new Date('2026-10-12T00:00:00Z')).length, 0);
  assert.equal(dueRepairIssues(library.repairState, new Date(reset)).length, 4);
});

test('字段记账或存储失败：不绕过额度、不切换正式指针', async t => {
  const dirs = await seed(t), before = await readJournalLibrary({ ...dirs, config }); let calls = 0;
  await assert.rejects(runMetadataRepair(config, { ...dirs, now: () => new Date(at), sources: sources(), search: async () => {
    calls++; throw Object.assign(new Error('checkpoint failed'), { code: 'SEARCH_LEDGER_CHECKPOINT_FAILED' }); } }));
  assert.equal(calls, 1); assert.equal((await readJournalLibrary({ ...dirs, config })).pointerText, before.pointerText);
  await assert.rejects(runMetadataRepair(config, { ...dirs, now: () => new Date(at), sources: sources({ crossref: async () => record() }),
    search: absent, beforePublish: () => { throw new Error('Simulated storage interruption'); } }));
  assert.equal((await readJournalLibrary({ ...dirs, config })).pointerText, before.pointerText);
});

test('跨日重启：24小时内不重试，到期后结构化来源补到真实摘要，成功后不再搜索', async t => {
  const dirs = await seed(t); let clock = new Date(at), searches = 0, lookups = 0, available = false;
  const options = () => ({ ...dirs, now: () => clock, sources: sources({ crossref: async () => {
    lookups++; const row = record('crossref', { abstract: available ? abstract : '', last_checked_at: clock.toISOString() });
    row.source_evidence.fetched_at = clock.toISOString(); return row;
  } }), search: async () => { searches++; return { called: true, result: { leads: [] } }; } });
  await runMetadataRepair(config, options());
  const initial = await readJournalLibrary({ ...dirs, config });
  assert.equal(searches, 3); assert.equal(initial.papers[0].abstract_original, '');
  clock = new Date(Date.parse(at) + 86400000 - 1);
  assert.equal((await runMetadataRepair(config, options())).status, 'skipped');
  assert.equal(lookups, 1); assert.equal(searches, 3);
  clock = new Date(Date.parse(at) + 86400000); available = true;
  assert.equal((await runMetadataRepair(config, options())).stats.abstracts_filled, 1);
  const filled = await readJournalLibrary({ ...dirs, config });
  assert.equal(filled.papers[0].abstract_original, abstract); assert.equal(filled.papers[0].abstract_zh, '');
  assert.equal(filled.papers[0].id, initial.papers[0].id); assert.equal(filled.papers[0].discovered_at, initial.papers[0].discovered_at);
  assert.equal(filled.queue.tasks.filter(task => task.field === 'abstract').length, 1);
  assert.equal(searches, 3); assert.equal(lookups, 2);
  clock = new Date(Date.parse(at) + 5 * 86400000);
  assert.equal((await runMetadataRepair(config, options())).status, 'skipped');
  assert.equal(searches, 3); assert.equal(lookups, 2);
});

test('连续未找到退避：第一次1天、第二次3天，不因进程重启丢失冷却', async t => {
  const dirs = await seed(t); let clock = new Date(at), calls = 0;
  const options = () => ({ ...dirs, now: () => clock, sources: sources(), search: async () => { calls++; return { called: true, result: { leads: [] } }; } });
  await runMetadataRepair(config, options());
  clock = new Date(Date.parse(at) + 86400000);
  await runMetadataRepair(config, options());
  const saved = await readJournalLibrary({ ...dirs, config });
  assert.ok(Object.values(saved.repairState.issues).every(issue => issue.attempt_count === 2 && Date.parse(issue.next_retry_at) === Date.parse(at) + 4 * 86400000));
  clock = new Date(Date.parse(at) + 3 * 86400000);
  assert.equal((await runMetadataRepair(config, options())).status, 'skipped');
  assert.equal(calls, 6);
});
