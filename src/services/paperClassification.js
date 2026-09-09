import { cleanText, normalizeTitleForMatch } from './paperModel.js';

const ADMIN_TITLES = new Set(['front matter', 'back matter', 'table of contents', 'contents',
  'editorial board', 'masthead', 'cover', 'cover image', 'author index', 'subject index', 'copyright information']);
export const CLASSIFICATION_VERSION = 2;
const JOURNAL_ADMIN_TITLES = {
  JAE: new Set(['editorial data']),
  JPE: new Set(['jpe turnaround times', 'recent referees']),
  JF: new Set(['american finance association', 'announcements'])
};
const result = (kind, rule) => ({ version: CLASSIFICATION_VERSION, kind,
  excluded: kind === 'administrative', rule });

// Narrow, versioned rules: do not delete records simply because they lack an abstract.
export function classifySourceRecord(record) {
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
  const type = String(record.type || '').toLowerCase();
  if (type === 'retraction') return result('possible_retraction', 'source_notice_type');
  if (['erratum', 'correction'].includes(type)) return result('possible_correction', 'source_notice_type');
  if (!title || ['paratext', 'editorial', 'book-review'].includes(type)) {
    return result('needs_review', !title ? 'missing_title' : 'source_type_needs_review');
  }
  // Missing authors/abstracts and review articles alone are not exclusion criteria.
  return result('candidate', 'retain_by_default');
}

// A read-time overlay: do not write classifications into immutable historical snapshots.
export function classifyPaper(paper) {
  const records = paper.source_records?.length ? paper.source_records :
    [{ title: paper.title_original, journal_key: paper.journal_key }];
  const classes = records.map(classifySourceRecord), kinds = new Set(classes.map((item) => item.kind));
  if (kinds.size === 1) return { ...classes[0] };
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
