import { buildSourceTextHash, doiUrl, normalizeSourceRecord } from './paperModel.js';
import { titleIdentity, authorOverlap, recordDate } from './enrichmentSources.js';
import { authenticAbstract } from './publisherParsers.js';
import { publisherFor } from './publisherCatalog.js';
import { publicationFor } from './masterList.js';
import { paperSearchQuery, searchWithFallback, safeSearchLink } from './searchSources.js';
import { stableJson } from './libraryValidation.js';
import { EvidenceError } from './evidenceHttp.js';
import { titleConsensusFor, consensusAllowsRecord, unresolvedTitleConflict } from './titleConsensus.js';

export function repairIdentityMatches(paper, record) {
  if (paper.journal_key !== record.journal_key || titleIdentity(paper.title_original) !== titleIdentity(record.title)) return false;
  if (paper.doi && record.doi) return paper.doi === record.doi;
  if (titleIdentity(paper.title_original).length < 24) return false;
  if (paper.authors.length && record.authors.length && !authorOverlap(paper.authors, record.authors)) return false;
  const left = recordDate(paper), right = recordDate(record);
  return !(left && right && left.slice(0, 4) !== right.slice(0, 4));
}

// Preserve existing canonical content, translations, first discovery time and paper ID.
// Whole original source rows are retained; missing canonical fields alone may be adopted.
export function fillMissingMetadata(paper, input, { otherPapers = [], identityEvidence = [] } = {}) {
  const record = normalizeSourceRecord(input);
  if (!record.source_evidence || (!repairIdentityMatches(paper, record) && !consensusAllowsRecord(paper, record, identityEvidence))) throw new EvidenceError('UNVERIFIED_IDENTITY');
  if (!paper.doi && record.doi && otherPapers.some(other => other.id !== paper.id && other.doi === record.doi)) throw new EvidenceError('DOI_ALREADY_ASSIGNED');
  const next = structuredClone(paper), changed = [];
  const previousPublication = publicationFor(paper);
  if (!next.doi && record.doi) { next.doi = record.doi; next.doi_url = doiUrl(record.doi); changed.push('doi'); }
  if (!next.authors.length && record.authors.length) {
    next.authors = structuredClone(record.authors);
    next.provenance.authors = record.authors.map(author => ({ name: record.source, orcid: author.orcid ? record.source : null }));
    changed.push('authors');
  }
  for (const field of ['published_online_date', 'published_print_date', 'publication_date']) {
    const old = next[field], candidate = record[field];
    if (!previousPublication.publication_month && candidate && (!old || (old.length < 7 && candidate.startsWith(old) && candidate.length >= 7))) {
      next[field] = candidate; next.provenance[field] = { source: record.source, source_id: record.source_id }; changed.push(field);
    }
  }
  if (!next.abstract_original && authenticAbstract(record.abstract)) {
    next.abstract_original = record.abstract;
    next.provenance.abstract_original = { source: record.source, source_id: record.source_id };
    next.source_text_hash = buildSourceTextHash(next.title_original, next.abstract_original);
    next.abstract_translation_status = next.abstract_zh ? 'outdated' : 'pending'; changed.push('abstract');
  }
  const known = next.source_records.some(row => stableJson(row) === stableJson(record));
  if (!known) { next.source_records.push(record); next.sources = [...new Set(next.source_records.map(row => row.source))].sort(); }
  const publication = publicationFor(next);
  if (previousPublication.publication_month && previousPublication.publication_month !== publication.publication_month) throw new EvidenceError('PUBLICATION_MONTH_CONFLICT');
  if (!known || changed.length) next.last_checked_at = record.last_checked_at;
  return { paper: next, changed_fields: changed };
}
const missingFields = paper => [...(!paper.doi ? ['doi'] : []), ...(!paper.authors.length ? ['authors'] : []),
  ...(!publicationFor(paper).publication_month ? ['publication_month'] : []), ...(!paper.abstract_original ? ['abstract'] : [])];
const safeCode = error => /^[A-Z_]{3,50}$/.test(error?.code || '') ? error.code : 'SOURCE_UNAVAILABLE';

/** Second phase: THREE structured lookups first; only then search known-paper missing fields.
 * One verified page can repair several fields. Neither search snippets nor LLM output are admissible. */
export async function repairPaperMetadata(paper, journal, { sources, search, otherPapers = [], fields = missingFields(paper) } = {}) {
  let current = paper; const attempts = [], changed = new Set(), wanted = new Set(fields), candidates = [];
  const stillMissing = () => [...missingFields(current).filter(field => wanted.has(field)),
    ...(wanted.has('identity') && unresolvedTitleConflict(current) ? ['identity'] : [])];
  function adopt(record, identityEvidence = []) {
    const result = fillMissingMetadata(current, record, { otherPapers, identityEvidence });
    result.changed_fields.forEach(field => changed.add(field)); current = result.paper; return result;
  }
  for (const source of ['crossref', 'openalex', 'semanticscholar']) {
    if (!stillMissing().length) break;
    try {
      const record = await sources[source](current, journal); candidates.push(record);
      try { const result = adopt(record); attempts.push({ source, status: result.changed_fields.length ? 'filled' : 'no_new_fields' }); }
      catch (error) {
        const proof = error.code === 'UNVERIFIED_IDENTITY' ? titleConsensusFor(current, candidates) : null;
        if (!proof) throw error;
        for (const row of proof.records) adopt(row, candidates);
        attempts.push({ source, status: 'corroborated_minor_typo' });
      }
    }
    catch (error) { if (error.code === 'EVIDENCE_STORAGE_ERROR') throw error; attempts.push({ source, status: safeCode(error) }); }
  }
  // Known official feeds/article URLs are evidence sources, not search results.
  // Try them before spending search quota; never accept a snippet as an abstract.
  if (stillMissing().includes('abstract') && typeof sources.publisher === 'function') {
    try {
      const result = adopt(await sources.publisher(current, journal));
      attempts.push({ source: 'publisher', status: result.changed_fields.length ? 'filled' : 'no_new_fields' });
    } catch (error) {
      if (error.code === 'EVIDENCE_STORAGE_ERROR') throw error;
      attempts.push({ source: 'publisher', status: safeCode(error) });
    }
  }
  let searchResult = null;
  if (stillMissing().length && search) {
    searchResult = await searchWithFallback({ queryFor: provider => paperSearchQuery(current, provider),
      search: request => search({ ...request, taskId: `metadata:${paper.id}` }),
      verifyLead: async lead => {
        const url = safeSearchLink(lead.url);
        if (!url) return { resolved: false, reason: 'UNSAFE_LINK' };
        if (!publisherFor(journal).hosts.includes(new URL(url).hostname)) return { resolved: false, reason: 'NOT_OFFICIAL_HOST' };
        // Only the fetched ORIGINAL official article is parsed. lead.snippet is deliberately unused.
        const record = await sources.publisherArticle({ ...current, url }, journal);
        adopt(record);
        return { resolved: !stillMissing().length, reason: 'UNRESOLVED_FIELDS', record };
      } });
    attempts.push(...searchResult.attempts.map(({ provider, ...row }) => ({ source: provider, ...row })));
  }
  return { paper: current, changed_fields: [...changed], missing_fields: stillMissing(), attempts,
    identity_resolution: titleConsensusFor(current)?.summary || null,
    status: !stillMissing().length ? 'resolved' : searchResult?.status || 'source_unavailable' };
}
