import { buildSourceTextHash, doiUrl, normalizeSourceRecord } from './paperModel.js';
import { titleIdentity, authorOverlap, recordDate } from './enrichmentSources.js';
import { authenticAbstract } from './publisherParsers.js';
import { publisherFor } from './publisherCatalog.js';
import { publicationFor, possibleDuplicatePeers } from './masterList.js';
import { paperSearchQuery, abstractSearchQueries, searchWithFallback, safeSearchLink } from './searchSources.js';
import { stableJson } from './libraryValidation.js';
import { EvidenceError } from './evidenceHttp.js';
import { titleConsensusFor, consensusAllowsRecord, unresolvedTitleConflict } from './titleConsensus.js';
import { supportedRepecUrl, repecJournalUrl } from './repecAbstract.js';
import { repecCatalogUrl } from './repecCatalog.js';
import { singleSourceConfirmationFor } from './sourceConfirmation.js';
import { classifyPaper } from './paperClassification.js';
import { duplicateMergeProof } from './duplicateMerge.js';
import { verifiedSearchRecord } from './searchExtraction.js';
import { missingOriginalAbstract, needsCarEnglishAbstract, verifiedCarEnglishRecord } from './carAbstractLanguage.js';
import { publisherCaptureRecord } from './publisherCaptures.js';

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
  if ((!next.abstract_original || (needsCarEnglishAbstract(next) && verifiedCarEnglishRecord(record))) && authenticAbstract(record.abstract)) {
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
  ...(!publicationFor(paper).publication_month ? ['publication_month'] : []), ...(missingOriginalAbstract(paper) ? ['abstract'] : [])];
const safeCode = error => /^[A-Z_]{3,50}$/.test(error?.code || '') ? error.code : 'SOURCE_UNAVAILABLE';

/** Second phase: THREE structured lookups first; only then search known-paper missing fields.
 * One verified page can repair several fields. Neither search snippets nor LLM output are admissible. */
