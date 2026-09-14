import { normalizeDoi, normalizeTitleForMatch, normalizeAuthorName } from './paperModel.js';
import { publisherFor } from './publisherCatalog.js';
import { isIsoTime, stableJson } from './libraryValidation.js';

const key = normalizeTitleForMatch;
const authorKey = author => normalizeAuthorName(author.name).split(' ').filter(Boolean).sort().join(' ');
const authors = record => [...new Set((record.authors || []).map(authorKey).filter(Boolean))].sort();
const date = record => record.published_online_date || record.publication_date || record.published_print_date || '';

/** Deliberately NOT fuzzy matching: one adjacent letter transposition in one
 * long word, otherwise identical long titles. Numbers/short titles are excluded. */
export function isSingleTitleTransposition(left, right) {
  const a = key(left).split(' '), b = key(right).split(' ');
  if (a.length < 5 || a.length !== b.length || key(left).length < 24) return false;
  const different = a.map((word, i) => word === b[i] ? -1 : i).filter(i => i >= 0);
  if (different.length !== 1) return false;
  const x = a[different[0]], y = b[different[0]];
  if (x.length < 5 || x.length !== y.length || !/^[a-z]+$/.test(x + y)) return false;
  const changed = [...x].map((letter, i) => letter === y[i] ? -1 : i).filter(i => i >= 0);
  return changed.length === 2 && changed[1] === changed[0] + 1 && x[changed[0]] === y[changed[1]] && x[changed[1]] === y[changed[0]];
}

function apiEvidence(record, doi, journal) {
  try {
    if (record.doi !== doi || record.journal_key !== journal || !['crossref', 'openalex'].includes(record.source) ||
      record.source_evidence?.method !== `${record.source}_api` || !isIsoTime(record.source_evidence.fetched_at) ||
      !/^[a-f0-9]{64}$/.test(record.source_evidence.body_sha256)) return false;
    const u = new URL(record.source_evidence.url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || record.source_evidence.scope_url !== u.href) return false;
    const expected = record.source === 'crossref' ? `/works/${doi}` : `/works/https://doi.org/${doi}`;
    return u.hostname === `api.${record.source}.org` && decodeURIComponent(u.pathname).toLowerCase() === expected &&
      (record.source === 'crossref' ? normalizeDoi(record.source_id) === doi : /^W\d+$/.test(record.source_id));
  } catch { return false; }
}
function officialEvidence(record, doi, journal) {
  try {
    const e = record.source_evidence, p = publisherFor({ ...record, key: journal });
    return record.source === 'publisher' && record.doi === doi && record.journal_key === journal &&
      e && isIsoTime(e.fetched_at) && /^[a-f0-9]{64}$/.test(e.body_sha256) &&
      (e.method === 'publisher_rss' || /^article_/.test(e.method)) && [e.url, e.scope_url, record.url].every(value => {
        const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && p.hosts.includes(u.hostname);
      });
  } catch { return false; }
}

/** Corroboration is derived from preserved original rows, never a writable
 * "trusted" boolean. It does not claim independent publication discovery. */
export function titleConsensusFor(paper, additional = []) {
  const doi = normalizeDoi(paper.doi), journal = paper.journal_key;
  if (!doi) return null;
  const rows = [...(paper.source_records || []), ...additional].filter(row => row && typeof row === 'object');
  const cr = rows.filter(r => r.source === 'crossref' && apiEvidence(r, doi, journal));
  const oa = rows.filter(r => r.source === 'openalex' && apiEvidence(r, doi, journal));
  if (!cr.length || !oa.length || new Set([...cr, ...oa].map(r => key(r.title))).size !== 1) return null;
  const pair = [cr.at(-1), oa.at(-1)], canonical = key(pair[0].title);
  const names = authors(pair[0]);
  if (!names.length || stableJson(names) !== stableJson(authors(pair[1]))) return null;
  for (const a of pair[0].authors) {
    const b = pair[1].authors.find(b => authorKey(a) === authorKey(b));
    if (a.orcid && b?.orcid && a.orcid !== b.orcid) return null;
  }
  if (date(pair[0]).length < 7 || date(pair[1]).length < 7 || date(pair[0]).slice(0, 7) !== date(pair[1]).slice(0, 7)) return null;
  if (paper.authors?.length && stableJson(authors(paper)) !== stableJson(names)) return null;
  const anchor = rows.find(r => officialEvidence(r, doi, journal) && isSingleTitleTransposition(r.title, pair[0].title));
  if (!anchor || ![canonical, key(anchor.title)].includes(key(paper.title_original)) ||
    rows.some(r => ![canonical, key(anchor.title)].includes(key(r.title)))) return null;
  if (!pair.every(r => [r.print_issn, r.electronic_issn].filter(Boolean).some(issn => [anchor.print_issn, anchor.electronic_issn].includes(issn)))) return null;
  return { records: pair, summary: { status: 'corroborated_minor_typo', rule: 'doi_two_api_adjacent_transposition',
    original_title: paper.title_original, corroborated_title: pair[0].title,
    evidence: pair.map(r => ({ source: r.source, source_id: r.source_id, ...r.source_evidence })) } };
}

export function consensusAllowsRecord(paper, record, evidence = []) {
  const proof = titleConsensusFor(paper, evidence);
  return Boolean(proof?.records.some(row => stableJson(row) === stableJson(record)));
}

export function unresolvedTitleConflict(paper) {
  return new Set((paper.source_records || []).map(r => key(r.title))).size > 1 && !titleConsensusFor(paper);
}
