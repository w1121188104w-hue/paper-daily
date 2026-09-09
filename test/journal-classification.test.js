import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJournalConfig } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { classifySourceRecord, classifyPaper, filterSourceRecords } from '../src/services/paperClassification.js';
import { buildTranslationQueue, createTranslationBatch, translationEligibility, validateTranslationBatch } from '../src/services/translationQueue.js';
import { presentJournalLibrary } from '../src/services/journalPresentation.js';
import { filterPapers, documentKind, normalizeDocumentFilter, pageHref } from '../public/journals/viewModel.js';

const config = await loadJournalConfig(), at = '2026-09-08T01:00:00.000Z';
function record(n, title = 'Credit markets and investment', overrides = {}) {
  const j = config.journals.find((item) => item.key === (overrides.journal_key || 'AER'));
  return normalizeSourceRecord({ source: 'crossref', source_id: `10.9999/class-${n}`, doi: `10.9999/class-${n}`,
    title, abstract: 'Synthetic test abstract in 2026.', authors: [{ name: 'Test Alice' }],
    journal_key: j.key, journal_name: j.name, journal_category: j.category, journal_category_zh: j.category_zh,
    print_issn: j.print_issn, electronic_issn: j.electronic_issn, publication_date: '2026-08-01',
    last_checked_at: at, type: 'journal-article', ...overrides });
}
const papers = (records) => mergePapers(records, { firstSeenDate: '2026-09-08', checkedAt: at }).papers;
const classification = (title, extra = {}) => classifySourceRecord({ title, ...extra });

test('期刊信息及已见征稿附页精确识别，兼容大小写和连字符', () => {
  for (const title of ['ISSUE INFORMATION', '<p>Issue Information</p>',
    'Issue Information ‐ Request for Papers', 'Issue Information — Standing Call for Proposals for',
    'Issue Information: Call for Papers']) {
    assert.equal(classification(title).kind, 'administrative', title);
    assert.equal(classification(title).version, 2);
  }
});

test('编务资料规则限于已核查期刊与精确标题，不泛化到别刊', () => {
  for (const [journal_key, title] of [['JAE', 'Editorial data'], ['JPE', 'Recent Referees'],
    ['JPE', 'JPE Turnaround Times'], ['JF', 'AMERICAN FINANCE ASSOCIATION'], ['JF', 'ANNOUNCEMENTS']]) {
    assert.equal(classification(title, { journal_key }).kind, 'administrative');
    assert.equal(classification(title, { journal_key: 'AER' }).kind, 'candidate');
    assert.equal(classification(`${title} and market reactions`, { journal_key }).kind, 'candidate');
  }
});

test('不凭作者、摘要缺失或综述类型排除研究候选', () => {
  for (const title of ['Issue Information and Market Returns', 'Announcements and Asset Prices',
    'Retraction Risk and Investment', 'Correction Mechanisms in Markets', 'Cover and Credit Risk',
    'A Systematic Review of Corporate Disclosure']) {
    const value = classification(title, { authors: [], abstract: '', type: 'review' });
    assert.equal(value.kind, 'candidate'); assert.equal(value.excluded, false);
  }
});

test('未知附属资料、编者文字、书评及缺标题只待核查，不直接删除', () => {
  for (const type of ['paratext', 'editorial', 'book-review']) {
    assert.deepEqual(classification('An ambiguous item', { type }),
      { version: 2, kind: 'needs_review', excluded: false, rule: 'source_type_needs_review' });
  }
  assert.equal(classification(null, { type: 'paratext' }).kind, 'needs_review');
});

test('更正撤稿通知优先识别，引用期刊资料名称也不会被排除', () => {
  for (const title of ['Correction to: Editorial Board', 'Erratum: Issue Information', 'Corrigendum to “Research”']) {
    const value = classification(title); assert.equal(value.kind, 'possible_correction'); assert.equal(value.excluded, false);
  }
  assert.equal(classification('Retraction notice to Research').kind, 'possible_retraction');
  assert.equal(classification('Publisher notice', { type: 'erratum' }).kind, 'possible_correction');
  assert.equal(classification('Publisher notice', { type: 'retraction' }).kind, 'possible_retraction');
});

