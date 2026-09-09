import { assertLibrary, isObject, isIsoTime, stableJson, validatePapers, validateHistoryPreserved } from './libraryValidation.js';
import { TRANSLATION_FIELDS, QUEUED_STATUSES, validateTranslationBatch } from './translationQueue.js';

const RESULT_KEYS = new Set(['schema_version', 'batch_id', 'model', 'translated_at', 'items']);
const ROW_KEYS = new Set(['id', 'source_text_hash', 'title_zh', 'abstract_zh', 'failed_fields']);
const CODES = {
  INVALID_ROW: '结果条目结构无效', DUPLICATE_ID: '同一论文出现多次，无法确定应采用哪条', UNKNOWN_ID: '论文不属于本批清单或已不在当前库中',
  NOT_REQUESTED: '这个字段不在本次待翻译清单中', MISSING_HASH: '结果缺少该字段的原文指纹',
  WRONG_BATCH_HASH: '结果指纹与导出清单不一致', STALE_SOURCE: '当前英文原文已变化，旧译文未采用',
  AMBIGUOUS_FIELD: '同一字段同时提交译文和失败标记', ALREADY_DONE_CONFLICT: '当前字段已有完成译文，不能用不同文本覆盖',
  INELIGIBLE_STATUS: '当前字段不处于待处理状态', EMPTY_TRANSLATION: '译文为空', NON_BODY_TEXT: '译文包含提示语、占位符或标记代码',
  NOT_CHINESE: '译文缺少中文正文', TOO_SHORT: '译文异常短，需要人工核查', MISSING_NUMBERS: '译文遗漏原文中的数字',
  EXPLICIT_FAILURE: '该字段被主动标记为翻译失败'
};

function numbers(text) {
  return new Set(text.normalize('NFKC').replace(/\b\d{1,3}(?:,\d{3})+\b/g, (value) => value.replaceAll(',', '')).match(/\d+(?:\.\d+)?/g) || []);
}

