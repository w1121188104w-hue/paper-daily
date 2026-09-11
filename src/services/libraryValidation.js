import { validateJournalConfig } from './journals.js';
import { normalizeDate, normalizePartialDate, normalizeDoi, normalizeSourceRecord,
  buildSourceTextHash, doiUrl, PAPER_SOURCES } from './paperModel.js';

export class LibraryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const assertLibrary = (condition, message = '正式数据校验失败') => {
  if (!condition) throw new LibraryError('VALIDATION_ERROR', message);
};
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isIsoTime = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) &&
  Number.isFinite(Date.parse(value)) && Boolean(normalizeDate(value));
export const isDay = (value) => typeof value === 'string' && Boolean(value) && normalizeDate(value) === value;
export const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const STRINGS = ['id', 'doi', 'doi_url', 'journal_key', 'journal_name', 'journal_category', 'journal_category_zh',
  'print_issn', 'electronic_issn', 'first_seen_date', 'last_checked_at', 'title_original', 'abstract_original',
  'published_online_date', 'published_print_date', 'publication_date', 'volume', 'issue', 'pages', 'url',
  'title_zh', 'abstract_zh', 'title_translation_status', 'abstract_translation_status', 'translation_model', 'translated_at'];
const PAPER_KEYS = new Set(['schema_version', ...STRINGS, 'sources', 'authors', 'provenance', 'source_records', 'source_text_hash', 'translation_provenance']);
const STAT_KEYS = ['added', 'updated', 'unchanged', 'new_pending_fields'];
export const RUN_STATUSES = ['success', 'no_updates', 'partial_failure', 'full_failure'];

function validateJournalIdentity(paper, journal) {
  assertLibrary(journal && paper.journal_name === journal.name && paper.print_issn === journal.print_issn &&
    paper.electronic_issn === journal.electronic_issn && paper.journal_category === journal.category &&
    paper.journal_category_zh === journal.category_zh, '论文期刊字段与19刊配置不一致');
}

