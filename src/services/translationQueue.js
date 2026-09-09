import { createHash } from 'node:crypto';
import { buildSourceTextHash } from './paperModel.js';
import { assertLibrary, isObject, isIsoTime, stableJson } from './libraryValidation.js';
import { classifyPaper } from './paperClassification.js';

export const TRANSLATION_FIELDS = ['title', 'abstract'];
export const QUEUED_STATUSES = ['pending', 'failed', 'outdated'];
const hash = (value) => createHash('sha256').update(stableJson(value)).digest('hex');
export const translationTaskId = (id, field, sourceHash) => `task:${hash([id, field, sourceHash])}`;

/** A derived queue: one task per paper/field/current English hash, never an append-only to-do list. */
export function buildTranslationQueue(papers) {
  const tasks = [];
  for (const paper of [...papers].sort((a, b) => a.first_seen_date.localeCompare(b.first_seen_date) || a.id.localeCompare(b.id))) {
    for (const field of TRANSLATION_FIELDS) {
      const status = paper[`${field}_translation_status`], sourceHash = paper.source_text_hash[field];
      if (paper[`${field}_original`] && sourceHash && QUEUED_STATUSES.includes(status)) {
        tasks.push({ task_id: translationTaskId(paper.id, field, sourceHash), paper_id: paper.id, field,
          source_text_hash: sourceHash, status });
      }
    }
  }
  return { schema_version: 1, tasks, field_count: tasks.length,
    paper_count: new Set(tasks.map((task) => task.paper_id)).size,
    by_status: Object.fromEntries(QUEUED_STATUSES.map((status) => [status, tasks.filter((task) => task.status === status).length])) };
}

export const translationBatchId = (items) => `batch-${hash(items)}`;

// Keep buildTranslationQueue unchanged: old snapshots contain hashes of that complete queue.
export function translationEligibility(papers) {
  const eligible = papers.filter((paper) => classifyPaper(paper).kind === 'candidate');
  const ids = new Set(eligible.map((paper) => paper.id));
  return { eligible, ready: buildTranslationQueue(eligible),
    held: buildTranslationQueue(papers.filter((paper) => !ids.has(paper.id))) };
}

export function createTranslationBatch(papers, { limit = 10, journalKey, now = new Date(), sourceManifest = null } = {}) {
  assertLibrary(Number.isInteger(limit) && limit >= 1 && limit <= 100, '每批论文数量应为1–100');
  const selected = translationEligibility(journalKey ? papers.filter((paper) => paper.journal_key === journalKey) : papers).eligible;
  const queue = buildTranslationQueue(selected), byId = new Map(selected.map((paper) => [paper.id, paper]));
  const ids = [...new Set(queue.tasks.map((task) => task.paper_id))].slice(0, limit);
  const items = ids.map((id) => {
    const paper = byId.get(id), tasks = queue.tasks.filter((task) => task.paper_id === id);
    return { id, doi: paper.doi, journal_key: paper.journal_key, journal_name: paper.journal_name,
      authors: paper.authors.map((author) => author.name), title_original: paper.title_original,
      abstract_original: paper.abstract_original, source_text_hash: { ...paper.source_text_hash },
      requested_fields: tasks.map((task) => task.field), task_ids: Object.fromEntries(tasks.map((task) => [task.field, task.task_id])),
      field_status: Object.fromEntries(tasks.map((task) => [task.field, task.status])) };
  });
  return { schema_version: 1, batch_id: translationBatchId(items), exported_at: now.toISOString(), source_manifest: sourceManifest, items };
}

export function validateTranslationBatch(batch) {
  assertLibrary(isObject(batch) && batch.schema_version === 1 && Array.isArray(batch.items) &&
    batch.items.length > 0 && batch.items.length <= 100 && isIsoTime(batch.exported_at), '翻译清单结构无效或为空');
  assertLibrary(batch.batch_id === translationBatchId(batch.items), '翻译清单内容与批次指纹不符');
  const ids = new Set();
  for (const item of batch.items) {
    assertLibrary(isObject(item) && typeof item.id === 'string' && item.id && !ids.has(item.id), '清单论文ID无效或重复');
    ids.add(item.id);
    assertLibrary(typeof item.title_original === 'string' && item.title_original && typeof item.abstract_original === 'string' &&
      stableJson(item.source_text_hash) === stableJson(buildSourceTextHash(item.title_original, item.abstract_original)), '清单英文原文与哈希不符');
    assertLibrary(Array.isArray(item.requested_fields) && item.requested_fields.length > 0 &&
      new Set(item.requested_fields).size === item.requested_fields.length && isObject(item.task_ids) && isObject(item.field_status), '清单字段无效');
    for (const field of item.requested_fields) {
      assertLibrary(TRANSLATION_FIELDS.includes(field) && item[`${field}_original`] && QUEUED_STATUSES.includes(item.field_status[field]) &&
        item.task_ids[field] === translationTaskId(item.id, field, item.source_text_hash[field]), '清单任务指纹或状态无效');
    }
  }
  return batch;
}

export function translationResponseTemplate(batch) {
  validateTranslationBatch(batch);
  return { schema_version: 1, batch_id: batch.batch_id, model: '', translated_at: '',
    items: batch.items.map((item) => ({ id: item.id,
      source_text_hash: Object.fromEntries(item.requested_fields.map((field) => [field, item.source_text_hash[field]])),
      ...Object.fromEntries(item.requested_fields.map((field) => [`${field}_zh`, ''])) })) };
}
