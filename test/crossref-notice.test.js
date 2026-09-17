import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeCrossrefWork } from '../src/services/sourceNormalizers.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { classifySourceRecord, classifyPaper } from '../src/services/paperClassification.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { fillMissingMetadata } from '../src/services/searchMetadata.js';
import { evidenceHash } from '../src/services/evidenceHttp.js';
import { validatePapers, validateHistoryPreserved } from '../src/services/libraryValidation.js';
import { validateMetadataRepairOnlyChange } from '../src/services/metadataRepairValidation.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'RP');
const at = '2026-09-17T18:10:00.000Z', originalDoi = '10.1016/j.respol.2026.105542';
const doi = '10.1016/j.respol.2026.105588';
const base = { DOI: doi, ISSN: [journal.print_issn], type: 'journal-article',
  title: ['Connectivity infrastructure and innovation: The effects of headquarters versus subsidiary management'],
  author: [{ given: 'Catherine', family: 'Magelssen' }],
  published: { 'date-parts': [[2026, 9, 10]] } };
const update = (type = 'erratum', DOI = originalDoi) => ({ DOI, type, source: 'publisher', label: 'Erratum',
  updated: { 'date-parts': [[2026, 9, 10]] } });

test('Crossref update-to勘误不因标题与原论文相同而当研究论文；保留原类型及关联DOI', () => {
  const item = { ...base, 'update-to': [update()] }, before = structuredClone(item);
  const record = normalizeCrossrefWork(item, journal, at);
  assert.deepEqual(item, before); assert.equal(record.type, 'erratum');
  assert.deepEqual(record.crossref_notice, { policy: 'crossref_update_to_v1', original_type: 'journal-article',
    updates: [{ doi: originalDoi, type: 'erratum' }] });
  assert.equal(classifySourceRecord(record).kind, 'possible_correction');
  assert.equal(classifySourceRecord(record).excluded, false);
  assert.equal(record.publication_date, '2026-09-10'); assert.equal(record.abstract, '');
  assert.deepEqual(normalizeSourceRecord(record), record);
});

test('updated-by不反向标记原论文，自身更新、普通版本变更、无效DOI及格式不推定勘误', () => {
  const unchanged = normalizeCrossrefWork(base, journal, at);
  for (const value of [undefined, null, {}, [], [update('erratum', doi)], [update('new_version')],
    [update('addendum')], [update('erratum', 'not-a-doi')], [null], ['erratum']]) {
    assert.deepEqual(normalizeCrossrefWork({ ...base, 'update-to': value }, journal, at), unchanged);
  }
  assert.deepEqual(normalizeCrossrefWork({ ...base, 'updated-by': [update()] }, journal, at), unchanged);
  assert.equal(unchanged.type, 'journal-article');
  assert.equal(Object.hasOwn(unchanged, 'crossref_notice'), false);
});

test('纠正和撤回通知的规范化类型有界，不能通过额外字段或来源伪装篡改通知', () => {
  for (const type of ['correction', 'corrigendum', 'retraction', 'partial_retraction', 'withdrawal']) {
    const record = normalizeCrossrefWork({ ...base, 'update-to': [update(type)] }, journal, at);
    assert.equal(classifySourceRecord(record).kind, ['correction', 'corrigendum'].includes(type) ? 'possible_correction' : 'possible_retraction');
  }
  const record = normalizeCrossrefWork({ ...base, 'update-to': [update()] }, journal, at);
  for (const patch of [{ type: 'journal-article' }, { source: 'openalex' },
    { crossref_notice: { ...record.crossref_notice, updates: [{ doi, type: 'erratum' }] } },
    { crossref_notice: { ...record.crossref_notice, updates: [{ doi: originalDoi, type: 'new_version' }] } },
    { crossref_notice: { ...record.crossref_notice, extra: true } }]) {
    assert.throws(() => normalizeSourceRecord({ ...record, ...patch }), /通知证据格式/);
  }
});

test('同名原论文与勘误始终保留两个DOI；新增通知证据不改摘要、不删历史、不冒充已补齐', () => {
  const oldRecord = normalizeCrossrefWork(base, journal, '2026-09-16T18:10:00.000Z');
  const old = mergePapers([oldRecord], { firstSeenDate: '2026-09-16', checkedAt: oldRecord.last_checked_at }).papers[0];
  const item = { ...base, 'update-to': [update()] };
  const record = normalizeCrossrefWork(item, journal, at);
  record.source_evidence = { url: 'https://api.crossref.org/works/' + doi, scope_url: 'https://api.crossref.org/works/' + doi,
    fetched_at: at, method: 'crossref_api', body_sha256: evidenceHash(JSON.stringify(item)) };
  const next = fillMissingMetadata(old, record);
  assert.deepEqual(next.changed_fields, []); assert.equal(next.paper.abstract_original, '');
  assert.deepEqual(next.paper.source_records[0], oldRecord);
  assert.equal(classifyPaper(next.paper).kind, 'possible_correction');
  validatePapers([next.paper], config); validateHistoryPreserved([old], [next.paper]);
  validateMetadataRepairOnlyChange([old], [next.paper]);
  const original = normalizeCrossrefWork({ ...base, DOI: originalDoi }, journal, at);
  const combined = mergePapers([original], { existingPapers: [next.paper], firstSeenDate: '2026-09-17', checkedAt: at });
  assert.equal(combined.papers.length, 2);
  assert.deepEqual(new Set(combined.papers.map(p => p.doi)), new Set([doi, originalDoi]));
  assert.equal(classifyPaper(combined.papers.find(p => p.doi === originalDoi)).kind, 'candidate');
});
