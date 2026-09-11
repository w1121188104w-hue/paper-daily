import { buildSourceTextHash, normalizeDoi, normalizeSourceRecord } from './paperModel.js';
import { dateInShanghai, mergePapers } from './paperMerge.js';
import { classifySourceRecord } from './paperClassification.js';
import { enabledJournals, findJournal } from './journals.js';
import { collectionWindow } from './journalRun.js';
import { EvidenceError, evidenceHash, makeEvidenceHttp } from './evidenceHttp.js';
import { publisherRecord, authenticAbstract, windowMembership } from './publisherParsers.js';
import { titleIdentity, strongMatch, recordDate, makeEnrichmentSources } from './enrichmentSources.js';
import { discoverOfficialPapers, safeEvidenceCode } from './publisherDiscovery.js';
import { emptyEnrichmentState, validateEnrichmentReport } from './enrichmentValidation.js';
import { DEFAULT_LIBRARY_ROOT, newRunId, readJournalLibrary, withLibraryLock, writeLibraryJson, publishLibrarySnapshot } from './journalLibrary.js';

export function matchOfficialPaper(lead, papers, journalKey) {
  const sameJournal = papers.filter(p => p.journal_key === journalKey);
  if (lead.doi) {
    const exact = papers.filter(p => p.doi === normalizeDoi(lead.doi));
    if (exact.some(p => p.journal_key !== journalKey)) return { status: 'conflict', reason: 'DOI_JOURNAL_CONFLICT' };
    if (exact.length === 1) return { status: 'matched', paper: exact[0] };
    if (exact.length > 1) return { status: 'conflict', reason: 'AMBIGUOUS_DOI' };
  }
  const titles = sameJournal.filter(p => titleIdentity(p.title_original) === titleIdentity(lead.title));
  if (titles.some(p => lead.doi && p.doi && p.doi !== lead.doi)) return { status: 'conflict', reason: 'TITLE_DOI_CONFLICT' };
  const matches = titles.filter(p => strongMatch(lead,p));
  if (matches.length === 1 && titles.length === 1) return { status: 'matched', paper: matches[0] };
  if (titles.length) return { status: 'conflict', reason: 'AMBIGUOUS_TITLE_AUTHOR_DATE' };
  // Exact known publisher URL protects DOI-less papers when a title later changes.
  const sameUrl = sameJournal.filter(p => p.source_records.some(r => r.source === 'publisher' && r.source_id === lead.url));
  if (sameUrl.length) return { status: 'conflict', reason: 'SOURCE_IDENTITY_CHANGED' };
  return { status: 'missing' };
}

export function fillMissingAbstract(paper, record) {
  if (paper.abstract_original) return paper;
  if (!authenticAbstract(record.abstract) || paper.journal_key !== record.journal_key || !strongMatch(paper,record) ||
    (record.doi && !paper.doi)) throw new EvidenceError('UNVERIFIED_IDENTITY');
  const next = structuredClone(paper);
  next.abstract_original = record.abstract;
  next.source_records.push(normalizeSourceRecord(record));
  next.sources = [...new Set(next.source_records.map(r => r.source))].sort();
  next.provenance.abstract_original = { source: record.source, source_id: record.source_id };
  next.source_text_hash = buildSourceTextHash(next.title_original,next.abstract_original);
  next.abstract_translation_status = next.abstract_zh ? 'outdated' : 'pending';
  next.last_checked_at = record.last_checked_at;
  return next;
}
export const abstractIdentity = p => evidenceHash(JSON.stringify([p.journal_key,p.doi,titleIdentity(p.title_original),p.authors]));
export function abstractIsDue(paper, state, now) {
  if (paper.abstract_original) return false;
  const old = state.abstracts[paper.id];
  return !old || old.identity_hash !== abstractIdentity(paper) || Date.parse(old.next_retry_at) <= now.getTime();
}
function nextRetry(at, count, attempts) {
  const days = [1,3,7,14,30][Math.min(count-1,4)];
  const retryAfter = Math.max(0, ...attempts.map(a => a.retry_after_ms || 0));
  return new Date(at.getTime() + Math.max(days*86400000,retryAfter)).toISOString();
}
const details = lead => ({ title: lead.title, doi: lead.doi || '', authors: lead.authors, date: lead.date || '',
  date_role: lead.date_role || 'publisher_publication', url: lead.url, evidence: lead.evidence });
