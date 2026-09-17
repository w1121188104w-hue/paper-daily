import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { validatePapers, validateHistoryPreserved } from '../src/services/libraryValidation.js';
import { duplicateMergeProof, mergeConfirmedDuplicate } from '../src/services/duplicateMerge.js';
import { repairPaperMetadata } from '../src/services/searchMetadata.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER');
const discovered = '2026-09-15T01:00:00.000Z', at = '2026-09-16T01:00:00.000Z', later = '2026-09-16T02:00:00.000Z';
const doi = '10.1257/merge-example', title = 'Financial markets and the allocation of resources';
const abstract = 'We investigate how financial constraints affect the allocation of resources across firms and identify persistent differences in investment.';
function record(source, patch = {}) {
  return normalizeSourceRecord({ source, source_id: source === 'crossref' ? doi : 'W98765', doi: source === 'crossref' ? doi : '',
    title, abstract: source === 'crossref' ? '' : abstract, authors: source === 'crossref' ? ['Alice Smith'] : [],
    publication_date: '2026-08', journal_key: journal.key, journal_name: journal.name, journal_category: journal.category,
    journal_category_zh: journal.category_zh, print_issn: journal.print_issn, electronic_issn: journal.electronic_issn,
    type: 'journal-article', last_checked_at: at, ...patch });
}
const one = (row, checkedAt = at) => mergePapers([row], { checkedAt, firstSeenDate: checkedAt.slice(0, 10) }).papers[0];
function fixture() {
  const original = one(record('openalex', { last_checked_at: discovered }), discovered);
  original.title_zh = '金融市场与资源配置'; original.title_translation_status = 'done';
  original.abstract_zh = '测试用已完成中文摘要'; original.abstract_translation_status = 'done';
  original.translation_model = 'deepseek-test'; original.translated_at = discovered;
  const target = one(record('crossref'));
  const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`;
  const evidence = record('openalex', { doi, authors: ['Alice Smith'], last_checked_at: later,
    source_evidence: { url, scope_url: url, method: 'openalex_api', fetched_at: later, body_sha256: 'a'.repeat(64) } });
  return { original, target, evidence };
}

test('DOI碰撞只作为查询线索，后续API核对原始来源编号后保留可重演合并证据，不继续收费搜索', async () => {
  const { original, target, evidence } = fixture(), before = structuredClone(original), calls = [];
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const crossref = record('crossref', { last_checked_at: later,
    source_evidence: { url, scope_url: url, method: 'crossref_api', fetched_at: later, body_sha256: 'b'.repeat(64) } });
  const result = await repairPaperMetadata(original, journal, { fields: ['identity'], checkPossibleDuplicate: true, otherPapers: [original, target],
    sources: { crossref: async expected => { calls.push('crossref'); assert.equal(expected.doi, ''); return crossref; },
      openalex: async expected => { calls.push('openalex'); assert.equal(expected.doi, doi); return evidence; },
      semanticscholar: () => assert.fail('Already verified'), publisherArticle: () => assert.fail('No page needed') },
    search: () => assert.fail('No paid search after verified proof') });
  assert.deepEqual(calls, ['crossref', 'openalex']); assert.equal(result.status, 'merge_ready');
  assert.deepEqual(result.paper, before); assert.equal(result.paper.doi, ''); assert.equal(result.duplicate_claims.length, 1);
  assert.equal(result.duplicate_claims[0].target_id, target.id);
  assert.ok(duplicateMergeProof(original, target, result.duplicate_claims[0].record, later));
});

test('稳定来源编号连到已有DOI才形成合并证明，缺作者也不能只凭同名合并', () => {
  const { original, target, evidence } = fixture();
  assert.equal(duplicateMergeProof(original, target, evidence, later).method, 'stable_source_id');
  assert.equal(duplicateMergeProof(original, target, { ...evidence, source_id: 'W99999' }, later), null);
  assert.equal(duplicateMergeProof(original, target, { ...evidence, source_evidence: undefined }, later), null);
  const url = 'https://example.com/fake';
  assert.equal(duplicateMergeProof(original, target, { ...evidence, source_evidence: { ...evidence.source_evidence, url, scope_url: url } }, later), null);
});

test('合并计划保留整个原记录和目标历史，补入有来源的英文并复用完全匹配的已有译文', () => {
  const { original, target, evidence } = fixture(), before = structuredClone({ original, target, evidence });
  const merged = mergeConfirmedDuplicate(original, target, evidence, later);
  assert.deepEqual({ original, target, evidence }, before); assert.deepEqual(merged.archived, original);
  assert.equal(merged.target.id, target.id); assert.equal(merged.target.first_seen_date, target.first_seen_date);
  assert.equal(merged.target.discovered_at, target.discovered_at); assert.equal(merged.target.doi, doi);
  assert.equal(merged.target.abstract_original, abstract); assert.equal(merged.target.abstract_zh, original.abstract_zh);
  assert.equal(merged.target.title_zh, original.title_zh); assert.equal(merged.target.abstract_translation_status, 'done');
  assert.deepEqual(merged.resolution.reused_translations, ['title', 'abstract']);
  assert.equal(merged.resolution.first_seen_date, original.first_seen_date); assert.equal(merged.resolution.discovered_at, original.discovered_at);
  assert.equal(merged.target.source_records.length, 3);
  validatePapers([merged.archived, merged.target], config);
  validateHistoryPreserved([original, target], [merged.archived, merged.target]);
});

test('不同DOI、不同作者或月份、通知类型、未来证据和错误标题均不能自动归并', () => {
  const { original, target, evidence } = fixture();
  for (const patch of [{ doi: '10.1257/different' }, { authors: [{ name: 'Someone Else', orcid: '' }] },
    { publication_date: '2025-08' }, { publication_date: '2026-09' }, { type: 'retraction' }, { type: 'editorial' },
    { title: 'Financial markets and a completely different research question' }]) {
    assert.equal(duplicateMergeProof(original, target, { ...evidence, ...patch }, later), null);
  }
  assert.equal(duplicateMergeProof(original, target, evidence, at), null);
  assert.equal(duplicateMergeProof(original, { ...target, last_checked_at: '2026-09-17T00:00:00.000Z' }, evidence, later), null);
  const titleConflict = structuredClone(original);
  titleConflict.source_records.push(record('openalex', { source_id: 'W-other', title: 'Another completely different paper title' }));
  assert.equal(duplicateMergeProof(titleConflict, target, evidence, later), null);
  assert.equal(duplicateMergeProof({ ...original, doi: '10.1257/other' }, target, evidence, later), null);
  assert.throws(() => mergeConfirmedDuplicate(original, target, { ...evidence, source_id: 'W99999' }, later));
});

test('英文只差大小写标点时也不能复用不匹配的译文哈希，目标已有译文始终保留', () => {
  const { original, evidence } = fixture();
  const target = one(record('crossref', { title: title.toUpperCase() }));
  target.abstract_original = ''; target.abstract_zh = '';
  const first = mergeConfirmedDuplicate(original, target, evidence, later);
  assert.equal(first.target.title_zh, ''); assert.deepEqual(first.resolution.reused_translations, ['abstract']);
  target.title_zh = '目标已有的译文'; target.title_translation_status = 'done';
  const second = mergeConfirmedDuplicate(original, target, evidence, later);
  assert.equal(second.target.title_zh, '目标已有的译文'); assert.equal(second.archived.title_zh, original.title_zh);
});

test('既有原文不被合并记录覆盖，只有日期的历史发现时间仍保持未知时分秒', () => {
  const { original, evidence } = fixture(); delete original.discovered_at;
  const target = one(record('crossref', { abstract: 'A distinct original abstract already stored for the existing record, which must not be overwritten by another version.' }));
  const result = mergeConfirmedDuplicate(original, target, evidence, later);
  assert.equal(result.target.abstract_original, target.abstract_original); assert.equal(result.target.abstract_zh, '');
  assert.equal(result.resolution.first_seen_date, original.first_seen_date); assert.equal(result.resolution.discovered_at, null);
  assert.equal(result.archived.abstract_zh, original.abstract_zh); validatePapers([result.target, result.archived], config);
});

test('已核实的合并证据同时可填作者和真实摘要，不需要为已得到的字段再次请求', () => {
  const original = one(record('openalex', { abstract: '' })), target = one(record('crossref', { authors: [] }));
  const { evidence } = fixture();
  const result = mergeConfirmedDuplicate(original, target, evidence, later);
  assert.deepEqual(result.target.authors, [{ name: 'Alice Smith', orcid: '' }]);
  assert.equal(result.target.abstract_original, abstract);
  assert.equal(result.target.abstract_zh, ''); assert.equal(result.target.abstract_translation_status, 'pending');
  validatePapers([result.archived, result.target], config);
});

test('非同来源编号时必须由原发现记录的作者日期共同支持，不能用新补字段自证', () => {
  const original = one(record('openalex', { authors: ['Alice Smith'] })), target = one(record('crossref'));
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const evidence = record('crossref', { last_checked_at: later,
    source_evidence: { url, scope_url: url, method: 'crossref_api', fetched_at: later, body_sha256: 'b'.repeat(64) } });
  assert.equal(duplicateMergeProof(original, target, evidence, later).method, 'original_authors_and_dates');
  const selfProved = fixture().original; selfProved.authors = [{ name: 'Alice Smith', orcid: '' }];
  assert.equal(duplicateMergeProof(selfProved, target, evidence, later), null);
});
