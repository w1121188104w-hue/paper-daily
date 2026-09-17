import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { publisherCaptureFor, publisherCaptureRecord, verifiedPublisherCapture } from '../src/services/publisherCaptures.js';
import { verifiedCarEnglishRecord } from '../src/services/carAbstractLanguage.js';
import { fillMissingMetadata, repairPaperMetadata } from '../src/services/searchMetadata.js';
import { validateMetadataRepairOnlyChange } from '../src/services/metadataRepairValidation.js';
import { validatePapers, validateHistoryPreserved } from '../src/services/libraryValidation.js';

const capture = JSON.parse(readFileSync(new URL('../data/publisher-captures/car-70065.json', import.meta.url), 'utf8'));
const config = await loadJournalConfig(), journal = findJournal(config, 'CAR'), at = '2026-09-17T17:44:00.000Z';
function paper() {
  return mergePapers([normalizeSourceRecord({ source: 'crossref', source_id: capture.doi,
    doi: capture.doi, title: capture.title, abstract: 'RÉSUMÉ Texte de test synthétique, conservé uniquement dans le test. '.repeat(4),
    journal_key: 'CAR', journal_name: journal.name, journal_category: journal.category,
    journal_category_zh: journal.category_zh, print_issn: journal.print_issn, electronic_issn: journal.electronic_issn,
    authors: capture.authors, publication_date: '2026-07', type: 'journal-article', last_checked_at: at })],
  { firstSeenDate: '2026-09-17', checkedAt: at }).papers[0];
}

test('官网浏览器摘录精确匹配DOI标题期刊，保留原始英文、许可和真实来源，不冒充智谱', () => {
  const original = paper(), record = publisherCaptureRecord(original, journal, at);
  assert.ok(record); assert.equal(record.abstract, capture.abstract);
  assert.equal(record.source_evidence.method, 'publisher_browser_excerpt_v1');
  assert.equal(record.source_evidence.url, capture.source_url);
  assert.equal(record.source_evidence.fetched_at, capture.captured_at);
  assert.match(capture.license_url, /creativecommons.org\/licenses\/by-nc\/4.0/);
  assert.equal(verifiedPublisherCapture(record), true); assert.equal(verifiedCarEnglishRecord(record), true);
  assert.equal(publisherCaptureFor({ ...original, doi: '10.1111/wrong' }, journal), null);
  assert.equal(publisherCaptureFor({ ...original, title_original: 'A different paper' }, journal), null);
  assert.equal(publisherCaptureFor(original, { ...journal, key: 'JAR' }), null);
});

test('浏览器摘要证据不能被篡改、截断或改写；保存英文时保留历史法文和已有中文', () => {
  const original = paper(), record = publisherCaptureRecord(original, journal, at);
  original.abstract_zh = '测试用历史中文'; original.abstract_translation_status = 'done';
  const next = fillMissingMetadata(original, record).paper;
  assert.equal(next.abstract_original, capture.abstract); assert.equal(next.abstract_zh, original.abstract_zh);
  assert.equal(next.abstract_translation_status, 'outdated'); assert.deepEqual(next.source_records[0], original.source_records[0]);
  validatePapers([next], config); validateHistoryPreserved([original], [next]);
  validateMetadataRepairOnlyChange([original], [next]);
  const later = mergePapers([{ ...original.source_records[0], last_checked_at: '2026-09-18T00:00:00.000Z' }],
    { existingPapers: [next], firstSeenDate: '2026-09-18', checkedAt: '2026-09-18T00:00:00.000Z', normalizeCar: true });
  assert.equal(later.papers[0].abstract_original, capture.abstract);
  for (const patch of [{ abstract: capture.abstract + ' Added text.' }, { raw_abstract: record.raw_abstract + 'x' },
    { source_evidence: { ...record.source_evidence, body_sha256: 'a'.repeat(64) } },
    { source_evidence: { ...record.source_evidence, method: 'zhipu_search_verbatim_abstract', url: 'https://example.com' } },
    { source_evidence: { ...record.source_evidence, fetched_at: at } }]) {
    assert.equal(verifiedPublisherCapture({ ...record, ...patch }), false);
  }
});

test('已核实摘录先复用，英文补齐后不再调用外部服务、不覆盖完整英文', async () => {
  const forbidden = () => assert.fail('Verified cached abstract needs no new network call');
  const sources = Object.fromEntries(['crossref', 'openalex', 'semanticscholar', 'publisherArticle', 'searchArticle'].map(k => [k, forbidden]));
  const result = await repairPaperMetadata(paper(), journal, { sources, search: forbidden, fields: ['abstract'], checkedAt: at });
  assert.equal(result.paper.abstract_original, capture.abstract);
  assert.deepEqual(result.changed_fields, ['abstract']);
  assert.equal(result.attempts[0].stage, 'verified_browser_excerpt');
  const again = await repairPaperMetadata(result.paper, journal, { sources, search: forbidden, fields: ['abstract'], checkedAt: at });
  assert.deepEqual(again.changed_fields, []); assert.deepEqual(again.attempts, []);
  assert.deepEqual(again.paper, result.paper);
});