export async function repairPaperMetadata(paper, journal, { sources, search, otherPapers = [], fields = missingFields(paper), confirmSingleSource = false, checkPossibleDuplicate = false, checkedAt = new Date().toISOString() } = {}) {
  let current = paper; const attempts = [], changed = new Set(), wanted = new Set(fields), candidates = [], duplicateEvidence = [];
  const mergeClaims = () => duplicateEvidence.flatMap(record => otherPapers.filter(target =>
    target.id !== current.id && target.doi === record.doi && duplicateMergeProof(current, target, record, record.last_checked_at))
    .map(target => ({ target_id: target.id, record })));
  const stillMissing = () => [...missingFields(current).filter(field => wanted.has(field)),
    ...(wanted.has('identity') && (unresolvedTitleConflict(current) || (confirmSingleSource && !singleSourceConfirmationFor(current)) ||
      (checkPossibleDuplicate && possibleDuplicatePeers(current, otherPapers).length)) ? ['identity'] : []),
    ...(wanted.has('classification') && classifyPaper(current).kind === 'needs_review' ? ['classification'] : [])];
  function adopt(record, identityEvidence = []) {
    try {
      let result;
      try { result = fillMissingMetadata(current, record, { otherPapers, identityEvidence }); }
      catch (error) {
        // A differing issue/online month is not evidence that an exact DOI +
        // title match has a different abstract. Keep the established date and
        // retain the conflicting dates as raw evidence, adopting ONLY abstract.
        const original = normalizeSourceRecord(record);
        if (error.code !== 'PUBLICATION_MONTH_CONFLICT' || !wanted.has('abstract') || !missingOriginalAbstract(current) ||
          !current.doi || original.doi !== current.doi || !repairIdentityMatches(current, original) ||
          !authenticAbstract(original.abstract)) throw error;
        const scoped = { ...original, authors: [], published_online_date: '', published_print_date: '', publication_date: '',
          raw_dates: { ...original.raw_dates, metadata_repair_excluded_dates: {
            reason: 'preserve_existing_publication_month', published_online_date: original.published_online_date,
            published_print_date: original.published_print_date, publication_date: original.publication_date } } };
        result = fillMissingMetadata(current, scoped, { otherPapers, identityEvidence });
      }
      result.changed_fields.forEach(field => changed.add(field)); current = result.paper; return result;
    } catch (error) {
      if (checkPossibleDuplicate && error.code === 'DOI_ALREADY_ASSIGNED') {
        const normalized = normalizeSourceRecord(record);
        if (!duplicateEvidence.some(row => stableJson(row) === stableJson(normalized))) duplicateEvidence.push(normalized);
      }
      throw error;
    }
  }
  // Reuse a previously verified original before spending more API calls. This
  // only supplies an abstract; other missing fields still follow the usual chain.
  if (wanted.has('abstract') && missingOriginalAbstract(current)) {
    const cached = publisherCaptureRecord(current, journal, checkedAt);
    if (cached) {
      const result = adopt(cached);
      attempts.push({ source: 'publisher', stage: 'verified_browser_excerpt',
        status: result.changed_fields.length ? 'filled' : 'no_new_fields' });
    }
  }
  for (const source of ['crossref', 'openalex', 'semanticscholar']) {
    if (!stillMissing().length || mergeClaims().length) break;
    try {
      const proposedDois = [...new Set(duplicateEvidence.map(record => record.doi))];
      // This is only a lookup hint. The DOI is never assigned to the DOI-less
      // record until an independent merge operation verifies the connection.
      const expected = !current.doi && proposedDois.length === 1 ? { ...current, doi: proposedDois[0] } : current;
      const record = await sources[source](expected, journal); candidates.push(record);
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
  if (!mergeClaims().length && stillMissing().includes('abstract') && typeof sources.publisher === 'function') {
    try {
      const result = adopt(await sources.publisher(current, journal));
      attempts.push({ source: 'publisher', status: result.changed_fields.length ? 'filled' : 'no_new_fields' });
    } catch (error) {
      if (error.code === 'EVIDENCE_STORAGE_ERROR') throw error;
      attempts.push({ source: 'publisher', status: safeCode(error) });
    }
  }
  // A predictable URL is only a lookup candidate. The adapter still verifies
  // journal, DOI, title, authors and matching original abstract fields.
  const repecUrl = repecJournalUrl(current.doi, journal);
  if (!mergeClaims().length && stillMissing().includes('abstract') && repecUrl && typeof sources.repecArticle === 'function') {
    try {
      const result = adopt(await sources.repecArticle({ ...current, url: repecUrl }, journal));
      attempts.push({ source: 'repec', status: result.changed_fields.length ? 'filled' : 'no_new_fields' });
    } catch (error) {
      if (error.code === 'EVIDENCE_STORAGE_ERROR') throw error;
      attempts.push({ source: 'repec', status: safeCode(error) });
    }
  }
  // A journal's public RePEc index can locate known papers without a paid
  // search. The list supplies URLs only, never an abstract or identity proof.
  if (!mergeClaims().length && stillMissing().includes('abstract') && current.doi && repecCatalogUrl(journal) &&
    typeof sources.repecCatalogArticle === 'function') {
    try {
      const result = adopt(await sources.repecCatalogArticle(current, journal));
      attempts.push({ source: 'repec', stage: 'journal_catalog', status: result.changed_fields.length ? 'filled' : 'no_new_fields' });
    } catch (error) {
      if (error.code === 'EVIDENCE_STORAGE_ERROR') throw error;
      attempts.push({ source: 'repec', stage: 'journal_catalog', status: safeCode(error) });
    }
  }
  let searchResult = null;
  if (stillMissing().includes('abstract') && !mergeClaims().length && sources.searchArticle) {
    try {
      const answer = await sources.searchArticle(current, journal);
      let record = answer.called && answer.result ? verifiedSearchRecord(answer.result.leads || [], current, journal, checkedAt) : null;
      // Some Chat API responses omit tool text. A model-suggested URL is only
      // a lead: fetch it independently and use the verified page, not its answer.
      const proposedUrl = safeSearchLink(answer.result?.extracted?.record?.source_url);
      if (!record && proposedUrl) {
        const repec = supportedRepecUrl(proposedUrl, journal) && sources.repecArticle;
        if (repec || publisherFor(journal).hosts.includes(new URL(proposedUrl).hostname)) {
          record = await (repec ? sources.repecArticle : sources.publisherArticle)({ ...current, url: proposedUrl }, journal);
        }
      }
      if (record) adopt(record);
      attempts.push({ source: 'zhipu', status: record ? 'filled' : 'no_verified_abstract',
        called: Boolean(answer.called), stage: 'search_and_extract',
        leads_returned: answer.result?.leads?.length || 0, ...(answer.diagnostic ? { diagnostic: answer.diagnostic } : {}) });
    } catch (error) {
      if (['EVIDENCE_STORAGE_ERROR', 'SEARCH_LEDGER_CHECKPOINT_FAILED'].includes(error.code)) throw error;
      attempts.push({ source: 'zhipu', status: safeCode(error), stage: 'search_and_extract' });
    }
  }
  if (stillMissing().length && !mergeClaims().length && search) {
    searchResult = await searchWithFallback({ maxLeadsPerSource: 50, queryFor: provider => {
      const query = paperSearchQuery(current, provider);
      return provider === 'zhipu' && sources.searchExtract && stillMissing().includes('abstract')
        ? abstractSearchQueries(current, journal) : query;
    },
      search: request => search({ ...request, taskId: `metadata:${paper.id}` }),
      verifyResult: sources.searchExtract ? async leads => {
        if (!stillMissing().includes('abstract')) return null;
        const record = verifiedSearchRecord(leads, current, journal, checkedAt);
        if (!record) return null;
        adopt(record);
        // The abstract can be saved even if another field remains unresolved.
        return stillMissing().length ? null : record;
      } : undefined,
      verifyLead: async lead => {
        const url = safeSearchLink(lead.url);
        if (!url) return { resolved: false, reason: 'UNSAFE_LINK' };
        const repec = supportedRepecUrl(url, journal) && typeof sources.repecArticle === 'function';
        if (!repec && !publisherFor(journal).hosts.includes(new URL(url).hostname)) return { resolved: false, reason: 'NOT_OFFICIAL_HOST' };
        // Only the fetched ORIGINAL official article is parsed. lead.snippet is deliberately unused.
        const record = await (repec ? sources.repecArticle : sources.publisherArticle)({ ...current, url }, journal);
        try { adopt(record); } catch (error) {
          if (!mergeClaims().length) throw error;
          return { resolved: true, reason: 'VERIFIED_MERGE_CANDIDATE', record };
        }
        return { resolved: !stillMissing().length, reason: 'UNRESOLVED_FIELDS', record };
      } });
    attempts.push(...searchResult.attempts.map(({ provider, ...row }) => ({ source: provider, ...row })));
  }
  return { paper: current, changed_fields: [...changed], missing_fields: stillMissing(), attempts,
    single_source_confirmation: confirmSingleSource ? singleSourceConfirmationFor(current) : null,
    duplicate_candidates: checkPossibleDuplicate ? possibleDuplicatePeers(current, otherPapers).map(row => ({ paper_id: row.id, doi: row.doi || null })) : [],
    duplicate_claims: mergeClaims(),
    identity_resolution: titleConsensusFor(current)?.summary || null,
    status: mergeClaims().length ? 'merge_ready' : !stillMissing().length ? 'resolved' : searchResult?.status || 'source_unavailable' };
}
