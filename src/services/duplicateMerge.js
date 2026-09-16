import { buildSourceTextHash, normalizeSourceRecord } from './paperModel.js';
import { titleIdentity, authorOverlap, compatibleDates } from './enrichmentSources.js';
import { evidenceAllowed } from './sourceConfirmation.js';
import { classifyPaper, classifySourceRecord } from './paperClassification.js';
import { publicationFor } from './masterList.js';
import { unresolvedTitleConflict } from './titleConsensus.js';
import { fillMissingMetadata } from './searchMetadata.js';
import { assertLibrary, isIsoTime, stableJson } from './libraryValidation.js';

const discoveryRecord = row => !row.source_evidence ||
  ['semanticscholar_discovery_api', 'publisher_rss', 'article_without_abstract', 'article_metadata_abstract'].includes(row.source_evidence.method);
const compatibleAuthors = (a, b) => !a.authors.length || !b.authors.length || authorOverlap(a.authors, b.authors);

/** A DOI collision is a candidate, never a license to discard an identity.
 * Proof must connect a DOI-less original discovery to the existing DOI record.
 * Newly filled canonical fields cannot provide circular proof for themselves. */
export function duplicateMergeProof(original, target, input, checkedAt) {
  let record; try { record = normalizeSourceRecord(input); } catch { return null; }
  if (!original || !target || original.id === target.id || original.doi || !target.doi ||
    original.journal_key !== target.journal_key || record.journal_key !== target.journal_key || record.doi !== target.doi ||
    !isIsoTime(checkedAt) || [original, target].some(p => !isIsoTime(p.last_checked_at) || Date.parse(p.last_checked_at) > Date.parse(checkedAt)) ||
    !evidenceAllowed(record) || Date.parse(record.source_evidence.fetched_at) > Date.parse(checkedAt) ||
    Date.parse(record.last_checked_at) !== Date.parse(record.source_evidence.fetched_at)) return null;
  if (![original, target].every(paper => classifyPaper(paper).kind === 'candidate' && !unresolvedTitleConflict(paper)) ||
    classifySourceRecord(record).kind !== 'candidate') return null;
  const title = titleIdentity(original.title_original);
  if (title.length < 24 || titleIdentity(target.title_original) !== title || titleIdentity(record.title) !== title ||
    !compatibleAuthors(original, record) || !compatibleAuthors(target, record) || !compatibleAuthors(original, target)) return null;
  const publications = [original, target, { source_records: [record] }].map(publicationFor);
  if (publications.some(p => p.publication_conflict) ||
    new Set(publications.map(p => p.publication_year).filter(Boolean)).size > 1 ||
    new Set(publications.map(p => p.publication_month).filter(Boolean)).size > 1) return null;
  const anchors = original.source_records.filter(row => discoveryRecord(row) && !row.doi &&
    row.journal_key === record.journal_key && titleIdentity(row.title) === title &&
    isIsoTime(row.last_checked_at) && Date.parse(row.last_checked_at) <= Date.parse(record.source_evidence.fetched_at));
  const anchor = anchors.find(row => compatibleAuthors(row, record) &&
    ((row.source === record.source && row.source_id === record.source_id) ||
      (row.authors.length && target.authors.length && record.authors.length &&
        authorOverlap(row.authors, record.authors) && authorOverlap(target.authors, record.authors) &&
        compatibleDates(row, record) && compatibleDates(target, record))));
  if (!anchor) return null;
  // All retained rows must be consistent with the chosen journal and DOI.
  if (original.source_records.some(row => row.journal_key !== target.journal_key || (row.doi && row.doi !== target.doi))) return null;
  return { record, anchor: { source: anchor.source, source_id: anchor.source_id },
    method: anchor.source === record.source && anchor.source_id === record.source_id ? 'stable_source_id' : 'original_authors_and_dates' };
}

/** Pure proposed merge. The original is returned intact for archival retention.
 * Persistence must retain both identities and independently replay this operation. */
export function mergeConfirmedDuplicate(original, target, input, checkedAt) {
  const proof = duplicateMergeProof(original, target, input, checkedAt);
  assertLibrary(proof, '重复记录缺少可追溯的同一论文身份证据');
  let merged = structuredClone(target);
  const candidates = [...original.source_records, proof.record];
  for (const row of candidates) if (!merged.source_records.some(existing => stableJson(existing) === stableJson(row))) merged.source_records.push(structuredClone(row));
  merged.sources = [...new Set(merged.source_records.map(row => row.source))].sort();
  const changed = [];
  // Adopt only original, already sourced canonical values from the retained record.
  // The lookup's raw response is preserved; normal metadata repair can use it later.
  if (!merged.authors.length && original.authors.length) {
    merged.authors = structuredClone(original.authors); merged.provenance.authors = structuredClone(original.provenance.authors); changed.push('authors');
  }
  for (const field of ['abstract_original', 'published_online_date', 'published_print_date', 'publication_date', 'volume', 'issue', 'pages', 'url']) {
    if (!merged[field] && original[field]) {
      merged[field] = original[field]; merged.provenance[field] = structuredClone(original.provenance[field]); changed.push(field);
    }
  }
  const supplemented = fillMissingMetadata(merged, proof.record);
  merged = supplemented.paper; changed.push(...supplemented.changed_fields);
  merged.source_text_hash = buildSourceTextHash(merged.title_original, merged.abstract_original);
  if (!target.abstract_original && merged.abstract_original) merged.abstract_translation_status = target.abstract_zh ? 'outdated' : 'pending';
  const reused = [];
  for (const field of ['title', 'abstract']) {
    // Keep an existing target translation; retain conflicting alternatives in archive.
    if (!merged[`${field}_zh`] && original[`${field}_translation_status`] === 'done' && original[`${field}_zh`] &&
      merged.source_text_hash[field] && merged.source_text_hash[field] === original.source_text_hash[field]) {
      merged[`${field}_zh`] = original[`${field}_zh`]; merged[`${field}_translation_status`] = 'done';
      if (original.translation_provenance?.[field]) {
        merged.translation_provenance ||= {};
        merged.translation_provenance[field] = structuredClone(original.translation_provenance[field]);
      }
      reused.push(field);
    }
  }
  if (reused.length && !merged.translation_model) merged.translation_model = original.translation_model;
  if (reused.length && !merged.translated_at) merged.translated_at = original.translated_at;
  merged.last_checked_at = checkedAt;
  const earliestDay = [original.first_seen_date, target.first_seen_date].sort()[0];
  const earliest = [original, target].filter(p => p.first_seen_date === earliestDay);
  // A day-only first discovery must never acquire an invented precise timestamp.
  const earliestTime = earliest.every(p => p.discovered_at) ? earliest.map(p => p.discovered_at).sort((a, b) => Date.parse(a) - Date.parse(b))[0] : null;
  return { target: merged, archived: structuredClone(original), resolution: {
    schema_version: 1, original_id: original.id, target_id: target.id, doi: target.doi, merged_at: checkedAt,
    method: proof.method, anchor: proof.anchor, evidence: proof.record,
    first_seen_date: earliestDay, discovered_at: earliestTime, changed_fields: changed, reused_translations: reused
  } };
}
