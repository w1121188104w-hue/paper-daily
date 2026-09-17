import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { classifyPaper } from '../src/services/paperClassification.js';
import { buildMasterList } from '../src/services/masterList.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { runMetadataRepair, metadataRepairIssue } from '../src/services/metadataRepairRun.js';
import { makeEnrichmentSources } from '../src/services/enrichmentSources.js';
import { semanticScholarType } from '../src/services/semanticScholar.js';
import { presentJournalLibrary } from '../src/services/journalPresentation.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER');
const at = '2026-09-15T01:00:00.000Z', later = '2026-09-16T01:00:00.000Z', doi = '10.1257/type-test';
const title = 'Investment responses to financial market conditions';
const abstract = 'We examine investment responses to financial constraints using detailed firm records and identify persistent effects on capital allocation.';
function record(source = 'crossref', type = 'editorial', patch = {}) {
  return normalizeSourceRecord({ source, source_id: source === 'crossref' ? doi : 'W1234', doi, title, abstract,
    authors: ['Alice Smith'], publication_date: '2026-08', journal_key: journal.key, journal_name: journal.name,
    journal_category: journal.category, journal_category_zh: journal.category_zh, print_issn: journal.print_issn,
    electronic_issn: journal.electronic_issn, type, last_checked_at: at, ...patch });
}
const proof = () => ({ url: `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
  scope_url: `https://api.crossref.org/works/${encodeURIComponent(doi)}`, fetched_at: later, body_sha256: 'a'.repeat(64), method: 'crossref_api' });
const correction = patch => record('crossref', 'journal-article', { last_checked_at: later, source_evidence: proof(), ...patch });
const paper = rows => mergePapers(rows, { checkedAt: at, firstSeenDate: '2026-09-15' }).papers[0];
const absent = async () => { throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' }); };
const sources = patch => ({ crossref: absent, openalex: absent, semanticscholar: absent, publisherArticle: absent, ...patch });
async function stored(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'type-repair-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('type-repair-')); await fs.rm(root, { recursive: true, force: true }); });
  const clients = Object.fromEntries(['crossref', 'openalex'].map(source => [source, async () => ({ source, journal_key: 'AER',
    records: [record(source, source === 'crossref' ? 'editorial' : 'article')], ok: true, complete: true,
    raw_count: 1, raw_pages: [], rejected: [], duration_ms: 0, error: null })]));
  await runJournalCollection(config, { root, journalKey: 'AER', now: () => new Date(at), clients });
  return { root, before: await readJournalLibrary({ root, config }) };
}

test('同来源类型更正可读时生效，v1/v2/v3总名册仍按旧规则重建，历史记录不变', () => {
  const old = record(), input = paper([old, record('openalex', 'article')]);
  input.source_records.push(correction());
  const saved = JSON.stringify(input);
  assert.equal(classifyPaper(input).kind, 'candidate');
  for (const policyVersion of [1, 2, 3]) assert.equal(buildMasterList([input], { generatedAt: later, policyVersion }).entries[0].classification, 'needs_review');
  assert.equal(buildMasterList([input], { generatedAt: later, policyVersion: 4 }).entries[0].classification, 'candidate');
  assert.equal(JSON.stringify(input), saved);
});

test('缺证据、缺类型、倒退或同刻记录、不同身份以及仍冲突的其他来源不能自动洗掉分类警告', () => {
  const old = record();
  const candidates = [correction({ source_evidence: undefined }), correction({ type: '' }),
    correction({ last_checked_at: at, source_evidence: { ...proof(), fetched_at: at } }),
    correction({ source_evidence: { ...proof(), method: 'publisher_default' } }),
    correction({ source_evidence: { ...proof(), url: 'https://example.org/not-source' } }),
    correction({ source_id: 'different-id' }), correction({ doi: '10.1257/other' }),
    correction({ title: 'Another research paper' })];
  for (const candidate of candidates) assert.equal(classifyPaper({ source_records: [old, candidate] }).kind, 'needs_review');
  assert.equal(classifyPaper({ source_records: [record('crossref', 'editorial', { source_updated_at: later }),
    correction({ source_updated_at: at })] }).kind, 'needs_review');
  assert.equal(classifyPaper({ source_records: [old, correction(), record('openalex', 'editorial')] }).kind, 'needs_review');
  assert.equal(classifyPaper({ source_records: [record('crossref', 'retraction'), correction()] }).kind, 'possible_retraction');
});

test('分类自动修复端到端：真实来源更正后保存、关闭待办，重读及网页同步且无需重复请求', async t => {
  const { root, before } = await stored(t), oldMaster = await fs.readFile(path.join(root, before.manifest.master_list.path), 'utf8');
  assert.ok(metadataRepairIssue({ field: 'classification', reason: 'document_type_uncertain' }));
  assert.equal(before.masterList.entries[0].classification, 'needs_review');
  const result = await runMetadataRepair(config, { root, now: () => new Date(later), sources: sources({ crossref: async () => correction() }), search: () => assert.fail('Already resolved') });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.report.repairs[0].requested_fields, ['classification']);
  const after = await readJournalLibrary({ root, config });
  assert.equal(after.masterList.entries[0].classification, 'candidate');
  assert.equal(presentJournalLibrary(after, config).papers[0].classification.kind, 'candidate');
  assert.ok(Object.values(after.repairState.issues).every(row => row.status === 'resolved'));
  assert.deepEqual(after.papers[0].source_records.slice(0, before.papers[0].source_records.length), before.papers[0].source_records);
  for (const key of ['id', 'title_original', 'abstract_original', 'title_zh', 'abstract_zh', 'discovered_at']) assert.equal(after.papers[0][key], before.papers[0][key]);
  assert.equal(await fs.readFile(path.join(root, before.manifest.master_list.path), 'utf8'), oldMaster);
  assert.equal((await runMetadataRepair(config, { root, now: () => new Date(later), sources: sources(), search: () => assert.fail('No repeat') })).status, 'skipped');
});

test('分类查不到也必须完整执行三源和搜索兜底，保存未解决状态、冷却及重试', async t => {
  const { root } = await stored(t), calls = [];
  const result = await runMetadataRepair(config, { root, now: () => new Date(later),
    sources: sources(Object.fromEntries(['crossref', 'openalex', 'semanticscholar'].map(source => [source, async () => { calls.push(source); return absent(); }]))),
    search: async ({ provider }) => { calls.push(provider); return { called: true, result: { leads: [] } }; } });
  assert.equal(result.status, 'partial');
  assert.deepEqual(calls, ['crossref', 'openalex', 'semanticscholar', 'zhipu', 'serpapi_scholar', 'serpapi_google']);
  const after = await readJournalLibrary({ root, config }), issues = Object.values(after.repairState.issues);
  assert.equal(issues.length, 1); assert.equal(issues[0].reason, 'document_type_uncertain');
  assert.equal(issues[0].status, 'not_found'); assert.equal(issues[0].attempt_count, 1);
  assert.equal(issues[0].next_retry_at, '2026-09-17T01:00:00.000Z');
  assert.equal(after.papers.length, 1); assert.equal(after.masterList.entries[0].classification, 'needs_review');
});

test('Semantic Scholar补全读取实际文献类型，不把Editorial或未知类型硬填成研究论文', async () => {
  const expected = paper([record()]);
  for (const [publicationTypes, type] of [[['Editorial'], 'editorial'], [['Review'], 'review'], [['JournalArticle'], 'journal-article'], [null, ''], [['Unknown'], '']]) {
    assert.equal(semanticScholarType({ publicationTypes }), type);
    const client = makeEnrichmentSources({ request: async url => {
      assert.ok(new URL(url).searchParams.get('fields').split(',').includes('publicationTypes'));
      return { url, fetched_at: later, sha256: 'a'.repeat(64), body: JSON.stringify({ paperId: 'a'.repeat(40),
        title, abstract, externalIds: { DOI: doi }, journal: { name: journal.name },
        publicationVenue: { name: journal.name, issn: journal.print_issn, type: 'journal' },
        authors: [{ name: 'Alice Smith' }], publicationTypes }) };
    } });
    assert.equal((await client.semanticscholar(expected, journal)).type, type);
  }
});
