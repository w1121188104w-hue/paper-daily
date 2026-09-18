import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPaper } from '../src/services/paperClassification.js';
import { buildMasterList, repairRequirements } from '../src/services/masterList.js';
import { buildTranslationQueue, translationEligibility } from '../src/services/translationQueue.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { DOCUMENT_LABELS, documentKind, filterPapers, normalizeDocumentFilter } from '../public/journals/viewModel.js';
const config = await loadJournalConfig(), j = findJournal(config, 'AER'), at = '2026-09-18T01:00:00.000Z';
function record(title, n, type = 'journal-article') {
  return normalizeSourceRecord({ source: 'crossref', source_id: `10.9999/other-${n}`, doi: `10.9999/other-${n}`, title, type,
    abstract: '', authors: ['Test Author'], publication_date: '2026-09-01', last_checked_at: at,
    journal_key: j.key, journal_name: j.name, journal_category: j.category, journal_category_zh: j.category_zh,
    print_issn: j.print_issn, electronic_issn: j.electronic_issn });
}
test('其他统一收纳明确讲座、编委、目录、社论书评，不误收标题含相关词的研究或来源冲突', () => {
  for (const [title, type] of [['Nobel Lecture: Growth', 'journal-article'], ['Presidential Address: Firms', 'journal-article'],
    ['Editorial Board', 'journal-article'], ['Contents', 'journal-article'], ['Editor comments', 'editorial'], ['A book review', 'book-review']])
    assert.equal(classifyPaper({ source_records: [record(title, 1, type)] }).kind, 'other');
  for (const title of ['Nobel lectures and innovation', 'The effects of Nobel lectures', 'Editorial Board Composition and Research Quality', 'Announcements and Returns'])
    assert.equal(classifyPaper({ source_records: [record(title, 1)] }).kind, 'candidate');
  assert.equal(classifyPaper({ source_records: [record('Editor comments', 1, 'editorial'), { ...record('Editor comments', 1), source: 'openalex', source_id: 'W1' }] }).kind, 'needs_review');
  assert.equal(classifyPaper({ source_records: [record('Unclear item', 1, 'paratext')] }).kind, 'needs_review');
  assert.equal(classifyPaper({ source_records: [record('Correction: Nobel Lecture: Growth', 1)] }).kind, 'possible_correction');
});
test('v7其他分类不改任何论文内容和完整队列，旧v6名册仍按原口径读，其他不进入修复和翻译', () => {
  const papers = mergePapers([record('Nobel Lecture: Growth', 1), record('Editorial Board', 2), record('Normal research', 3)],
    { checkedAt: at, firstSeenDate: '2026-09-18' }).papers;
  const before = structuredClone(papers), queue = buildTranslationQueue(papers);
  const old = buildMasterList(papers, { generatedAt: at, policyVersion: 6 });
  const current = buildMasterList(papers, { generatedAt: at, policyVersion: 7 });
  assert.equal(old.entries.find(p => p.doi.endsWith('-1')).classification, 'candidate');
  assert.equal(old.entries.find(p => p.doi.endsWith('-2')).classification, 'administrative');
  assert.equal(current.entries.filter(p => p.classification === 'other').length, 2);
  assert.equal(current.statistics.lectures, 1); assert.equal(current.statistics.total, 3);
  assert.equal(current.statistics.missing_abstract, 3);
  assert.ok(repairRequirements(current).every(i => i.paper_id.endsWith('-3')));
  assert.deepEqual(translationEligibility(papers).eligible.map(p => p.doi), ['10.9999/other-3']);
  assert.deepEqual(papers, before); assert.deepEqual(buildTranslationQueue(papers), queue);
});
test('其他筛选与旧期刊资料链接兼容，只有一个其他选项', () => {
  assert.equal(DOCUMENT_LABELS.other, '其他'); assert.equal(DOCUMENT_LABELS.administrative, undefined);
  assert.equal(normalizeDocumentFilter('administrative'), 'other');
  const rows = [{ id: '1', first_seen_date: '2026-09-18', journal_key: 'AER', classification: { kind: 'other' } },
    { id: '2', first_seen_date: '2026-09-18', journal_key: 'AER', classification: { kind: 'administrative' } },
    { id: '3', first_seen_date: '2026-09-18', journal_key: 'AER', classification: { kind: 'candidate' } }];
  assert.equal(documentKind(rows[1]), 'other');
  assert.equal(filterPapers(rows, { kind: 'other' }).length, 2);
  assert.equal(filterPapers(rows, { kind: 'candidate' }).length, 1);
});
