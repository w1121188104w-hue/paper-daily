import { normalizeDoi, normalizeTitleForMatch } from './paperModel.js';
import { dateInShanghai, mergePapers } from './paperMerge.js';
import { classifySourceRecord } from './paperClassification.js';
import { enabledJournals, findJournal } from './journals.js';
import { publisherFor, canonicalPublisherUrl } from './publisherCatalog.js';
import { publisherRecord, windowMembership } from './publisherParsers.js';
import { authorOverlap } from './enrichmentSources.js';
import { discoverOfficialPapers } from './publisherDiscovery.js';
import { catalogMonths, readSearchCatalog, searchJournalCatalog } from './searchCatalog.js';
import { safeSearchLink } from './searchSources.js';
import { catalogSearchDue, validateCatalogSearchState, CATALOG_STATUSES } from './catalogSearchState.js';
import { buildMasterList, officialDiscoveries, publicationFor } from './masterList.js';
import { emptyEnrichmentState, validateEnrichmentReport } from './enrichmentValidation.js';
import { assertLibrary } from './libraryValidation.js';
import { collectionWindow } from './journalRun.js';
import { paperDocumentType } from './paperScope.js';
import { newRunId, readJournalLibrary, withLibraryLock, writeLibraryJson, publishLibrarySnapshot } from './journalLibrary.js';

const titleKey = title => normalizeTitleForMatch(title).replace(/\s/g, '');
const officialUrl = (url, journal) => {
  const safe = safeSearchLink(url);
  return safe && publisherFor(journal).hosts.includes(new URL(safe).hostname) ? canonicalPublisherUrl(safe) : null;
};
const leadKey = lead => `${normalizeDoi(lead.doi) || lead.url}|${titleKey(lead.title)}`;
const fatal = error => { if (['EVIDENCE_STORAGE_ERROR', 'SEARCH_LEDGER_CHECKPOINT_FAILED'].includes(error?.code)) throw error; };

function match(lead, papers, journal) {
  const doi = normalizeDoi(lead.doi), sameJournal = papers.filter(p => p.journal_key === journal.key);
  const exact = doi ? papers.filter(p => p.doi === doi) : [];
  if (exact.length) return exact.length === 1 && exact[0].journal_key === journal.key
    ? { paper: exact[0] } : { conflict: 'DOI_JOURNAL_CONFLICT' };
  const titles = sameJournal.filter(p => titleKey(p.title_original) === titleKey(lead.title));
  if (titles.length > 1) return { conflict: 'AMBIGUOUS_TITLE' };
  if (titles.length === 1) {
    const p = titles[0], year = publicationFor(p).publication_year;
    if (doi && p.doi && doi !== p.doi) return { conflict: 'TITLE_DOI_CONFLICT' };
    if (year && lead.date && year !== Number(lead.date.slice(0, 4))) return { conflict: 'TITLE_YEAR_CONFLICT' };
    if (p.authors.length && lead.authors.length && !authorOverlap(p.authors, lead.authors)) return { conflict: 'TITLE_AUTHOR_CONFLICT' };
    return { paper: p };
  }
  if (sameJournal.some(p => p.source_records.some(r => r.source === 'publisher' && r.source_id === lead.url))) return { conflict: 'SOURCE_IDENTITY_CHANGED' };
  return {};
}

/** Admission only: existing papers, translations, and first-seen times NEVER change.
 * Verified official identities can enter without DOI, authors, or an exact date.
 * Unknown/boundary dates stay explicitly uncertain; old confirmed dates stay out. */
