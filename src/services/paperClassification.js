import { cleanText, normalizeTitleForMatch } from './paperModel.js';

const ADMIN_TITLES = new Set(['front matter', 'back matter', 'table of contents', 'contents',
  'editorial board', 'masthead', 'cover', 'cover image', 'author index', 'subject index', 'copyright information']);
export const CLASSIFICATION_VERSION = 4;
// Independently checked against Crossref's exact DOI, title and journal ISSN.
// These are full administrative titles, not a keyword-based exclusion rule.
const PREFIXED_BOARDS = {
  RP: ['research policy editorial board'],
  JAE: ['journal of accounting and economics editorial board'],
  JFE: ['journal of financial economics editorial board'],
  JCF: ['journal of corporate finance editorial board'],
  MS: ['management science editorial board', 'management sciences editorial board']
};
const JOURNAL_ADMIN_TITLES = {
  JAE: new Set(['editorial data']),
  JPE: new Set(['jpe turnaround times', 'recent referees']),
  JF: new Set(['american finance association', 'announcements'])
};
const result = (kind, rule) => ({ version: CLASSIFICATION_VERSION, kind,
  excluded: kind === 'administrative', rule });

// Narrow, versioned rules: do not delete records simply because they lack an abstract.
export function classifySourceRecord(record, { includePrefixedBoards = true, includeOther = true } = {}) {
  const title = cleanText(record.title);
  const normalized = normalizeTitleForMatch(title);
  // Notice titles take precedence over administrative wording in the quoted original title.
  if (/^(?:retraction|withdrawal)(?:\s*[:：]|\s+(?:of|notice)\b|$)/i.test(title)) {
    return result('possible_retraction', 'notice_title');
  }
  if (/^(?:correction|erratum|corrigendum)(?:\s*[:：]|\s+to\b|$)/i.test(title)) {
    return result('possible_correction', 'notice_title');
  }
  if (ADMIN_TITLES.has(normalized) || /^index to volume \d+$/.test(normalized)) {
    return result('administrative', 'exact_administrative_title');
  }
  if (normalized === 'issue information' ||
      /^issue information\s*[-‐‑‒–—―:：]\s*(?:request for papers|standing call for proposals(?: for)?|call for papers)$/i.test(title)) {
    return result('administrative', 'issue_information_title');
  }
  if (JOURNAL_ADMIN_TITLES[record.journal_key]?.has(normalized)) {
    return result('administrative', 'journal_specific_administrative_title');
  }
  if (includePrefixedBoards && PREFIXED_BOARDS[record.journal_key]?.includes(normalized)) {
    return result('administrative', 'journal_prefixed_editorial_board');
  }
  const type = String(record.type || '').toLowerCase();
  if (type === 'retraction') return result('possible_retraction', 'source_notice_type');
  if (['erratum', 'correction'].includes(type)) return result('possible_correction', 'source_notice_type');
  if (includeOther && /^(?:nobel lecture|presidential address)(?:\s|$)/.test(normalized)) {
    return result('other', 'named_lecture_or_address');
  }
  if (!title || ['paratext', 'editorial', 'book-review'].includes(type)) {
    return result('needs_review', !title ? 'missing_title' : 'source_type_needs_review');
  }
  // Missing authors/abstracts and review articles alone are not exclusion criteria.
  return result('candidate', 'retain_by_default');
}

// Only an explicitly typed, later API record for the SAME identity may supersede
// old type evidence. Publisher defaults and missing types cannot undo a warning.
export function classificationRecords(paper) {
  const records = paper.source_records || [], groups = new Map();
  for (const row of records) {
    const key = `${row.source}:${row.source_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].flatMap(rows => {
    const ordered = [...rows].sort((a, b) => Date.parse(b.last_checked_at) - Date.parse(a.last_checked_at)), newest = ordered[0];
    if (rows.length < 2) return rows;
    const proof = newest.source_evidence;
    const hosts = { crossref: 'api.crossref.org', openalex: 'api.openalex.org', semanticscholar: 'api.semanticscholar.org' };
    const methods = { crossref: 'crossref_api', openalex: 'openalex_api', semanticscholar: 'semanticscholar_abstract_api' };
    let url; try { url = new URL(proof?.url); } catch { return rows; }
    if (!hosts[newest.source] || proof.method !== methods[newest.source] || url.protocol !== 'https:' ||
      url.hostname !== hosts[newest.source] || !/^[a-f0-9]{64}$/.test(proof.body_sha256 || '') ||
      proof.fetched_at !== newest.last_checked_at || !Number.isFinite(Date.parse(proof.fetched_at)) ||
      !['article', 'journal-article', 'review', 'editorial', 'book-review', 'paratext', 'retraction', 'erratum', 'correction'].includes(newest.type)) return rows;
    const sameTitle = row => normalizeTitleForMatch(row.title) === normalizeTitleForMatch(newest.title);
    if (!ordered.slice(1).every(row => Date.parse(row.last_checked_at) < Date.parse(newest.last_checked_at) &&
      row.journal_key === newest.journal_key && row.doi === newest.doi && sameTitle(row) &&
      (!row.source_updated_at || !Number.isFinite(Date.parse(row.source_updated_at)) ||
        (Number.isFinite(Date.parse(newest.source_updated_at)) && Date.parse(newest.source_updated_at) >= Date.parse(row.source_updated_at))))) return rows;
    // Retraction/correction notices remain visible even if a later API changes its type.
    if (rows.some(row => ['possible_retraction', 'possible_correction'].includes(classifySourceRecord(row).kind))) return rows;
    return [newest];
  });
}

// A read-time overlay: historical Master List versions retain their original rules.
export function classifyPaper(paper, { historical = false, includePrefixedBoards = true, includeOther = true } = {}) {
  const records = paper.source_records?.length ? (historical ? paper.source_records : classificationRecords(paper)) :
    [{ title: paper.title_original, journal_key: paper.journal_key }];
  const classes = records.map(row => classifySourceRecord(row, { includePrefixedBoards, includeOther })), kinds = new Set(classes.map((item) => item.kind));
  if (includeOther && kinds.size === 1 && kinds.has('needs_review') &&
      records.every(row => cleanText(row.title) && ['editorial', 'book-review'].includes(String(row.type || '').toLowerCase()))) {
    return result('other', 'confirmed_nonresearch_type');
  }
  if (kinds.size === 1) return includeOther && kinds.has('administrative')
    ? result('other', classes[0].rule) : { ...classes[0] };
  if (kinds.has('possible_retraction')) return result('possible_retraction', 'source_disagreement_notice');
  if (kinds.has('possible_correction')) return result('possible_correction', 'source_disagreement_notice');
  // A disagreeing source is not enough to hide a potentially genuine paper as administrative.
  return result('needs_review', 'source_classification_disagreement');
}

export function filterSourceRecords(records) {
  const accepted = [], excluded = [], notices = [];
  for (const record of records) {
    const classification = classifySourceRecord(record);
    const audit = { source: record.source, source_id: record.source_id, doi: record.doi,
      journal_key: record.journal_key, title: record.title, classification };
    if (classification.excluded) excluded.push(audit);
    else {
      accepted.push(record);
      if (classification.kind !== 'candidate') notices.push(audit);
    }
  }
  return { accepted, excluded, notices };
}