export function validatePapers(papers, config) {
  validateJournalConfig(config);
  assertLibrary(Array.isArray(papers), '论文库必须是数组');
  const journals = new Map(config.journals.map((journal) => [journal.key, journal]));
  const ids = new Set(), dois = new Set();
  for (const paper of papers) {
    assertLibrary(isObject(paper) && paper.schema_version === 1, '论文结构版本无效');
    assertLibrary(Object.keys(paper).every((key) => PAPER_KEYS.has(key)), '论文含未声明字段');
    assertLibrary(STRINGS.every((key) => typeof paper[key] === 'string'), '论文缺少必需的文本字段');
    assertLibrary(paper.id.trim() && paper.title_original.trim() && !ids.has(paper.id), '论文ID或标题为空，或ID重复');
    ids.add(paper.id);
    validateJournalIdentity(paper, journals.get(paper.journal_key));
    assertLibrary(paper.doi === normalizeDoi(paper.doi) && (!paper.doi || /^10\.\d{4,9}\/\S+$/.test(paper.doi)) &&
      paper.doi_url === doiUrl(paper.doi), 'DOI字段无效');
    if (paper.doi) {
      const identity = `${paper.journal_key}|${paper.doi}`;
      assertLibrary(!dois.has(identity), '同刊 DOI 重复'); dois.add(identity);
    }
    assertLibrary(isDay(paper.first_seen_date) && isIsoTime(paper.last_checked_at), '论文发现日期或核对时间无效');
    for (const field of ['publication_date', 'published_online_date', 'published_print_date']) {
      assertLibrary(!paper[field] || normalizePartialDate(paper[field]) === paper[field], '论文出版日期无效');
    }
    assertLibrary(!paper.translated_at || isIsoTime(paper.translated_at), '翻译时间无效');
    assertLibrary(Array.isArray(paper.authors) && paper.authors.every((author) => isObject(author) &&
      typeof author.name === 'string' && author.name.trim() && typeof author.orcid === 'string'), '作者列表无效');
    assertLibrary(Array.isArray(paper.source_records) && paper.source_records.length > 0, '论文缺少原始来源记录');
    const sourceRecords = paper.source_records;
    for (const record of sourceRecords) {
      assertLibrary(isObject(record) && typeof record.source_id === 'string' && typeof record.title === 'string' &&
        typeof record.raw_title === 'string' && typeof record.raw_abstract === 'string', '来源原文不完整');
      let normalized;
      try { normalized = normalizeSourceRecord(record); } catch { assertLibrary(false, '来源记录格式无效'); }
      assertLibrary(stableJson(record) === stableJson(normalized), '来源记录字段不完整或不是规范结构');
      assertLibrary(record.journal_key === paper.journal_key && normalized.doi === record.doi &&
        (!record.doi || record.doi === paper.doi), '来源记录 DOI 或期刊冲突');
      validateJournalIdentity(record, journals.get(record.journal_key));
    }
    assertLibrary(paper.doi === (sourceRecords.find((record) => record.doi)?.doi || ''), 'DOI缺少来源证据');
    assertLibrary(Array.isArray(paper.sources) && stableJson(paper.sources) ===
      stableJson([...new Set(sourceRecords.map((record) => record.source))].sort()), '来源清单不一致');
    assertLibrary(paper.sources.every((source) => PAPER_SOURCES.includes(source)), '来源不在允许范围');
    assertLibrary(isObject(paper.provenance), '缺少字段来源');
    for (const field of ['title_original', 'abstract_original']) {
      const provenance = paper.provenance[field];
      assertLibrary(!paper[field] ? provenance === null : isObject(provenance) && sourceRecords.some((record) =>
        record.source === provenance.source && record.source_id === provenance.source_id &&
        record[field.replace('_original', '')] === paper[field]), '英文原文与标注来源不一致');
    }
    for (const field of ['published_online_date', 'published_print_date', 'publication_date', 'volume', 'issue', 'pages', 'url']) {
      const provenance = paper.provenance[field];
      assertLibrary(!paper[field] ? provenance === null : isObject(provenance) && sourceRecords.some((record) =>
        record.source === provenance.source && record.source_id === provenance.source_id && record[field] === paper[field]), '元数据与字段来源不一致');
    }
    assertLibrary(stableJson(paper.provenance.journal) === stableJson({ source: 'journals.json', key: paper.journal_key }), '期刊来源不一致');
    assertLibrary(Array.isArray(paper.provenance.authors) && paper.provenance.authors.length === paper.authors.length &&
      paper.provenance.authors.every((entry) => isObject(entry) && paper.sources.includes(entry.name) &&
        (entry.orcid === null || paper.sources.includes(entry.orcid))), '作者字段来源无效');
    const hashes = buildSourceTextHash(paper.title_original, paper.abstract_original);
    assertLibrary(stableJson(paper.source_text_hash) === stableJson(hashes), '原文哈希不一致');
    for (const field of ['title', 'abstract']) {
      const statuses = ['pending', 'done', 'failed', 'outdated', ...(field === 'abstract' ? ['no_abstract'] : [])];
      const status = paper[`${field}_translation_status`];
      assertLibrary(statuses.includes(status), '翻译状态无效');
      assertLibrary(!['done', 'outdated'].includes(status) || paper[`${field}_zh`].trim(), '已完成或过时的译文不能为空');
      if (field === 'abstract') assertLibrary(Boolean(paper.abstract_original) === (status !== 'no_abstract'), '摘要状态与原文不符');
    }
    if (paper.translation_provenance !== undefined) {
      assertLibrary(isObject(paper.translation_provenance) && Object.keys(paper.translation_provenance).every((field) => ['title', 'abstract'].includes(field)), '译文字段来源无效');
      for (const [field, entry] of Object.entries(paper.translation_provenance)) {
        assertLibrary(isObject(entry) && typeof entry.model === 'string' && entry.model.trim() &&
          isIsoTime(entry.translated_at) && isIsoTime(entry.imported_at) && /^[a-f0-9]{64}$/.test(entry.source_text_hash) &&
          /^task:[a-f0-9]{64}$/.test(entry.task_id) && /^batch-[a-f0-9]{64}$/.test(entry.batch_id), '译文字段来源不完整');
        if (paper[`${field}_translation_status`] === 'done') assertLibrary(entry.source_text_hash === paper.source_text_hash[field], '完成译文所对应的英文已变化');
      }
    }
  }
  return papers;
}

const sourceVersion = ({ last_checked_at, ...record }) => stableJson(record);
export function validateHistoryPreserved(previous, next) {
  const nextById = new Map(next.map((paper) => [paper.id, paper]));
  for (const old of previous) {
    const current = nextById.get(old.id);
    assertLibrary(current && current.first_seen_date === old.first_seen_date && current.journal_key === old.journal_key &&
      (!old.doi || old.doi === current.doi), '不能删除历史论文或改变首次发现日、期刊、既有DOI');
    const versions = new Set(current.source_records.map(sourceVersion));
    assertLibrary(old.source_records.every((record) => versions.has(sourceVersion(record))), '不能丢弃历史来源原文');
    for (const field of ['title', 'abstract']) {
      assertLibrary(!old[`${field}_zh`] || current[`${field}_zh`], '不能清空已有译文');
    }
  }
}