const isFatal = error => { if (error?.code === 'EVIDENCE_STORAGE_ERROR') throw error; };

export async function reconcileJournal(discovery, journal, inputPapers, window, { sources, runDate, checkedAt } = {}) {
  const papers = [...inputPapers], acceptedLeads = [], report = { journal_key: journal.key, coverage: discovery.coverage,
    coverage_reason: discovery.coverage_reason, official_observed_count: discovery.official_observed_count,
    existing_total_count: papers.filter(p => p.journal_key === journal.key).length,
    official_in_window_count: 0, matched_count: 0, missing_count: 0, added_count: 0, pending_count: 0,
    attempts: discovery.attempts, entries: [] };
  const seen = new Set();
  for (const lead of discovery.leads) {
    const entry = details(lead), classify = classifySourceRecord({ ...lead, journal_key: journal.key });
    if (/^report of the editor\b|^acknowledg(?:e)?ments? to (?:the )?(?:referees|reviewers)\b/i.test(lead.title)) {
      report.entries.push({ ...entry,status: 'excluded',reason: 'editorial_report_not_research' }); continue;
    }
    if (classify.kind !== 'candidate') { report.entries.push({ ...entry, status: 'excluded', reason: classify.kind }); continue; }
    const identity = lead.doi || lead.url;
    // Conflicting titles for one DOI are never automatically resolved by an arbitrary feed order.
    const conflict = discovery.leads.some(other => other !== lead && (other.doi || other.url) === identity && titleIdentity(other.title) !== titleIdentity(lead.title));
    if (conflict) { report.entries.push({ ...entry, status: 'pending', reason: 'OFFICIAL_IDENTITY_CONFLICT' }); continue; }
    if (seen.has(identity)) continue; seen.add(identity);
    acceptedLeads.push(lead);
    let match = matchOfficialPaper(lead,papers,journal.key), metadata = null;
    let date = lead.date, membership = windowMembership(date,window.fromDate,window.toDate);
    const needsDate = ['issue_cover_date','feed_update_date','publisher_feed_date'].includes(lead.date_role) || membership === 'boundary_date_uncertain' || membership === 'unknown_date';
    if (match.status === 'matched') {
      // A matched DOI is already in the library even when the official list only gives a cover month.
      if (needsDate) { date = recordDate(match.paper); membership = windowMembership(date,window.fromDate,window.toDate); }
      if (membership === 'inside') { report.official_in_window_count++; report.matched_count++; }
      report.entries.push({ ...entry, status: 'existing', paper_id: match.paper.id, window_status: membership }); continue;
    }
    if (match.status === 'conflict') { report.entries.push({ ...entry, status: 'pending', reason: match.reason }); continue; }
    // Resolve cover-date/PII-only leads through exact bibliographic identity, not DOI guessing.
    if (needsDate || !lead.doi) {
      try { metadata = await sources.crossref(lead,journal); date = recordDate(metadata); membership = windowMembership(date,window.fromDate,window.toDate); }
      catch (error) { isFatal(error); entry.lookup_status = safeEvidenceCode(error); }
      if (!metadata && sources.publisherArticle) {
        try { metadata = await sources.publisherArticle(lead,journal); date = recordDate(metadata); membership = windowMembership(date,window.fromDate,window.toDate); }
        catch (error) { isFatal(error); entry.page_status = safeEvidenceCode(error); }
      }
    }
    if (membership === 'outside' && (metadata || !needsDate)) {
      report.entries.push({ ...entry,status: 'outside_window',verified_publication_date: metadata ? date : lead.date,
        ...(metadata?.source_evidence ? { date_evidence: metadata.source_evidence } : {}) }); continue;
    }
    if ((needsDate && !metadata) || membership !== 'inside') {
      report.entries.push({ ...entry, status: 'pending', reason: membership === 'outside' ? 'ONLINE_DATE_UNVERIFIED' : membership.toUpperCase() }); continue;
    }
    report.official_in_window_count++;
    if (metadata) {
      match = matchOfficialPaper({ ...lead, doi: metadata.doi, date },papers,journal.key);
      if (match.status === 'matched') { report.matched_count++; report.entries.push({ ...entry, status: 'existing', paper_id: match.paper.id, resolved_doi: metadata.doi }); continue; }
      if (match.status === 'conflict') { report.entries.push({ ...entry, status: 'pending', reason: match.reason }); continue; }
    }
    if (!lead.doi && (!lead.authors.length || !lead.date)) { report.entries.push({ ...entry, status: 'pending', reason: 'INSUFFICIENT_IDENTITY' }); continue; }
    report.missing_count++;
    // Keep RSS timestamps in the raw evidence, never expose them as a publication field.
    const official = publisherRecord(needsDate ? { ...lead,date: '' } : lead,journal);
    // Seed a new paper only. Existing papers never pass through the general metadata selection policy here.
    const seed = metadata || official;
    if (classifySourceRecord(seed).kind !== 'candidate') { report.entries.push({ ...entry, status: 'pending', reason: 'SOURCE_TYPE_CONFLICT' }); continue; }
    const added = mergePapers([seed],{ firstSeenDate: runDate, checkedAt }).papers[0];
    if (metadata) {
      added.source_records.push(official); added.sources = [...new Set(added.source_records.map(r => r.source))].sort();
      if (!added.abstract_original && official.abstract) {
        added.abstract_original = official.abstract; added.provenance.abstract_original = { source: official.source, source_id: official.source_id };
        added.source_text_hash = buildSourceTextHash(added.title_original,added.abstract_original); added.abstract_translation_status = 'pending';
      }
    }
    if (papers.some(p => p.id === added.id)) { report.entries.push({ ...entry, status: 'pending', reason: 'ID_COLLISION' }); continue; }
    papers.push(added); report.added_count++;
    report.entries.push({ ...entry, status: 'added', paper_id: added.id, resolved_doi: added.doi, verified_publication_date: date });
  }
  report.pending_count = report.entries.filter(e => e.status === 'pending').length;
  return { papers, report, leads: acceptedLeads };
}

