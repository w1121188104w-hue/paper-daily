import { assertLibrary, isObject, isIsoTime, isDay, isCount, stableJson } from './libraryValidation.js';

export const ABSTRACT_STATUSES = ['found', 'missing', 'not_found', 'publisher_no_abstract', 'access_restricted', 'retry_later', 'identity_unverified'];
export const emptyEnrichmentState = () => ({ schema_version: 1, abstracts: {}, official_last_run_date: '' });
export function validateEnrichmentState(state, papers) {
  assertLibrary(isObject(state) && state.schema_version === 1 && isObject(state.abstracts) &&
    (state.official_last_run_date === '' || isDay(state.official_last_run_date)), '补全状态结构无效');
  const ids = new Set(papers.map(p => p.id));
  for (const [id, row] of Object.entries(state.abstracts)) {
    assertLibrary(ids.has(id) && isObject(row) && ABSTRACT_STATUSES.includes(row.status) &&
      isCount(row.attempt_count) && row.attempt_count > 0 && isIsoTime(row.last_checked_at) &&
      isIsoTime(row.next_retry_at) && Date.parse(row.next_retry_at) > Date.parse(row.last_checked_at) &&
      /^[a-f0-9]{64}$/.test(row.identity_hash), '摘要重试状态无效');
  }
  return state;
}
export function validateEnrichmentRuns(runs) {
  assertLibrary(Array.isArray(runs), '补全日志应为数组');
  const ids = new Set();
  for (const row of runs) {
    assertLibrary(row.schema_version === 1 && /^[A-Za-z0-9-]{10,100}$/.test(row.run_id) && !ids.has(row.run_id) &&
      isDay(row.run_date) && isIsoTime(row.started_at) && isIsoTime(row.finished_at) && row.finished_at >= row.started_at &&
      isDay(row.from_date) && isDay(row.to_date) && row.from_date <= row.to_date &&
      ['success', 'partial', 'restricted'].includes(row.status) && isObject(row.report) && isObject(row.stats) &&
      ['added', 'abstracts_filled', 'abstracts_checked', 'pending_candidates'].every(k => isCount(row.stats[k])), '补全日志无效');
    ids.add(row.run_id);
  }
}
export function validateEnrichmentReport(report, log) {
  assertLibrary(report.schema_version === 1 && report.run_id === log.run_id && report.status === log.status &&
    report.from_date === log.from_date && report.to_date === log.to_date &&
    stableJson(report.stats) === stableJson(log.stats) && Array.isArray(report.journals) && Array.isArray(report.abstracts), '补全日志与报告不一致');
  const keys = new Set();
  for (const journal of report.journals) {
    assertLibrary(!keys.has(journal.journal_key) && /^[A-Z]{2,4}$/.test(journal.journal_key) &&
      ['partial', 'restricted'].includes(journal.coverage) &&
      (journal.official_observed_count === null || isCount(journal.official_observed_count)) &&
      ['existing_total_count', 'official_in_window_count', 'matched_count', 'missing_count', 'added_count', 'pending_count'].every(k => isCount(journal[k])) &&
      journal.added_count <= journal.missing_count && Array.isArray(journal.entries) && Array.isArray(journal.attempts), '期刊核对报告结构无效');
    keys.add(journal.journal_key);
    assertLibrary(journal.added_count === journal.entries.filter(e => e.status === 'added').length &&
      journal.pending_count === journal.entries.filter(e => e.status === 'pending').length, '核对报告计数不一致');
  }
  assertLibrary(report.stats.added === report.journals.reduce((sum,j) => sum+j.added_count,0) &&
    report.stats.abstracts_filled === report.abstracts.filter(a => a.status === 'found').length &&
    report.stats.abstracts_checked === report.abstracts.length, '补全汇总不一致');
}

// Existing entries: only a genuinely missing abstract and its evidence/queue status can change.
export function validateEnrichmentOnlyChange(previous, next) {
  const byId = new Map(next.map(p => [p.id,p]));
  const allowed = new Set(['abstract_original','abstract_translation_status','source_text_hash','sources','source_records','provenance','last_checked_at']);
  const rest = p => Object.fromEntries(Object.entries(p).filter(([k]) => !allowed.has(k)));
  for (const old of previous) {
    const p = byId.get(old.id);
    assertLibrary(p && stableJson(rest(old)) === stableJson(rest(p)), '补全不能改动已有标题、作者、日期或译文');
    assertLibrary(!old.abstract_original || stableJson(old) === stableJson(p), '补全不能改写已有摘要');
    if (stableJson(old) === stableJson(p)) continue;
    assertLibrary(Boolean(p.abstract_original) && p.abstract_translation_status === (old.abstract_zh ? 'outdated' : 'pending') &&
      p.source_text_hash.title === old.source_text_hash.title &&
      stableJson({ ...p.provenance, abstract_original: null }) === stableJson({ ...old.provenance, abstract_original: null }), '补全只能填入缺失的摘要');
  }
}