export function reconcileCatalogDiscovery(discovery, journal, input, window, { checkedAt, runDate }) {
  const papers = [...input], entries = [], prepared = [], seen = new Set();
  for (const lead of discovery.leads) {
    try {
      assertLibrary(officialUrl(lead.url, journal) && officialUrl(lead.evidence?.url, journal) &&
        officialUrl(lead.evidence?.scope_url, journal) &&
        (lead.journal_confirmed === true || lead.evidence?.method === 'publisher_rss'), '缺少经过核实的官网身份');
      const record = publisherRecord(lead, journal);
      prepared.push({ lead: { ...lead, title: record.title, doi: record.doi, authors: record.authors, date: record.publication_date }, record });
    } catch { entries.push({ status: 'pending', reason: 'UNVERIFIED_OFFICIAL_IDENTITY' }); }
  }
  let inside = 0, matched = 0, missing = 0;
  for (const { lead, record } of prepared) {
    const key = leadKey(lead); if (seen.has(key)) continue; seen.add(key);
    const entry = { title: lead.title, doi: lead.doi, authors: lead.authors, date: lead.date,
      url: lead.url, evidence: lead.evidence, search_provider: lead.search_provider || null,
      ...paperDocumentType({ source_records: [record] }) };
    const classification = classifySourceRecord(record).kind;
    if (!['candidate', 'other'].includes(classification) || /^report of the editor\b|^acknowledg(?:e)?ments? to (?:the )?(?:referees|reviewers)\b/i.test(lead.title)) {
      entries.push({ ...entry, status: classification === 'needs_review' ? 'pending' : 'excluded', reason: classification }); continue;
    }
    // Reject all sides of a same-DOI/title conflict before adding either side.
    const conflict = prepared.some(other => other.lead !== lead &&
      (lead.doi ? other.lead.doi === lead.doi : other.lead.url === lead.url) && titleKey(other.lead.title) !== titleKey(lead.title));
    if (conflict) { entries.push({ ...entry, status: 'pending', reason: 'OFFICIAL_IDENTITY_CONFLICT' }); continue; }
    const membership = windowMembership(lead.date, window.fromDate, window.toDate);
    const identity = match(lead, papers, journal);
    if (identity.conflict) { entries.push({ ...entry, status: 'pending', reason: identity.conflict }); continue; }
    if (identity.paper) {
      if (membership === 'inside') { inside++; matched++; }
      entries.push({ ...entry, status: 'existing', paper_id: identity.paper.id, window_status: membership }); continue;
    }
    if (membership === 'outside') { entries.push({ ...entry, status: 'outside_window', window_status: membership }); continue; }
    if (membership === 'inside') inside++;
    missing++;
    const added = mergePapers([record], { firstSeenDate: runDate, checkedAt, normalizeCar: true }).papers[0];
    if (papers.some(p => p.id === added.id)) { entries.push({ ...entry, status: 'pending', reason: 'ID_COLLISION' }); continue; }
    papers.push(added);
    entries.push({ ...entry, status: 'added', paper_id: added.id, window_status: membership,
      ...(membership !== 'inside' ? { window_note: 'Publication time is incomplete or overlaps the 60-day boundary; do not count as confirmed inside.' } : {}) });
  }
  const report = { journal_key: journal.key, coverage: discovery.leads.length ? 'partial' : 'restricted',
    coverage_reason: 'Official identity verified where possible; exhaustive coverage and uncertain publication dates remain unconfirmed.',
    official_observed_count: prepared.length || (discovery.official_observed_count === 0 ? 0 : null),
    existing_total_count: input.filter(p => p.journal_key === journal.key).length,
    official_in_window_count: inside, matched_count: matched, missing_count: missing,
    added_count: entries.filter(e => e.status === 'added').length,
    added_research_confirmed_in_window: entries.filter(e => e.status === 'added' && e.research_candidate && e.window_status === 'inside').length,
    added_research_uncertain_window: entries.filter(e => e.status === 'added' && e.research_candidate && e.window_status !== 'inside').length,
    added_lectures: entries.filter(e => e.status === 'added' && e.document_type === 'lecture').length,
    pending_count: entries.filter(e => e.status === 'pending').length,
    attempts: discovery.attempts || [], entries };
  return { papers, report };
}

/** Development entry point; no env access, no default production root, no implicit
 * search client or deployment. Caller supplies a DURABLY BUDGETED search callback.
 * Existing three-source collection runs first; this adds official discoveries only. */
