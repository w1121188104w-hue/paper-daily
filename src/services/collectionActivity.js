import {knownJournalMismatch} from './journalIdentity.js';
import {assertLibrary} from './libraryValidation.js';

export const INDEX_SOURCES = ['crossref','openalex','semanticscholar'];
const validTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const stamp = value => validTime(value) ? new Date(value).toISOString() : null;
const dayFormatter = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
const day = value => dayFormatter.format(new Date(value));
export function validateDiscoveryHistory(rows = []) {
  assertLibrary(Array.isArray(rows) && rows.length <= 100000, '来源检查历史需要归档，不能截断');
  for (const row of rows) assertLibrary(typeof row.journal === 'string' && INDEX_SOURCES.includes(row.source) &&
    ['ok','partial','failed'].includes(row.status) && validTime(row.checked_at), '来源检查历史无效');
  return rows;
}
// Retain the last real attempt per source/journal/Beijing day, including failures
// and successful empty responses. Import/translation times are not source checks.
export function mergeDiscoveryHistory(...groups) {
  const rows = new Map();
  for (const row of groups.flat()) {
    if (!INDEX_SOURCES.includes(row.source) || !['ok','partial','failed'].includes(row.status)) continue;
    const at = stamp(row.checked_at);
    if (!at) continue;
    const key = [day(at),row.journal,row.source].join('|'), old = rows.get(key);
    if (!old || old.checked_at <= at) rows.set(key, {journal:row.journal,source:row.source,status:row.status,checked_at:at});
  }
  return validateDiscoveryHistory([...rows.values()].sort((a,b) => a.checked_at.localeCompare(b.checked_at) ||
    a.journal.localeCompare(b.journal) || a.source.localeCompare(b.source)));
}

// Project accepted publisher evidence and verified catalog baselines only.
// Source bodies, review prompts and private captures never enter the website.
export function collectionActivity(papers, baselines, journalKeys) {
  const allowed = new Set(journalKeys), rows = new Map(), dates = new Map();
  function rowFor(journal, value) {
    const at = stamp(value);
    if (!allowed.has(journal) || !at) return null;
    if (!dates.has(at)) dates.set(at, day(at));
    const date = dates.get(at), key = date+'|'+journal;
    if (!rows.has(key)) rows.set(key, {date,journal_key:journal,captured_at:at,papers:new Set(),catalogs:new Set()});
    const row = rows.get(key);
    if (at > row.captured_at) row.captured_at = at;
    return row;
  }
  for (const paper of papers) {
    if (knownJournalMismatch(paper)) continue;
    for (const source of paper.source_records || []) {
      if (source.source !== 'publisher') continue;
      rowFor(paper.journal_key,source.source_evidence?.fetched_at)?.papers.add(paper.id);
    }
  }
  for (const baseline of baselines || []) if (baseline.complete === true)
    rowFor(baseline.journal,baseline.checked_at)?.catalogs.add(baseline.catalog_id+'|'+baseline.url);
  return [...rows.values()].map(row => ({date:row.date,journal_key:row.journal_key,captured_at:row.captured_at,
    paper_count:row.papers.size,catalog_count:row.catalogs.size})).sort((a,b) => b.captured_at.localeCompare(a.captured_at) ||
      a.journal_key.localeCompare(b.journal_key));
}