// A mechanical guardrail, NOT a judgment of semantic fidelity. Never silently shorten or rewrite translations.
export function translationQualityError(source, value, field) {
  if (typeof value !== 'string' || !value.trim()) return 'EMPTY_TRANSLATION';
  const text = value.trim();
  if (/```|<\/?[A-Za-z][^>]*>|(?:^|\n)\s*(?:译文|翻译结果|中文翻译)\s*[:：]|待翻译|请填写|作为(?:一个)?AI|作为人工智能|无法(?:完成)?翻译|以下是.*翻译|\b(?:TODO|PLACEHOLDER|as an AI|I cannot translate|here is the translation)\b/i.test(text)) return 'NON_BODY_TEXT';
  if ((text.match(/\p{Script=Han}/gu) || []).length < 2) return 'NOT_CHINESE';
  const size = [...text.replace(/\s/g, '')].length, sourceSize = [...source.replace(/\s/g, '')].length;
  const minimum = field === 'abstract' ? Math.max(8, Math.ceil(sourceSize * 0.18)) : Math.max(2, Math.ceil(sourceSize * 0.12));
  if (size < minimum) return 'TOO_SHORT';
  const actual = numbers(text);
  if ([...numbers(source)].some((number) => !actual.has(number))) return 'MISSING_NUMBERS';
  return null;
}

export function validateTranslationResult(result, batch, importedAt) {
  validateTranslationBatch(batch);
  assertLibrary(isObject(result) && Object.keys(result).every((key) => RESULT_KEYS.has(key)) && result.schema_version === 1 &&
    result.batch_id === batch.batch_id && Array.isArray(result.items) && result.items.length <= 200, '翻译结果结构或批次ID无效');
  assertLibrary(typeof result.model === 'string' && result.model.trim() && result.model.length <= 120 &&
    !/请填写|待填写|TODO|PLACEHOLDER/i.test(result.model), '请填写实际使用的翻译模型标识，不得使用占位文字');
  assertLibrary(isIsoTime(importedAt) && isIsoTime(result.translated_at) &&
    Date.parse(result.translated_at) <= Date.parse(importedAt) + 300000 &&
    Date.parse(result.translated_at) >= Date.parse(batch.exported_at) - 300000, '翻译完成时间无效或明显超出本批时间范围');
}

/** Per-field import. Invalid/stale fields never block independent valid fields. No I/O, AI, or input mutation. */
export function applyTranslationResult(papers, batch, result, { config, importedAt = new Date().toISOString() } = {}) {
  validatePapers(papers, config); validateTranslationResult(result, batch, importedAt);
  const next = structuredClone(papers), byId = new Map(next.map((paper) => [paper.id, paper]));
  const requested = new Map(batch.items.map((item) => [item.id, item]));
  const occurrences = new Map();
  for (const row of result.items) if (typeof row?.id === 'string') occurrences.set(row.id, (occurrences.get(row.id) || 0) + 1);
  const report = { schema_version: 1, batch_id: batch.batch_id,
    stats: { completed_fields: 0, failed_fields: 0, rejected_fields: 0, rejected_rows: 0, unchanged_fields: 0, changed_papers: 0 }, fields: [] };
  const add = (index, id, field, action, code = null) => {
    report.fields.push({ index, id: requested.has(id) ? id : null, field, action, code, message: code ? CODES[code] : null });
    report.stats[action === 'rejected' && field === null ? 'rejected_rows' : `${action}_fields`]++;
  };
  for (const [index, row] of result.items.entries()) {
    if (!isObject(row) || Object.keys(row).some((key) => !ROW_KEYS.has(key)) || typeof row.id !== 'string' || !isObject(row.source_text_hash) ||
      Object.keys(row.source_text_hash).some((key) => !TRANSLATION_FIELDS.includes(key)) ||
      (row.failed_fields !== undefined && (!Array.isArray(row.failed_fields) || row.failed_fields.some((field) => !TRANSLATION_FIELDS.includes(field))))) {
      add(index, row?.id, null, 'rejected', 'INVALID_ROW'); continue;
    }
    if (occurrences.get(row.id) > 1) { add(index, row.id, null, 'rejected', 'DUPLICATE_ID'); continue; }
    const paper = byId.get(row.id), item = requested.get(row.id);
    if (!paper || !item) { add(index, row.id, null, 'rejected', 'UNKNOWN_ID'); continue; }
    for (const field of TRANSLATION_FIELDS) {
      const hasValue = Object.hasOwn(row, `${field}_zh`), explicitFailure = row.failed_fields?.includes(field);
      if (!hasValue && !explicitFailure) continue; // Omitted fields are unfinished, not failures.
      if (!item.requested_fields.includes(field)) { add(index, row.id, field, 'rejected', 'NOT_REQUESTED'); continue; }
      if (!row.source_text_hash[field]) { add(index, row.id, field, 'rejected', 'MISSING_HASH'); continue; }
      if (row.source_text_hash[field] !== item.source_text_hash[field]) { add(index, row.id, field, 'rejected', 'WRONG_BATCH_HASH'); continue; }
      if (row.source_text_hash[field] !== paper.source_text_hash[field]) { add(index, row.id, field, 'rejected', 'STALE_SOURCE'); continue; }
      if (hasValue && explicitFailure) { add(index, row.id, field, 'rejected', 'AMBIGUOUS_FIELD'); continue; }
      const value = typeof row[`${field}_zh`] === 'string' ? row[`${field}_zh`].trim() : row[`${field}_zh`];
      const status = paper[`${field}_translation_status`];
      if (status === 'done') {
        if (hasValue && value === paper[`${field}_zh`]) add(index, row.id, field, 'unchanged');
        else add(index, row.id, field, 'rejected', 'ALREADY_DONE_CONFLICT');
        continue;
      }
      if (!QUEUED_STATUSES.includes(status)) { add(index, row.id, field, 'rejected', 'INELIGIBLE_STATUS'); continue; }
      const error = explicitFailure ? 'EXPLICIT_FAILURE' : translationQualityError(paper[`${field}_original`], value, field);
      if (error) {
        paper[`${field}_translation_status`] = 'failed'; // Keep any older translation and its provenance.
        add(index, row.id, field, 'failed', error); continue;
      }
      paper[`${field}_zh`] = value;
      paper[`${field}_translation_status`] = 'done';
      paper.translation_provenance ||= {};
      paper.translation_provenance[field] = { model: result.model.trim(), translated_at: result.translated_at, imported_at: importedAt,
        source_text_hash: paper.source_text_hash[field], task_id: item.task_ids[field], batch_id: batch.batch_id };
      if (!paper.translated_at || Date.parse(result.translated_at) >= Date.parse(paper.translated_at)) {
        paper.translation_model = result.model.trim(); paper.translated_at = result.translated_at;
      }
      add(index, row.id, field, 'completed');
    }
  }
  report.stats.changed_papers = next.filter((paper, index) => stableJson(paper) !== stableJson(papers[index])).length;
  const bad = report.stats.failed_fields + report.stats.rejected_fields + report.stats.rejected_rows;
  const good = report.stats.completed_fields + report.stats.unchanged_fields;
  report.status = bad ? good ? 'partial_failure' : 'full_failure' : report.stats.completed_fields ? 'success' : 'no_changes';
  validatePapers(next, config); validateHistoryPreserved(papers, next);
  return { papers: next, report, status: report.status };
}
