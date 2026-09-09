import {
  buildFallbackFingerprint, buildSourceTextHash, canonicalPaperId, doiUrl,
  normalizeAuthorName, normalizeDate, normalizeSourceRecord, normalizeTitleForMatch
} from './paperModel.js';
import { createHash } from 'node:crypto';

const FIELDS = ['title', 'abstract', 'authors', 'published_online_date', 'published_print_date',
  'publication_date', 'volume', 'issue', 'pages', 'url'];
const nonempty = (value) => Array.isArray(value) ? value.length > 0 : Boolean(value);
const sourceKey = (record) => `${record.source}:${record.source_id}`;
const comparableRecord = ({ last_checked_at, ...record }) => record;
const stableRecord = (record) => JSON.stringify(comparableRecord(record));
const ordered = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function dateInShanghai(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function titleSimilarity(a, b) {
  const left = new Set(normalizeTitleForMatch(a).split(' ').filter(Boolean));
  const right = new Set(normalizeTitleForMatch(b).split(' ').filter(Boolean));
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / new Set([...left, ...right]).size;
}

function authorOverlap(a, b) {
  return a.authors.some((left) => b.authors.some((right) =>
    (left.orcid && left.orcid === right.orcid) ||
    normalizeAuthorName(left.name) === normalizeAuthorName(right.name)));
}

function related(a, b) {
  return a.journal_key === b.journal_key && authorOverlap(a, b) && titleSimilarity(a.title, b.title) >= 0.8;
}

function fingerprintMatches(a, b) {
  const fingerprint = buildFallbackFingerprint(a);
  return fingerprint && fingerprint === buildFallbackFingerprint(b);
}

export function evidence(records, field) {
  // A later correction replaces an earlier value from the SAME source, even when shorter.
  // A missing later value does not erase an earlier available abstract or author list.
  const latest = new Map();
  const sorted = [...records].sort((a, b) =>
    ordered(b.source_updated_at || b.last_checked_at, a.source_updated_at || a.last_checked_at) ||
    ordered(b.last_checked_at, a.last_checked_at) || ordered(stableRecord(a), stableRecord(b)));
  for (const record of sorted) {
    if (nonempty(record[field]) && !latest.has(sourceKey(record))) latest.set(sourceKey(record), record);
  }
  return [...latest.values()];
}

function quality(value) {
  if (Array.isArray(value)) return value.length * 100 + value.reduce((sum, a) => sum + a.name.length + (a.orcid ? 20 : 0), 0);
  const text = String(value || '');
  if (!text) return -1;
  return text.length - (text.match(/\uFFFD/g) || []).length * 1000;
}

function choose(records, field) {
  return evidence(records, field).sort((a, b) => quality(b[field]) - quality(a[field]) ||
    ordered(sourceKey(a), sourceKey(b)))[0] || null;
}

function preserveTranslation(paper, previous) {
  const hash = buildSourceTextHash(paper.title_original, paper.abstract_original);
  for (const field of ['title', 'abstract']) {
    const translated = previous?.[`${field}_zh`] || '';
    const oldStatus = previous?.[`${field}_translation_status`];
    const unchanged = previous?.source_text_hash?.[field] === hash[field];
    paper[`${field}_zh`] = translated;
    paper[`${field}_translation_status`] = !hash[field] && field === 'abstract' ? 'no_abstract'
      : unchanged && oldStatus ? oldStatus : translated ? 'outdated' : 'pending';
  }
  paper.source_text_hash = hash;
  paper.translation_model = previous?.translation_model || '';
  paper.translated_at = previous?.translated_at || '';
  if (previous?.translation_provenance) paper.translation_provenance = structuredClone(previous.translation_provenance);
}

function materialize(group, firstSeenDate, checkedAt) {
  const records = group.records;
  const base = records[0];
  const doi = records.find((record) => record.doi)?.doi || '';
  const paper = { schema_version: 1, id: group.previous?.id || canonicalPaperId({ ...base, doi }),
    doi, doi_url: doiUrl(doi), journal_key: base.journal_key, journal_name: base.journal_name,
    journal_category: base.journal_category, journal_category_zh: base.journal_category_zh,
    print_issn: base.print_issn, electronic_issn: base.electronic_issn,
    first_seen_date: group.previous?.first_seen_date || firstSeenDate,
    last_checked_at: checkedAt, sources: [...new Set(records.map((record) => record.source))].sort(),
    provenance: {}, source_records: records };
  for (const field of FIELDS) {
    const selected = choose(records, field);
    const name = ['title', 'abstract'].includes(field) ? `${field}_original` : field;
    paper[name] = selected ? structuredClone(selected[field]) : field === 'authors' ? [] : '';
    paper.provenance[name] = selected ? { source: selected.source, source_id: selected.source_id } : null;
  }
  // Fill identifiers only for exactly matching names or ORCID; never concatenate author lists.
  const authorCandidates = evidence(records, 'authors').flatMap((record) => record.authors.map((author) => ({ ...author, record })));
  paper.provenance.authors = paper.authors.map((author) => {
    const matches = authorCandidates.filter((candidate) => author.orcid
      ? candidate.orcid === author.orcid
      : normalizeAuthorName(candidate.name) === normalizeAuthorName(author.name));
    const identifiers = [...new Set(matches.map((match) => match.orcid).filter(Boolean))];
    const filled = !author.orcid && identifiers.length === 1 ? matches.find((match) => match.orcid) : null;
    if (filled) author.orcid = filled.orcid;
    return { name: choose(records, 'authors')?.source || '',
      orcid: author.orcid ? (filled?.record.source || choose(records, 'authors')?.source) : null };
  });
  paper.provenance.doi = records.filter((record) => record.doi).map((record) => ({ source: record.source, source_id: record.source_id }))
    .filter((entry, index, list) => list.findIndex((x) => JSON.stringify(x) === JSON.stringify(entry)) === index);
  paper.provenance.journal = { source: 'journals.json', key: base.journal_key };
  preserveTranslation(paper, group.previous);
  return paper;
}

function materialContent({ last_checked_at, source_records, ...paper }) {
  return JSON.stringify(paper);
}

/** Pure merge: no files, HTTP, AI, or mutation of input arrays. */
export function mergePapers(incoming, { existingPapers = [], firstSeenDate = dateInShanghai(),
  checkedAt = new Date().toISOString() } = {}) {
  if (normalizeDate(firstSeenDate) !== firstSeenDate || !firstSeenDate || !Number.isFinite(Date.parse(checkedAt))) {
    throw new Error('合并需要有效的首次发现日期和核对时间');
  }
  const groups = existingPapers.map((paper) => {
    if (!paper.id || !paper.first_seen_date || !paper.source_records?.length) throw new Error('历史论文格式不完整');
    return { previous: structuredClone(paper), records: paper.source_records.map(normalizeSourceRecord), touched: false };
  });
  if (new Set(existingPapers.map((paper) => paper.id)).size !== existingPapers.length) throw new Error('历史论文 ID 重复');
  const audit = [];
  const auditKeys = new Set();
  const addAudit = (type, a, b) => {
    const refs = [sourceKey(a), sourceKey(b)].sort();
    const key = JSON.stringify([type, refs, [a.doi, b.doi].sort()]);
    if (auditKeys.has(key)) return;
    auditKeys.add(key);
    audit.push({ type, records: refs, dois: [...new Set([a.doi, b.doi].filter(Boolean))].sort(), journal_key: a.journal_key });
  };
  const records = incoming.map(normalizeSourceRecord).sort((a, b) =>
    Number(Boolean(b.doi)) - Number(Boolean(a.doi)) || ordered(a.doi, b.doi) || ordered(sourceKey(a), sourceKey(b)) ||
    ordered(stableRecord(a), stableRecord(b)));
  for (const record of records) {
    let candidates = [];
    for (const group of groups) {
      const sameJournal = group.records[0].journal_key === record.journal_key;
      const groupDoi = group.records.find((entry) => entry.doi)?.doi || '';
      const sameId = group.records.some((entry) => sourceKey(entry) === sourceKey(record));
      const sameFingerprint = group.records.some((entry) => fingerprintMatches(entry, record));
      const similar = group.records.some((entry) => related(entry, record));
      if (record.doi && groupDoi === record.doi && !sameJournal) {
        addAudit('journal_conflict', record, group.records[0]);
      } else if (sameJournal && record.doi && groupDoi && record.doi !== groupDoi) {
        if (sameId || sameFingerprint || similar) addAudit('doi_conflict', record, group.records.find((entry) => entry.doi));
      } else if (sameJournal && ((record.doi && record.doi === groupDoi) || sameId || sameFingerprint)) {
        candidates.push(group);
      } else if (sameJournal && similar) {
        addAudit('suspected_duplicate', record, group.records[0]);
      }
    }
    // A DOI-less bridge between two DOI identities must not merge either of them.
    const exactDoi = record.doi && candidates.filter((group) => group.records.some((entry) => entry.doi === record.doi));
    if (exactDoi?.length === 1) candidates = exactDoi;
    let group;
    if (candidates.length === 1) group = candidates[0];
    else {
      if (candidates.length > 1) candidates.forEach((candidate) => addAudit('ambiguous_match', record, candidate.records[0]));
      // Repeated ambiguous records are still idempotent by their own source ID.
      group = candidates.find((candidate) => !candidate.records.some((entry) => entry.doi) &&
        candidate.records.some((entry) => sourceKey(entry) === sourceKey(record)));
      if (!group) { group = { records: [], previous: null, touched: false }; groups.push(group); }
    }
    const same = group.records.find((entry) => stableRecord(entry) === stableRecord(record));
    if (same) same.last_checked_at = [same.last_checked_at, record.last_checked_at].sort().at(-1);
    else group.records.push(structuredClone(record));
    group.touched = true;
  }
  const ids = new Set();
  const stats = { added: 0, updated: 0, unchanged: 0, new_pending_fields: 0 };
  const papers = groups.map((group) => {
    group.records.sort((a, b) => ordered(sourceKey(a), sourceKey(b)) || ordered(stableRecord(a), stableRecord(b)));
    const paper = group.touched ? materialize(group, firstSeenDate, checkedAt) : group.previous;
    if (ids.has(paper.id) && !group.previous) {
      // Ambiguous DOI-less identities can share the same fingerprint even within one journal.
      const identity = `${paper.journal_key}|${[...new Set(group.records.map(sourceKey))].sort().join('|')}`;
      paper.id += `:source:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
    }
    if (ids.has(paper.id)) throw new Error('论文 ID 冲突，需要人工检查');
    ids.add(paper.id);
    if (!group.previous) stats.added++;
    else if (materialContent(paper) !== materialContent(group.previous)) stats.updated++;
    else stats.unchanged++;
    for (const field of ['title', 'abstract']) {
      if (['pending', 'outdated'].includes(paper[`${field}_translation_status`]) &&
          paper.source_text_hash[field] !== group.previous?.source_text_hash?.[field]) stats.new_pending_fields++;
    }
    return paper;
  }).sort((a, b) => ordered(a.id, b.id));
  return { papers, audit, stats };
}
