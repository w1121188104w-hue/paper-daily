import { createHash } from 'node:crypto';
import { normalizePartialDate, normalizeTitleForMatch } from './paperModel.js';
import { evidence } from './paperMerge.js';
import { classifyPaper } from './paperClassification.js';
import { assertLibrary, isIsoTime, stableJson } from './libraryValidation.js';
import { paperDocumentType, evidenceWindowStatus } from './paperScope.js';
import { titleConsensusFor } from './titleConsensus.js';
import { missingOriginalAbstract } from './carAbstractLanguage.js';

export const DISCOVERY_SOURCES = ['crossref', 'openalex', 'semanticscholar', 'publisher'];
const flag = { crossref: 'found_crossref', openalex: 'found_openalex', semanticscholar: 'found_semantic_scholar', publisher: 'found_official_site' };
const identityTitle = title => normalizeTitleForMatch(title).replace(/\s/g, '');
const hash = value => createHash('sha256').update(stableJson(value)).digest('hex');

// Publisher discovery is proved by the official LIST report, not by an abstract lookup.
export function officialDiscoveries(reports = []) {
  const ids = new Set();
  for (const report of reports) for (const journal of report.journals || []) {
    for (const entry of journal.entries || []) if (['existing', 'added'].includes(entry.status) && entry.paper_id) ids.add(entry.paper_id);
  }
  const redirects = new Map(reports.flatMap(report => report.stage === 'duplicate_resolution'
    ? (report.merges || []).map(merge => [merge.resolution.original_id, merge.resolution.target_id]) : []));
  for (const id of [...ids]) {
    let current = id; const visited = new Set();
    while (redirects.has(current)) {
      assertLibrary(!visited.has(current), '归并身份引用存在循环'); visited.add(current);
      current = redirects.get(current);
    }
    ids.add(current);
  }
  return ids;
}

export function discoverySourcesFor(paper, officialIds = new Set()) {
  const found = new Set();
  for (const record of paper.source_records) {
    const method = record.source_evidence?.method;
    // Legacy primary-source rows came from the independent journal collector.
    // DOI/title lookups already carry *_api evidence and must not count as independent discovery.
    if (['crossref', 'openalex'].includes(record.source) && !method) found.add(record.source);
    if (method === 'semanticscholar_discovery_api') found.add('semanticscholar');
  }
  if (officialIds.has(paper.id)) found.add('publisher');
  return DISCOVERY_SOURCES.filter(source => found.has(source));
}

export function publicationFor(paper) {
  for (const [field, basis] of [['published_online_date', 'online'], ['published_print_date', 'print'], ['publication_date', 'unspecified']]) {
    const records = evidence(paper.source_records, field).filter(record => normalizePartialDate(record[field]));
    if (!records.length) continue;
    const years = [...new Set(records.map(record => record[field].slice(0, 4)))];
    const months = [...new Set(records.map(record => record[field]).filter(date => date.length >= 7).map(date => date.slice(0, 7)))];
    const conflict = years.length > 1 || months.length > 1;
    const ordered = [...records].sort((a, b) => b[field].length - a[field].length || a.source.localeCompare(b.source));
    const chosen = ordered[0];
    return { publication_year: years.length === 1 ? Number(years[0]) : null,
      publication_month: !conflict && months.length === 1 ? months[0] : null,
      publication_basis: basis, publication_conflict: conflict,
      publication_source: conflict ? null : { source: chosen.source, source_id: chosen.source_id, field },
      publication_evidence: records.map(record => ({ source: record.source, source_id: record.source_id, field, value: record[field] })) };
  }
  const years = [...new Set(paper.source_records.map(record => record.raw_dates?.publication_year)
    .filter(year => Number.isInteger(year) && year >= 1000 && year <= 9999))];
  return { publication_year: years.length === 1 ? years[0] : null, publication_month: null,
    publication_basis: 'unknown', publication_conflict: years.length > 1, publication_source: null, publication_evidence: [] };
}