export async function enrichAbstract(paper, journal, { sources, leads = [], state, now = new Date() }) {
  const attempts = []; let filled = null;
  for (const source of ['crossref','openalex','semanticscholar','publisher']) {
    if (source === 'publisher') attempts.push({ source: 'publisher_api', status: 'NO_CONFIGURED_OFFICIAL_API' });
    try {
      const record = await sources[source](paper,journal,leads);
      if (!authenticAbstract(record.abstract)) { attempts.push({ source, status: 'NO_ABSTRACT' }); continue; }
      filled = fillMissingAbstract(paper,record);
      attempts.push({ source, status: 'FOUND', evidence: record.source_evidence || null }); break;
    } catch (error) {
      isFatal(error); attempts.push({ source, status: safeEvidenceCode(error), ...(error.retry_after_ms ? { retry_after_ms: error.retry_after_ms } : {}) });
    }
  }
  const codes = attempts.map(a => a.status);
  const status = filled ? 'found' : codes.some(c => ['RATE_LIMITED','REQUEST_LIMIT','TIMEOUT','NETWORK_ERROR','HTTP_ERROR'].includes(c)) ? 'retry_later' :
    codes.some(c => /RESTRICTED|ROBOTS_/.test(c)) ? 'access_restricted' : codes.includes('PUBLISHER_NO_ABSTRACT') ? 'publisher_no_abstract' :
    codes.some(c => /IDENTITY|MISMATCH|CONFLICT|NO_DOI/.test(c)) ? 'identity_unverified' : 'not_found';
  const old = state.abstracts[paper.id], count = (old?.identity_hash === abstractIdentity(paper) ? old.attempt_count : 0) + 1;
  const retry = nextRetry(now,count,attempts);
  state.abstracts[paper.id] = { status, attempt_count: count, identity_hash: abstractIdentity(paper), last_checked_at: now.toISOString(), next_retry_at: retry };
  return { paper: filled || paper, report: { paper_id: paper.id, journal_key: paper.journal_key, doi: paper.doi,
    status, abstract_source: filled?.provenance.abstract_original.source || '', attempts, next_retry_at: retry } };
}

