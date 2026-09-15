import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { buildMasterList, discoverySourcesFor } from '../src/services/masterList.js';
import { singleSourceConfirmationFor } from '../src/services/sourceConfirmation.js';
import { repairPaperMetadata, fillMissingMetadata } from '../src/services/searchMetadata.js';
import { reconcileRepairState, recordSourceConfirmation, dueRepairIssues } from '../src/services/repairState.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { runMetadataRepair } from '../src/services/metadataRepairRun.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER'), at = '2026-09-15T01:00:00.000Z';
const title = 'Investment responses to changes in financial market conditions';
const abstract = 'We study investment responses using a detailed panel of firms and identify how financial constraints influence capital allocation across markets.';
function row(patch = {}) {
  return normalizeSourceRecord({ source: 'crossref', source_id: '10.1257/confirmation', doi: '10.1257/confirmation',
    title, abstract, authors: ['Alice Smith'], publication_date: '2026-09-10', journal_key: 'AER', journal_name: journal.name,
    journal_category: journal.category, journal_category_zh: journal.category_zh, print_issn: journal.print_issn,
    electronic_issn: journal.electronic_issn, last_checked_at: at, ...patch });
}
function lookup(source = 'openalex', patch = {}) {
  const url = source === 'publisher' ? 'https://www.aeaweb.org/articles?id=10.1257/confirmation' :
    source === 'crossref' ? 'https://api.crossref.org/works/10.1257%2Fconfirmation' :
      'https://api.openalex.org/works/https://doi.org/10.1257%2Fconfirmation';
  return row({ source, source_id: source === 'publisher' ? url : source === 'crossref' ? '10.1257/confirmation' : 'W1234', url,
    source_evidence: { url, scope_url: url, fetched_at: at, body_sha256: 'a'.repeat(64),
      method: source === 'publisher' ? 'article_metadata_abstract' : `${source}_api` }, ...patch });
}
const seed = patch => mergePapers([row(patch)], { firstSeenDate: '2026-09-15', checkedAt: at }).papers[0];
const absent = async () => { throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' }); };
const sources = patch => ({ crossref: absent, openalex: absent, semanticscholar: absent, publisherArticle: absent, ...patch });

async function stored(t, patch = {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'source-confirmation-test-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('source-confirmation-test-')); await fs.rm(root, { recursive: true, force: true }); });
  const clients = Object.fromEntries(['crossref', 'openalex'].map(source => [source, async () => ({ source, journal_key: 'AER',
    records: source === 'crossref' ? [row(patch)] : [], ok: true, complete: true, raw_count: source === 'crossref' ? 1 : 0,
    raw_pages: [], rejected: [], duration_ms: 0, error: null })]));
  await runJournalCollection(config, { root, journalKey: 'AER', now: () => new Date(at), clients });
  return root;
}

test('单源证据必须来自其他来源，核对标题DOI作者和证据域名，不冒充独立发现', () => {
  const paper = seed(), append = r => ({ ...paper, source_records: [...paper.source_records, r] });
  assert.equal(singleSourceConfirmationFor(append(lookup('crossref'))), null);
  assert.equal(singleSourceConfirmationFor(append(lookup())).source, 'openalex');
  assert.deepEqual(discoverySourcesFor(append(lookup())), ['crossref']);
  for (const patch of [{ doi: '10.1257/different' }, { title: 'Unrelated paper title' }, { authors: ['Someone Else'] },
    { source_evidence: { ...lookup().source_evidence, url: 'https://example.org/forged' } }]) {
    assert.equal(singleSourceConfirmationFor(append(lookup('openalex', patch))), null);
  }
  assert.equal(singleSourceConfirmationFor(append(lookup('publisher'))).source, 'publisher');
});

test('无DOI不得用同一次查询刚补的作者反过来证明自己，原发现已有作者日期可核实', () => {
  const paper = seed({ doi: '', authors: [] });
  const filled = fillMissingMetadata(paper, lookup()).paper;
  assert.equal(singleSourceConfirmationFor(filled), null);
  const anchored = seed({ doi: '' });
  assert.equal(singleSourceConfirmationFor(fillMissingMetadata(anchored, lookup()).paper).source, 'openalex');
});

test('字段齐全但只有单源仍查询；结构化来源成功即停，既有证据可零请求结案', async () => {
  const paper = seed(), calls = [];
  const result = await repairPaperMetadata(paper, journal, { fields: ['identity'], confirmSingleSource: true,
    sources: sources({ crossref: async () => { calls.push('crossref'); return lookup('crossref'); },
      openalex: async () => { calls.push('openalex'); return lookup(); } }), search: () => assert.fail('No redundant search') });
  assert.deepEqual(calls, ['crossref', 'openalex']); assert.equal(result.status, 'resolved');
  assert.equal(result.single_source_confirmation.source, 'openalex');
  const cached = await repairPaperMetadata(result.paper, journal, { fields: ['identity'], confirmSingleSource: true,
    sources: new Proxy({}, { get: () => assert.fail('Cached evidence') }), search: () => assert.fail() });
  assert.equal(cached.status, 'resolved');
});

test('三源失败后走智谱→Scholar→Google，必须访问原始论文页面而非采纳搜索片段', async () => {
  const calls = [], paper = seed();
  const result = await repairPaperMetadata(paper, journal, { fields: ['identity'], confirmSingleSource: true,
    sources: sources({ ...Object.fromEntries(['crossref', 'openalex', 'semanticscholar'].map(source => [source, async () => { calls.push(source); return absent(); }])),
      publisherArticle: async () => { calls.push('article'); return lookup('publisher'); } }),
    search: async ({ provider }) => { calls.push(provider); return { called: true, result: { leads: provider === 'serpapi_google' ?
      [{ url: lookup('publisher').url, snippet: 'Not evidence' }] : [] } }; } });
  assert.deepEqual(calls, ['crossref', 'openalex', 'semanticscholar', 'zhipu', 'serpapi_scholar', 'serpapi_google', 'article']);
  assert.equal(result.status, 'resolved'); assert.equal(result.single_source_confirmation.source, 'publisher');
  assert.equal(result.paper.abstract_original, paper.abstract_original);
});

test('没有佐证不能假结案；确认后身份指纹改变会重新进入待办', async () => {
  const paper = seed(), result = await repairPaperMetadata(paper, journal, { fields: ['identity'], confirmSingleSource: true,
    sources: sources(), search: async () => ({ called: true, result: { leads: [] } }) });
  assert.equal(result.status, 'not_found'); assert.deepEqual(result.missing_fields, ['identity']);
  const master = p => buildMasterList([p], { generatedAt: at, policyVersion: 3 });
  const state = reconcileRepairState(null, master(paper)), issue = Object.values(state.issues)[0];
  assert.throws(() => recordSourceConfirmation(state, issue.id, paper, at));
  const confirmed = fillMissingMetadata(paper, lookup()).paper;
  const saved = recordSourceConfirmation(state, issue.id, confirmed, at);
  assert.equal(dueRepairIssues(reconcileRepairState(saved, master(confirmed))).length, 0);
  assert.equal(reconcileRepairState(saved, master({ ...confirmed, authors: [{ name: 'Changed Author', orcid: '' }] })).issues[issue.id].status, 'pending');
});

test('实际落库单源确认：保存其他来源证据并结案，重读后不重复请求、不改变发现标记', async t => {
  const root = await stored(t);
  const before = await readJournalLibrary({ root, config });
  assert.equal(Object.values(before.repairState.issues).filter(i => i.reason === 'single_source_confirmation').length, 1);
  const repaired = await runMetadataRepair(config, { root, now: () => new Date(at), sources: sources({ openalex: async () => lookup() }), search: () => assert.fail() });
  assert.equal(repaired.status, 'success'); assert.equal(repaired.report.repairs[0].single_source_confirmation.source, 'openalex');
  assert.equal(repaired.stats.single_source_confirmed, 1);
  const saved = await readJournalLibrary({ root, config });
  assert.equal(Object.values(saved.repairState.issues)[0].status, 'resolved');
  assert.deepEqual(saved.masterList.entries[0].discovery_sources, ['crossref']);
  assert.equal(saved.papers[0].title_original, before.papers[0].title_original);
  const replay = await runMetadataRepair(config, { root, now: () => new Date(at), sources: sources(), search: () => assert.fail() });
  assert.equal(replay.status, 'skipped');
});

test('身份确认与摘要状态分开保存，缺摘要不妨碍关闭有证据的确认任务', async t => {
  const root = await stored(t, { abstract: '' }); let calls = 0;
  const result = await runMetadataRepair(config, { root, now: () => new Date(at), sources: sources({ openalex: async () => lookup('openalex', { abstract: '' }) }),
    search: async () => { calls++; return { called: true, result: { leads: [] } }; } });
  assert.equal(result.status, 'partial'); assert.equal(calls, 3);
  const saved = await readJournalLibrary({ root, config }), issues = Object.values(saved.repairState.issues);
  assert.equal(issues.find(i => i.reason === 'single_source_confirmation').status, 'resolved');
  assert.equal(issues.find(i => i.reason === 'missing_abstract').status, 'not_found');
  assert.equal(saved.papers[0].abstract_original, ''); assert.equal(saved.papers[0].abstract_zh, '');
  const again = await runMetadataRepair(config, { root, now: () => new Date(at), sources: sources(), search: () => assert.fail() });
  assert.equal(again.status, 'skipped');
});

test('单源确认耗尽额度也保留真实重置日，不能当成已查完或已确认', async t => {
  const root = await stored(t), reset = '2026-10-15T00:00:00.000Z';
  await runMetadataRepair(config, { root, now: () => new Date(at), sources: sources(), quotaResetsAt: reset,
    search: async ({ provider }) => provider === 'zhipu' ? { called: true, result: { leads: [] } } : { called: false, reason: 'quota_exhausted' } });
  const saved = await readJournalLibrary({ root, config }), issue = Object.values(saved.repairState.issues)[0];
  assert.equal(issue.status, 'quota_exhausted'); assert.equal(issue.next_retry_at, reset); assert.equal(issue.resolved_at, null);
  assert.equal(dueRepairIssues(saved.repairState, new Date('2026-10-14T00:00:00Z')).length, 0);
  assert.equal(dueRepairIssues(saved.repairState, new Date(reset)).length, 1);
});