// Use exactly the same title/journal/year boundary in execution and the Master
// List. A missing year remains ambiguous; metadata repair may later separate it.
export function possibleDuplicatePeers(paper, papers) {
  const title = identityTitle(paper.title_original), year = publicationFor(paper).publication_year;
  return papers.filter(other => {
    if (other.id === paper.id || other.journal_key !== paper.journal_key || identityTitle(other.title_original) !== title) return false;
    const otherYear = publicationFor(other).publication_year;
    return !year || !otherYear || year === otherYear;
  });
}

export function publicationWindowStatus(publication, fromDate, toDate) {
  if (!fromDate || !toDate || publication.publication_conflict) return 'unknown';
  const month = publication.publication_month;
  if (month) {
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const first = `${month}-01`;
    if (last < fromDate || first > toDate) return 'outside';
    return first >= fromDate && last <= toDate ? 'inside' : 'boundary_uncertain';
  }
  const year = publication.publication_year;
  return year && (year < Number(fromDate.slice(0, 4)) || year > Number(toDate.slice(0, 4))) ? 'outside' : 'unknown';
}

function abstractProvenance(paper) {
  if (!paper.abstract_original) return { abstract_source: null, abstract_source_url: null };
  const selected = paper.provenance.abstract_original;
  const record = paper.source_records.find(row => row.source === selected?.source && row.source_id === selected?.source_id && row.abstract === paper.abstract_original);
  const url = record?.source_evidence?.url || (record?.source === 'crossref' && paper.doi
    ? `https://api.crossref.org/works/${encodeURIComponent(paper.doi)}`
    : record?.source === 'openalex' && /^W\d+$/.test(record.source_id) ? `https://openalex.org/${record.source_id}` : null);
  return { abstract_source: record?.source || null, abstract_source_url: url };
}