export async function runJournalEnrichment(config, { root = DEFAULT_LIBRARY_ROOT, now = () => new Date(),
  journalKey, official = true, abstracts = true, lookbackDays = 60, maxAbstracts = 100, onlyIfNeeded = true,
  http = makeEvidenceHttp(), sources = makeEnrichmentSources(http), discover = discoverOfficialPapers,
  beforePublish, onProgress = () => {} } = {}) {
  if (lookbackDays !== 60 || !Number.isInteger(maxAbstracts) || maxAbstracts < 0 || maxAbstracts > 1000 || (!official && !abstracts)) throw new Error('补全参数无效');
  const started = now(), runDate = dateInShanghai(started), window = collectionWindow({ now: started, lookbackDays });
  const selected = journalKey ? [findJournal(config,journalKey)].filter(j => j?.enabled) : enabledJournals(config);
  if (!selected.length) throw new Error('无匹配的启用期刊');
  return withLibraryLock(root, async () => {
    const previous = await readJournalLibrary({ root,config }), state = structuredClone(previous.enrichmentState || emptyEnrichmentState());
    const runId = newRunId(started), prefix = `snapshots/${runId}`;
    const checkOfficial = official && !(onlyIfNeeded && !journalKey && state.official_last_run_date === runDate);
    let papers = [...previous.papers]; const journals = [], abstractReports = [], leads = new Map();
    if (checkOfficial) for (const journal of selected) {
      onProgress({ phase: 'official_start', journal_key: journal.key });
      const discovery = await discover(journal,window,{ http,onProgress });
      const result = await reconcileJournal(discovery,journal,papers,window,{ sources,runDate,checkedAt: started.toISOString() });
      papers = result.papers; journals.push(result.report); leads.set(journal.key,result.leads);
      onProgress({ phase: 'official_done', journal_key: journal.key, coverage: result.report.coverage,
        observed: result.report.official_observed_count, added: result.report.added_count, pending: result.report.pending_count });
    }
    if (checkOfficial && !journalKey) state.official_last_run_date = runDate;
    if (abstracts) {
      const keys = new Map(selected.map(j => [j.key,j]));
      const due = papers.filter(p => keys.has(p.journal_key) && abstractIsDue(p,state,started))
        .sort((a,b) => (state.abstracts[a.id]?.last_checked_at || '').localeCompare(state.abstracts[b.id]?.last_checked_at || '') || a.id.localeCompare(b.id))
        .slice(0,maxAbstracts);
      const byId = new Map(papers.map((p,i) => [p.id,i]));
      for (const paper of due) {
        const result = await enrichAbstract(paper,keys.get(paper.journal_key),{ sources,leads: leads.get(paper.journal_key),state,now: now() });
        papers[byId.get(paper.id)] = result.paper; abstractReports.push(result.report);
        onProgress({ phase: 'abstract', checked: abstractReports.length, filled: abstractReports.filter(r => r.status === 'found').length,
          paper_id: paper.id, status: result.report.status });
      }
    }
    if (!journals.length && !abstractReports.length) return { status: 'skipped', committed: false, reason: 'NOT_DUE' };
    const status = journals.some(j => j.coverage === 'restricted') || abstractReports.some(r => r.status !== 'found') ? 'partial' : journals.length ? 'partial' : 'success';
    const stats = { added: papers.length-previous.papers.length, abstracts_filled: abstractReports.filter(r => r.status === 'found').length,
      abstracts_checked: abstractReports.length, pending_candidates: journals.reduce((s,j) => s+j.pending_count,0) };
    const report = { schema_version: 1,run_id: runId,status,from_date: window.fromDate,to_date: window.toDate,stats,journals,abstracts: abstractReports };
    const log = { schema_version: 1,run_id: runId,run_date: runDate,started_at: started.toISOString(),finished_at: now().toISOString(),
      from_date: window.fromDate,to_date: window.toDate,status,stats,report: {} };
    validateEnrichmentReport(report,log);
    log.report = await writeLibraryJson(root,`${prefix}/enrichment-report.json`,report);
    await publishLibrarySnapshot({ root,config,previous,papers,enrichment: log,enrichmentState: state,
      audit: { duplicates: [],excluded: [],notices: [{ type: 'official_coverage_partial', report: log.report.path }] },beforePublish });
    return { committed: true,status,stats,run_id: runId,report };
  });
}