export function validateRuns(runs) {
  assertLibrary(Array.isArray(runs), '运行日志必须是数组');
  const ids = new Set();
  for (const run of runs) {
    assertLibrary(isObject(run) && run.schema_version === 1 && /^[A-Za-z0-9-]{10,100}$/.test(run.run_id) &&
      !ids.has(run.run_id), '运行日志ID无效或重复'); ids.add(run.run_id);
    assertLibrary(isDay(run.run_date) && isIsoTime(run.started_at) && isIsoTime(run.finished_at) &&
      Date.parse(run.finished_at) >= Date.parse(run.started_at), '运行日志时间无效');
    assertLibrary(isDay(run.from_date) && isDay(run.to_date) && run.from_date <= run.to_date, '日志回查日期无效');
    assertLibrary(RUN_STATUSES.includes(run.status), '运行状态无效');
    assertLibrary(isObject(run.stats) && STAT_KEYS.every((key) => isCount(run.stats[key])), '运行计数无效');
    assertLibrary(Array.isArray(run.journal_keys) && run.journal_keys.every((key) => /^[A-Z][A-Z0-9]{1,7}$/.test(key)), '运行期刊列表无效');
    assertLibrary(Array.isArray(run.sources), '缺少双源运行明细');
    const pairs = new Set();
    for (const source of run.sources) {
      const pair = `${source.journal_key}:${source.source}`;
      assertLibrary(!pairs.has(pair) && run.journal_keys.includes(source.journal_key) && ['openalex', 'crossref'].includes(source.source), '日志来源身份无效');
      pairs.add(pair);
      assertLibrary(['raw_count', 'accepted_count', 'excluded_count', 'rejected_count', 'pages'].every((key) => isCount(source[key])) &&
        Number.isFinite(source.duration_ms) && source.duration_ms >= 0 &&
        typeof source.ok === 'boolean' && typeof source.complete === 'boolean', '来源运行计数或状态无效');
    }
    if (['success', 'no_updates'].includes(run.status)) {
      assertLibrary(run.sources.length === run.journal_keys.length * 2 && run.sources.every((source) => source.ok && source.complete),
        '成功状态必须有每刊双源完整结果');
    }
    if (run.status === 'no_updates') assertLibrary(run.stats.added === 0 && run.stats.updated === 0, '没有新增状态与计数不符');
    if (run.status === 'success') assertLibrary(run.stats.added + run.stats.updated > 0, '成功状态缺少新增或更新');
    if (run.status === 'full_failure') assertLibrary(run.stats.added + run.stats.updated + run.stats.new_pending_fields === 0,
      '完全失败状态不能计入新论文或新翻译任务');
  }
  return runs;
}

const TRANSLATION_MUTABLE = new Set(['title_zh', 'abstract_zh', 'title_translation_status', 'abstract_translation_status',
  'translation_model', 'translated_at', 'translation_provenance']);
export function validateTranslationOnlyChange(previous, next) {
  assertLibrary(previous.length === next.length, '译文导入不能增删论文');
  const byId = new Map(next.map((paper) => [paper.id, paper]));
  const english = (paper) => Object.fromEntries(Object.entries(paper || {}).filter(([key]) => !TRANSLATION_MUTABLE.has(key)));
  for (const old of previous) assertLibrary(byId.has(old.id) && stableJson(english(old)) === stableJson(english(byId.get(old.id))),
    '译文导入不能改变英文、作者、DOI、来源或日历日期');
}

export function validateTranslationImports(imports) {
  assertLibrary(Array.isArray(imports), '翻译导入日志必须是数组');
  const ids = new Set();
  for (const entry of imports) {
    assertLibrary(isObject(entry) && entry.schema_version === 1 && /^[A-Za-z0-9-]{10,100}$/.test(entry.run_id) &&
      !ids.has(entry.run_id), '翻译导入日志ID无效'); ids.add(entry.run_id);
    assertLibrary(isDay(entry.run_date) && isIsoTime(entry.started_at) && isIsoTime(entry.finished_at) &&
      Date.parse(entry.finished_at) >= Date.parse(entry.started_at) && /^batch-[a-f0-9]{64}$/.test(entry.batch_id), '翻译导入日志时间或批次无效');
    assertLibrary(['success', 'partial_failure', 'full_failure', 'no_changes'].includes(entry.status) && isObject(entry.stats) &&
      ['completed_fields', 'failed_fields', 'rejected_fields', 'rejected_rows', 'unchanged_fields', 'changed_papers'].every((key) => isCount(entry.stats[key])), '翻译导入日志状态或计数无效');
    assertLibrary(typeof entry.model === 'string' && entry.model.trim() && isIsoTime(entry.translated_at) && isObject(entry.report), '翻译导入日志来源不完整');
  }
  return imports;
}