test('历史合并记录按所有来源判定，资料与候选不一致时保留待核查', () => {
  const input = papers([record(1, 'Issue Information'), record(1, 'Research on firm investment',
    { source: 'openalex', source_id: 'W1' })])[0], before = structuredClone(input);
  assert.equal(classifyPaper(input).kind, 'needs_review'); assert.deepEqual(input, before);
  input.source_records[0].title = 'Correction to: Research on firm investment';
  assert.equal(classifyPaper(input).kind, 'possible_correction');
});

test('采集仍排除明确资料但保留通知、待核查和正常候选，审计含版本依据', () => {
  const result = filterSourceRecords([record(1, 'Issue Information'), record(2, 'Correction to: Research'),
    record(3, 'Ambiguous item', { type: 'editorial' }), record(4)]);
  assert.equal(result.excluded.length, 1); assert.equal(result.accepted.length, 3);
  assert.equal(result.notices.length, 2); assert.equal(result.excluded[0].classification.version, 2);
});

test('翻译完整队列不变，默认导出剔除资料、通知和待核查，数量限制在筛选后计算', () => {
  const rows = papers([record(1, 'Issue Information'), record(2, 'Correction to: Research'),
    record(3, 'Ambiguous item', { type: 'editorial' }), record(4), record(5, 'Systematic Review', { type: 'review' })]);
  const before = structuredClone(rows), full = buildTranslationQueue(rows), eligible = translationEligibility(rows);
  assert.equal(full.paper_count, 5); assert.equal(full.field_count, 10);
  assert.equal(eligible.ready.paper_count, 2); assert.equal(eligible.held.paper_count, 3);
  const batch = createTranslationBatch(rows, { limit: 2, now: new Date(at) });
  assert.equal(batch.items.length, 2); assert.deepEqual(batch.items.map((item) => item.doi).sort(), ['10.9999/class-4', '10.9999/class-5']);
  assert.doesNotThrow(() => validateTranslationBatch(batch)); assert.deepEqual(rows, before);
  assert.deepEqual(buildTranslationQueue(rows), full);
});

test('只有资料或通知时不产生翻译批次内容；缺摘要的候选仍可翻译标题', () => {
  const rows = papers([record(1, 'Issue Information'), record(2, 'Retraction: Study')]);
  assert.equal(createTranslationBatch(rows).items.length, 0);
  const candidate = papers([record(3, 'Study without abstract', { authors: [], abstract: '' })]);
  assert.deepEqual(createTranslationBatch(candidate).items[0].requested_fields, ['title']);
});

test('展示分类和翻译资格只读派生，不改历史论文、队列、采集状态或泄露来源原文', () => {
  const rows = papers([record(1, 'Issue Information'), record(2)]);
  const library = { papers: rows, manifest: { created_at: at }, queue: buildTranslationQueue(rows), runs: [] };
  const before = structuredClone(library), view = presentJournalLibrary(library, config);
  assert.deepEqual(view.classification_summary.counts, { administrative: 1, candidate: 1 });
  assert.deepEqual(view.translation_eligibility, { ready: { paper_count: 1, field_count: 2 }, held: { paper_count: 1, field_count: 2 } });
  assert.equal(view.papers.length, 2); assert.equal(view.pending.field_count, 4);
  assert.ok(!JSON.stringify(view).includes('source_records')); assert.deepEqual(library, before);
});

test('文献类型与期刊、学科、关键词、首次发现日期取交集，跳转保留类型', () => {
  const library = { papers: papers([record(1, 'Issue Information'), record(2)]),
    manifest: null, queue: buildTranslationQueue([]), runs: [] };
  const view = presentJournalLibrary(library, config);
  assert.equal(filterPapers(view.papers, { kind: 'all' }).length, 2);
  assert.equal(filterPapers(view.papers, { kind: 'administrative', journal: 'AER', category: 'economics', q: 'issue', date: '2026-09-08' }).length, 1);
  assert.equal(filterPapers(view.papers, { kind: 'candidate', q: 'issue' }).length, 0);
  assert.ok(pageHref('day.html', { kind: 'administrative', journal: 'AER' }, { date: '2026-09-08' }).includes('kind=administrative'));
});

test('缺失或未知展示分类不会冒充研究候选，非法类型参数退回默认候选', () => {
  assert.equal(documentKind({}), 'needs_review'); assert.equal(documentKind({ classification: { kind: '<script>' } }), 'needs_review');
  assert.equal(normalizeDocumentFilter('all'), 'all'); assert.equal(normalizeDocumentFilter('unknown'), 'candidate');
});
