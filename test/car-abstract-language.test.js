import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { missingOriginalAbstract, verifiedCarEnglishRecord } from '../src/services/carAbstractLanguage.js';
import { extractSearchRecord } from '../src/services/searchExtraction.js';
import { fillMissingMetadata, repairPaperMetadata } from '../src/services/searchMetadata.js';
import { validateMetadataRepairOnlyChange } from '../src/services/metadataRepairValidation.js';
import { buildMasterList } from '../src/services/masterList.js';
import { validatePapers, validateHistoryPreserved } from '../src/services/libraryValidation.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { runMetadataRepair } from '../src/services/metadataRepairRun.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { presentJournalLibrary } from '../src/services/journalPresentation.js';
import { buildTranslationQueue, translationEligibility, createTranslationBatch } from '../src/services/translationQueue.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'CAR');
const at = '2026-09-17T01:00:00.000Z', doi = '10.1111/1911-3846.70065';
const title = 'Accounting information and investment decisions in financial markets';
// Synthetic fixture text only; never written to the formal paper library.
const french = 'RÉSUMÉ Nous étudions les informations comptables et les décisions des investisseurs. '.repeat(6).trim();
const english = 'We study accounting information and investment decisions in financial markets. Our evidence shows that disclosure affects investors and improves the allocation of capital.';
const raw = `${title}\nDOI: ${doi}\nRÉSUMÉ\n${french}\nABSTRACT\nen\n${english}\n1 Introduction\nArticle body.`;
const lead = { title, url: `https://onlinelibrary.wiley.com/doi/full/${doi}`, content: raw };
const answer = { record: { source_index: 0, title, doi, abstract: english } };
function original() {
  return mergePapers([normalizeSourceRecord({ source: 'crossref', source_id: doi, doi, title, abstract: french,
    journal_key: 'CAR', journal_name: journal.name, journal_category: journal.category, journal_category_zh: journal.category_zh,
    print_issn: journal.print_issn, electronic_issn: journal.electronic_issn, authors: ['Alice Smith'],
    publication_date: '2026-09', type: 'journal-article', last_checked_at: at })],
  { firstSeenDate: '2026-09-17', checkedAt: at }).papers[0];
}
const verified = () => extractSearchRecord([lead], original(), journal, async () => answer, at);

test('CAR法文原文公开显示英文待补及重试时间，不清空法文、不误算英文完整', () => {
  const paper = original(), retry = '2026-09-19T01:00:00Z';
  const library = { papers: [paper], manifest: { created_at: at }, runs: [], queue: buildTranslationQueue([paper]),
    repairState: { issues: { sample: { paper_id: paper.id, reason: 'missing_abstract', status: 'pending', updated_at: at,
      attempts: [], next_retry_at: retry } } } };
  const before = JSON.stringify(library), data = presentJournalLibrary(library, config);
  assert.equal(data.papers[0].abstract_status, 'english_missing');
  assert.equal(data.papers[0].abstract_next_retry_at, retry);
  assert.equal(data.papers[0].abstract_original, french); assert.equal(data.enrichment.missing_abstracts, 1);
  assert.equal(JSON.stringify(library), before);
});

test('CAR仅法文摘要等待英文原文再翻译，英文标题可先译，历史队列与指纹不改', async () => {
  const paper = original(), before = buildTranslationQueue([paper]);
  assert.deepEqual(before.tasks.map(task => task.field), ['title', 'abstract']);
  const eligibility = translationEligibility([paper]);
  assert.deepEqual(eligibility.ready.tasks.map(task => task.field), ['title']);
  assert.deepEqual(eligibility.held.tasks.map(task => task.field), ['abstract']);
  assert.deepEqual(createTranslationBatch([paper], { now: new Date(at) }).items[0].requested_fields, ['title']);
  assert.deepEqual(buildTranslationQueue([paper]), before);
  const next = fillMissingMetadata(paper, await verified()).paper;
  assert.deepEqual(translationEligibility([next]).ready.tasks.map(task => task.field), ['title', 'abstract']);
});

test('CAR法文原文非空仍缺英文；旧版名册含义不改，新版进入摘要补查', () => {
  const paper = original();
  assert.equal(missingOriginalAbstract(paper), true);
  assert.equal(missingOriginalAbstract({ ...paper, journal_key: 'JAR' }), false);
  assert.equal(missingOriginalAbstract({ ...paper, abstract_original: english }), false);
  assert.equal(buildMasterList([paper], { generatedAt: at, policyVersion: 4 }).statistics.missing_abstract, 0);
  assert.equal(buildMasterList([paper], { generatedAt: at, policyVersion: 5 }).statistics.missing_abstract, 1);
});