export function buildMasterList(papers, { generatedAt, fromDate = null, toDate = null, officialIds = new Set(), policyVersion = 1 } = {}) {
  assertLibrary(isIsoTime(generatedAt), '总名册生成时间无效');
  assertLibrary([1, 2, 3, 4, 5, 6].includes(policyVersion), '不支持的总名册统计规则版本');
  const entries = [...papers].sort((a, b) => a.id.localeCompare(b.id)).map(paper => {
    const publication = publicationFor(paper), found = discoverySourcesFor(paper, officialIds);
    const titles = [...new Set(evidence(paper.source_records, 'title').map(record => identityTitle(record.title)))];
    const classificationOptions = { historical: policyVersion < 4, includePrefixedBoards: policyVersion >= 6 };
    const classification = classifyPaper(paper, classificationOptions).kind;
    const resolution = policyVersion >= 3 ? titleConsensusFor(paper)?.summary || null : null;
    const titleConflict = titles.length > 1 && !resolution;
    const conflicts = [...(titleConflict ? ['title_conflict'] : []), ...(publication.publication_conflict ? ['publication_month_conflict'] : [])];
    const missing = [...(!paper.doi ? ['doi'] : []), ...(!paper.authors.length ? ['authors'] : []),
      ...(!publication.publication_month ? ['publication_month'] : []),
      ...((policyVersion >= 5 ? missingOriginalAbstract(paper) : !paper.abstract_original) ? ['abstract'] : [])];
    return { id: paper.id, title: paper.title_original, doi: paper.doi || null, journal: paper.journal_key,
      journal_name: paper.journal_name, authors: paper.authors.map(author => ({ ...author })),
      abstract: paper.abstract_original || null, ...abstractProvenance(paper), ...publication,
      discovered_at: paper.discovered_at || null, discovered_at_precision: paper.discovered_at ? 'timestamp' : 'day',
      first_seen_date: paper.first_seen_date,
      ...Object.fromEntries(DISCOVERY_SOURCES.map(source => [flag[source], found.includes(source)])),
      discovery_sources: found, available_sources: [...paper.sources],
      doi_status: paper.doi ? 'available' : 'no_doi_yet',
      identity_status: titleConflict ? 'conflict' : paper.doi || paper.authors.length ? 'confirmed' : 'candidate',
      ...(policyVersion >= 3 ? { identity_resolution: resolution } : {}),
      classification, ...(policyVersion >= 2 ? paperDocumentType(paper, classificationOptions) : {}),
      window_status: policyVersion >= 2 ? evidenceWindowStatus(publication, fromDate, toDate,
        publicationWindowStatus(publication, fromDate, toDate)) : publicationWindowStatus(publication, fromDate, toDate),
      metadata_status: missing.length || conflicts.length ? 'incomplete' : 'complete', missing_fields: missing, conflicts };
  });
  // Keep both ambiguous identities, but make the cross-paper ambiguity an automatic task.
  const titles = new Map();
  for (const row of entries) {
    const key = `${row.journal}|${identityTitle(row.title)}`;
    if (!titles.has(key)) titles.set(key, []); titles.get(key).push(row);
  }
  for (const group of titles.values()) for (const row of group) {
    if (group.some(other => other.id !== row.id && (!row.publication_year || !other.publication_year || row.publication_year === other.publication_year))) {
      row.conflicts.push('possible_duplicate'); row.identity_status = 'conflict'; row.metadata_status = 'incomplete';
    }
  }
  const isResearch = row => policyVersion >= 2 ? row.research_candidate : row.classification === 'candidate';
  const counts = rows => ({ total: rows.length, research_candidates: rows.filter(isResearch).length,
    ...(policyVersion >= 2 ? {
      lectures: rows.filter(row => row.document_type === 'lecture').length,
      research_confirmed_inside_window: rows.filter(row => isResearch(row) && row.window_status === 'inside').length,
      research_uncertain_window: rows.filter(row => isResearch(row) && ['unknown', 'boundary_uncertain'].includes(row.window_status)).length,
      research_outside_window: rows.filter(row => isResearch(row) && row.window_status === 'outside').length
    } : {}),
    ...Object.fromEntries(['doi', 'authors', 'publication_month', 'abstract'].map(field => [`missing_${field}`, rows.filter(row => row.missing_fields.includes(field)).length])),
    independent_source_union: rows.filter(row => row.discovery_sources.some(source => source !== 'publisher')).length,
    official_only: rows.filter(row => row.found_official_site && !row.discovery_sources.some(source => source !== 'publisher')).length,
    confirmed_inside_window: rows.filter(row => row.window_status === 'inside').length,
    uncertain_window: rows.filter(row => ['unknown', 'boundary_uncertain'].includes(row.window_status)).length,
    by_discovery_source: Object.fromEntries(DISCOVERY_SOURCES.map(source => [source, rows.filter(row => row.discovery_sources.includes(source)).length])) });
  return { schema_version: 1, ...(policyVersion >= 2 ? { policy_version: policyVersion } : {}), generated_at: generatedAt, from_date: fromDate, to_date: toDate,
    coverage: 'not_proven_complete', entries, statistics: counts(entries),
    journals: [...new Set(entries.map(row => row.journal))].sort().map(journal => ({ journal, ...counts(entries.filter(row => row.journal === journal)) })) };
}

export function repairRequirements(master) {
  const requirements = [];
  for (const row of master.entries) {
    if (row.classification === 'administrative') continue;
    const problems = [...row.missing_fields.map(field => ({ field, reason: `missing_${field}` })),
      ...row.conflicts.map(reason => ({ field: ['title_conflict', 'possible_duplicate'].includes(reason) ? 'identity' : 'publication_month', reason })),
      ...(row.discovery_sources.length === 1 && !row.found_official_site ? [{ field: 'identity', reason: 'single_source_confirmation' }] : []),
      ...(row.classification === 'needs_review' ? [{ field: 'classification', reason: 'document_type_uncertain' }] : [])];
    for (const problem of problems) requirements.push({
      id: `issue:${hash([row.id, problem.reason])}`, paper_id: row.id, journal_key: row.journal, ...problem,
      input_hash: hash([row.journal, identityTitle(row.title), row.doi, row.authors, row.publication_year, row.publication_month, problem.reason])
    });
  }
  return requirements;
}