export async function runCatalogDiscovery(config, { root, http, search, now = () => new Date(), journalKey,
  discover = discoverOfficialPapers, readCatalog = readSearchCatalog, searchCatalog = searchJournalCatalog,
  beforePublish, onProgress = () => {} } = {}) {
  assertLibrary(typeof root === 'string' && root && typeof http?.request === 'function' && typeof search === 'function', '必须显式提供开发库、网页读取器和带额度保护的搜索器');
  const started = now(), checkedAt = started.toISOString(), runDate = dateInShanghai(started), window = collectionWindow({ now: started, lookbackDays: 60 });
  const selected = journalKey ? [findJournal(config, journalKey)].filter(j => j?.enabled) : enabledJournals(config);
  assertLibrary(selected.length, '无匹配的启用期刊');
  return withLibraryLock(root, async () => {
    const previous = await readJournalLibrary({ root, config }), state = structuredClone(previous.enrichmentState || emptyEnrichmentState());
    state.catalog_search ||= {}; validateCatalogSearchState(state.catalog_search);
    let papers = [...previous.papers]; const reports = [], queries = [], responses = new Map(), callCounts = { zhipu: 0, serpapi_scholar: 0, serpapi_google: 0 };
    const sharedHttp = { request: (url, hosts) => {
      const key = JSON.stringify([url, hosts]);
      if (!responses.has(key)) responses.set(key, Promise.resolve().then(() => http.request(url, hosts)));
      return responses.get(key);
    } };
    const budgeted = async options => {
      const result = await search(options);
      if (result.called && Object.hasOwn(callCounts, options.provider)) callCounts[options.provider]++;
      return result;
    };
    for (const journal of selected) {
      const months = catalogMonths(window).filter(month => catalogSearchDue(state.catalog_search, journal.key, month, started));
      if (!months.length) continue;
      onProgress({ phase: 'catalog_start', journal_key: journal.key });
      const all = [], attempts = [];
      try { const direct = await discover(journal, window, { http: sharedHttp }); all.push(...direct.leads); attempts.push(...direct.attempts); }
      catch (error) { fatal(error); attempts.push({ source: 'publisher', status: 'SOURCE_UNAVAILABLE' }); }
      for (const month of months) {
        const key = `${journal.key}:${month}`, old = state.catalog_search[key];
        let result, cacheRead = null;
        const seeds = (old?.urls || []).filter(url => officialUrl(url, journal));
        if (seeds.length) try { cacheRead = await readCatalog(journal, window, seeds, { http: sharedHttp }); }
        catch (error) { fatal(error); }
        if (cacheRead) { all.push(...cacheRead.leads); attempts.push(...cacheRead.attempts); }
        const relevant = cacheRead?.leads.some(lead => lead.date?.startsWith(month) && !['issue_cover_date', 'feed_update_date', 'publisher_feed_date'].includes(lead.date_role));
        if (cacheRead?.verified_list_read && !cacheRead.incomplete && relevant) result = { ...cacheRead, search_queries: [{ month, status: 'catalog_checked_partial' }] };
        else try { result = await searchCatalog(journal, window, { http: sharedHttp, search: budgeted, readCatalog, months: [month] }); }
        catch (error) { fatal(error); result = { leads: [], attempts: [], search_queries: [{ month, status: 'source_unavailable' }] }; }
        all.push(...result.leads); attempts.push(...result.attempts);
        const status = result.search_queries?.[0]?.status;
        assertLibrary(CATALOG_STATUSES.includes(status), '清单搜索状态无效');
        // Prioritize directories and unfinished URLs; avoid replacing a useful index
        // with the first 100 article URLs of a large journal.
        const urls = [...new Set([...(result.attempts || []).filter(a => /CATALOG|LIST|PARTIAL_FEED/.test(a.status)).map(a => a.url),
          ...(result.pending_urls || []), ...(cacheRead?.pending_urls || []), ...seeds, ...(result.checked_urls || []), ...result.leads.map(lead => lead.url)]
          .filter(url => officialUrl(url, journal)).map(url => officialUrl(url, journal)))].slice(0, 100);
        state.catalog_search[key] = { journal_key: journal.key, month, status, attempt_count: (old?.attempt_count || 0) + 1,
          checked_at: checkedAt, next_retry_at: new Date(Date.parse(`${runDate}T00:00:00+08:00`) + 86400000).toISOString(), urls };
        queries.push({ journal_key: journal.key, month, status, reused_catalog: Boolean(cacheRead?.verified_list_read && !cacheRead.incomplete && relevant) });
      }
      const unique = new Map();
      for (const lead of all) if (!unique.has(leadKey(lead))) unique.set(leadKey(lead), lead);
      const result = reconcileCatalogDiscovery({ leads: [...unique.values()], attempts }, journal, papers, window, { checkedAt, runDate });
      papers = result.papers; reports.push(result.report);
      onProgress({ phase: 'catalog_done', journal_key: journal.key, added: result.report.added_count, pending: result.report.pending_count });
    }
    if (!reports.length) return { committed: false, status: 'skipped', reason: 'NOT_DUE' };
    validateCatalogSearchState(state.catalog_search);
    const runId = newRunId(started), stats = { added: papers.length - previous.papers.length, abstracts_filled: 0,
      abstracts_checked: 0, pending_candidates: reports.reduce((sum, r) => sum + r.pending_count, 0) };
    const report = { schema_version: 1, run_id: runId, status: 'partial', from_date: window.fromDate, to_date: window.toDate,
      stage: 'official_catalog_search', stats, journals: reports, abstracts: [], search_queries: queries, search_calls: callCounts };
    report.library_statistics = buildMasterList(papers, { generatedAt: checkedAt, ...window, policyVersion: 7,
      officialIds: officialDiscoveries([...(previous.enrichmentReports || []), report]) }).statistics;
    const log = { schema_version: 1, run_id: runId, run_date: runDate, started_at: checkedAt, finished_at: now().toISOString(),
      from_date: window.fromDate, to_date: window.toDate, status: 'partial', stats, report: {} };
    validateEnrichmentReport(report, log);
    log.report = await writeLibraryJson(root, `snapshots/${runId}/enrichment-report.json`, report);
    await publishLibrarySnapshot({ root, config, previous, papers, enrichment: log, enrichmentState: state, masterWindow: window,
      audit: { duplicates: [], excluded: [], notices: [{ type: 'search_assisted_catalog_partial', report: log.report.path }] }, beforePublish });
    return { committed: true, status: 'partial', run_id: runId, stats, report };
  });
}