test('CAR仅有完整可追溯的出版社英文原文才替换法文；保留原始版本和已有中文', async () => {
  const paper = original(), record = await verified();
  paper.abstract_zh = '旧法文对应的中文译文'; paper.abstract_translation_status = 'done';
  const before = structuredClone(paper);
  assert.equal(verifiedCarEnglishRecord(record), true);
  const next = fillMissingMetadata(paper, record).paper;
  assert.equal(next.abstract_original, english); assert.equal(next.abstract_zh, paper.abstract_zh);
  assert.equal(next.abstract_translation_status, 'outdated'); assert.deepEqual(paper, before);
  assert.deepEqual(next.source_records[0], paper.source_records[0]);
  validatePapers([next], config); validateHistoryPreserved([paper], [next]);
  validateMetadataRepairOnlyChange([paper], [next]);
  for (const patch of [{ abstract: english + ' Invented addition.' }, { raw_abstract: english },
    { source_evidence: { ...record.source_evidence, body_sha256: 'a'.repeat(64) } },
    { source_evidence: { ...record.source_evidence, url: 'https://example.com/paper' } },
    { source_evidence: { ...record.source_evidence, method: 'model_answer' } }]) {
    const bad = { ...record, ...patch };
    assert.equal(verifiedCarEnglishRecord(bad), false);
    assert.equal(fillMissingMetadata(paper, bad).paper.abstract_original, french);
  }
  const alreadyEnglish = { ...paper, abstract_original: english };
  assert.equal(fillMissingMetadata(alreadyEnglish, { ...record, abstract: 'Changed ' + english }).paper.abstract_original, english);
});

test('后续日常合并不能把已确认英文退回更长的法文，完成译文不重复排队', async () => {
  const paper = fillMissingMetadata(original(), await verified()).paper;
  paper.abstract_zh = '已完成英文翻译'; paper.abstract_translation_status = 'done';
  const later = '2026-09-18T01:00:00.000Z';
  const result = mergePapers([{ ...paper.source_records[0], last_checked_at: later }],
    { existingPapers: [paper], firstSeenDate: '2026-09-18', checkedAt: later, normalizeCar: true });
  assert.equal(result.papers[0].abstract_original, english);
  assert.equal(result.papers[0].abstract_translation_status, 'done');
  assert.equal(result.stats.new_pending_fields, 0);
  validatePapers(result.papers, config); validateHistoryPreserved([paper], result.papers);
});

test('CAR法文摘要三源无英文后使用智谱；成功后不进入SerpAPI且不再重复搜索', async () => {
  const calls = [], unavailable = async () => { throw Object.assign(new Error(), { code: 'NOT_FOUND' }); };
  const sources = { ...Object.fromEntries(['crossref', 'openalex', 'semanticscholar'].map(source =>
    [source, async () => { calls.push(source); return unavailable(); }])), publisherArticle: unavailable,
    searchArticle: async () => { calls.push('zhipu'); return { called: true, result: { leads: [lead], extracted: { record: null } } }; } };
  const result = await repairPaperMetadata(original(), journal, { sources, checkedAt: at,
    search: () => assert.fail('No fallback after verified abstract') });
  assert.deepEqual(calls, ['crossref', 'openalex', 'semanticscholar', 'zhipu']);
  assert.equal(result.paper.abstract_original, english); assert.ok(result.changed_fields.includes('abstract'));
  calls.length = 0;
  await repairPaperMetadata(result.paper, journal, { sources, checkedAt: at, search: () => assert.fail('No repeat') });
  assert.deepEqual(calls, []);
});

test('CAR法文专项修复可保存并重读正式结构快照，摘要待办自动关闭、历史法文不丢失', async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'car-language-test-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('car-language-test-')); await fs.rm(root, { recursive: true, force: true }); });
  const clients = Object.fromEntries(['crossref', 'openalex'].map(source => [source, async () => ({ source,
    journal_key: 'CAR', ok: true, complete: true, records: source === 'crossref' ? original().source_records : [],
    raw_pages: [], raw_count: source === 'crossref' ? 1 : 0, rejected: [], duration_ms: 0, error: null })]));
  await runJournalCollection(config, { root, journalKey: 'CAR', clients, now: () => new Date(at) });
  const before = await readJournalLibrary({ root, config });
  assert.equal(before.masterList.statistics.missing_abstract, 1);
  assert.ok(Object.values(before.repairState.issues).some(issue => issue.field === 'abstract' && issue.status !== 'resolved'));
  const unavailable = async () => { throw Object.assign(new Error(), { code: 'NOT_FOUND' }); };
  const sources = { crossref: unavailable, openalex: unavailable, semanticscholar: unavailable, publisherArticle: unavailable,
    searchArticle: async () => ({ called: true, result: { leads: [lead], extracted: answer } }) };
  const result = await runMetadataRepair(config, { root, journalKey: 'CAR', sources, maxPapers: 0, maxAbstracts: 1,
    search: async () => ({ called: true, result: { leads: [] } }), now: () => new Date('2026-09-17T01:01:00.000Z') });
  const after = await readJournalLibrary({ root, config });
  assert.equal(result.stats.abstracts_checked, 1); assert.equal(result.stats.abstracts_filled, 1);
  assert.equal(after.masterList.statistics.missing_abstract, 0);
  assert.equal(after.papers[0].abstract_original, english);
  assert.equal(after.papers[0].source_records[0].abstract, french);
  assert.equal(after.papers[0].abstract_translation_status, 'pending');
  assert.equal(Object.values(after.repairState.issues).find(issue => issue.field === 'abstract').status, 'resolved');
});
