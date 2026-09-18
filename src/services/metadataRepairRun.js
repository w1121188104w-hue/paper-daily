import { assertLibrary, isIsoTime, stableJson } from './libraryValidation.js';
import { knownJournalMismatch } from './journalIdentity.js';
import { classifyPaper } from './paperClassification.js';
import { missingOriginalAbstract } from './carAbstractLanguage.js';
import { findJournal } from './journals.js';
import { dateInShanghai } from './paperMerge.js';
import { buildMasterList, officialDiscoveries } from './masterList.js';
import { dueRepairIssues, reconcileRepairState, recordRepairAttempt, recordSourceConfirmation, repairSummary } from './repairState.js';
import { repairPaperMetadata } from './searchMetadata.js';
import { prioritizeRepecCatalogPapers } from './repecCatalog.js';
import { publisherCaptureFor } from './publisherCaptures.js';
import { validateEnrichmentReport } from './enrichmentValidation.js';
import { newRunId, readJournalLibrary, withLibraryLock, writeLibraryJson, publishLibrarySnapshot } from './journalLibrary.js';

const fields = ['doi', 'authors', 'publication_month', 'abstract'];
export const metadataRepairIssue = issue => (fields.includes(issue.field) && issue.reason === `missing_${issue.field}`) ||
  (issue.field === 'identity' && ['title_conflict', 'single_source_confirmation', 'possible_duplicate'].includes(issue.reason)) ||
  (issue.field === 'publication_month' && issue.reason === 'publication_month_conflict') ||
  (issue.field === 'classification' && issue.reason === 'document_type_uncertain');
const providers = ['crossref', 'openalex', 'semanticscholar', 'publisher', 'repec', 'zhipu', 'serpapi_scholar', 'serpapi_google'];

export function dueMetadataRepairIssues(config, state, now, { journalKey, paperIds = null, retryMissingAbstractsNow = false } = {}) {
  const enabled = new Set(config.journals.filter(journal => journal.enabled).map(journal => journal.key));
  const selectedIds = paperIds === null ? null : new Set(paperIds);
  return dueRepairIssues(state, now, { limit: null, retryMissingAbstractsNow, filter: issue => metadataRepairIssue(issue) &&
    !knownJournalMismatch({ journal_key: issue.journal_key, doi: issue.paper_id.startsWith('doi:') ? issue.paper_id.slice(4) : '' }) &&
    (!selectedIds || selectedIds.has(issue.paper_id)) && (!journalKey || issue.journal_key === journalKey) && enabled.has(issue.journal_key) });
}

/** Second phase after discovery: explicit dependencies, no secret access, no LLM.
 * Due missing fields, title conflicts and single-source confirmations are queried. Callers must provide the same budgeted
 * search service as discovery, and a real quota reset timestamp when exhausted. */
export async function runMetadataRepair(config, { root, sources, search, now = () => new Date(), journalKey,
  maxPapers = 100, maxAbstracts = 0, paperIds = null, retryMissingAbstractsNow = false, quotaResetsAt = null, beforePublish, onProgress = () => {}, shouldContinue = () => true } = {}) {
  assertLibrary(typeof root === 'string' && root && sources && ['crossref', 'openalex', 'semanticscholar', 'publisherArticle'].every(k => typeof sources[k] === 'function') &&
    typeof search === 'function' && Number.isInteger(maxPapers) && maxPapers >= 0 && maxPapers <= 1000, '必须显式提供开发库、元数据来源、带额度保护的搜索器及批量上限');
  if (journalKey) assertLibrary(findJournal(config, journalKey)?.enabled, '无匹配的启用期刊');
  assertLibrary(Number.isInteger(maxAbstracts) && maxAbstracts >= 0 && maxAbstracts <= 1000, '摘要专用批次上限无效');
  assertLibrary(paperIds === null || (Array.isArray(paperIds) && paperIds.length > 0 && paperIds.length <= 1000 &&
    paperIds.every(id => typeof id === 'string') && new Set(paperIds).size === paperIds.length), '限定论文ID列表无效');
  const started = now(), runDate = dateInShanghai(started);
  return withLibraryLock(root, async () => {
    const previous = await readJournalLibrary({ root, config }), papers = [...previous.papers], byId = new Map(papers.map((p, i) => [p.id, i]));
    if (paperIds) assertLibrary(paperIds.every(id => byId.has(id) && (!journalKey || papers[byId.get(id)].journal_key === journalKey)), '限定论文必须属于当前库和选定期刊');
    const due = dueMetadataRepairIssues(config, previous.repairState, started, { paperIds, journalKey, retryMissingAbstractsNow })
      .filter(issue => !['administrative', 'other'].includes(classifyPaper(papers[byId.get(issue.paper_id)]).kind));
    const abstractIds = [...new Set(due.filter(issue => issue.field === 'abstract').map(issue => issue.paper_id))].slice(0, maxAbstracts);
    const generalIds = [...new Set(due.map(issue => issue.paper_id))].filter(id => !abstractIds.includes(id)).slice(0, maxPapers);
    const prioritized = await prioritizeRepecCatalogPapers(abstractIds.map(id => papers[byId.get(id)]), {
      sources, journalFor: key => findJournal(config, key), shouldContinue });
    const cached = new Set(prioritized.filter(p => publisherCaptureFor(p, findJournal(config, p.journal_key))).map(p => p.id));
    const selected = [...prioritized.filter(p => cached.has(p.id)), ...prioritized.filter(p => !cached.has(p.id))]
      .map(p => p.id).concat(generalIds), repairs = [], abstracts = [];
    const attemptedIssueIds = new Set(due.filter(issue => selected.includes(issue.paper_id)).map(issue => issue.id));
    if (!selected.length) return { committed: false, status: 'skipped', reason: 'NOT_DUE' };
    for (const id of selected) {
      // Do not mark unattempted papers as failed when the cloud run times out.
      // They stay pending, while already obtained evidence is saved below.
      if (!shouldContinue()) break;
      // A verified original is already scheduled to merge into this target.
      // Defer target queries until the archive transaction has combined evidence.
      if (repairs.some(repair => repair.duplicate_claims?.some(claim => claim.target_id === id))) continue;
      const old = papers[byId.get(id)], issues = due.filter(issue => issue.paper_id === id), wanted = [...new Set(issues.map(issue => issue.field))];
      onProgress({ phase: 'metadata_start', paper_id: id });
      const result = await repairPaperMetadata(old, findJournal(config, old.journal_key), { sources, search, otherPapers: papers, fields: wanted,
        checkedAt: now().toISOString(),
        confirmSingleSource: issues.some(issue => issue.reason === 'single_source_confirmation'),
        checkPossibleDuplicate: issues.some(issue => issue.reason === 'possible_duplicate') });
      papers[byId.get(id)] = result.paper;
      repairs.push({ paper_id: id, journal_key: old.journal_key, doi: result.paper.doi, status: result.status,
        changed_fields: result.changed_fields, missing_fields: result.missing_fields, requested_fields: wanted, attempts: result.attempts,
        identity_resolution: result.identity_resolution, single_source_confirmation: result.single_source_confirmation,
        duplicate_candidates: result.duplicate_candidates, duplicate_claims: result.duplicate_claims });
      if (missingOriginalAbstract(old) && wanted.includes('abstract')) abstracts.push({ paper_id: id, journal_key: old.journal_key, doi: result.paper.doi,
        status: !missingOriginalAbstract(result.paper) ? 'found' : result.status === 'not_found' ? 'not_found' : 'retry_later',
        abstract_source: result.paper.provenance.abstract_original?.source || '', attempts: result.attempts });
      onProgress({ phase: 'metadata_done', paper_id: id, status: result.status, filled: result.changed_fields });
    }
    if (!repairs.length) return { committed: false, status: 'skipped', reason: 'RUN_DEADLINE' };
    const finished = now(), finishedAt = finished.toISOString();
    const master = buildMasterList(papers, { generatedAt: finishedAt, policyVersion: 7, fromDate: previous.masterList.from_date, toDate: previous.masterList.to_date,
      officialIds: officialDiscoveries(previous.enrichmentReports) });
    let state = reconcileRepairState(previous.repairState, master);
    for (const result of repairs) {
      for (const issue of Object.values(state.issues).filter(issue => issue.paper_id === result.paper_id && issue.status !== 'resolved' &&
        attemptedIssueIds.has(issue.id) && metadataRepairIssue(issue) && result.requested_fields.includes(issue.field))) {
        if (issue.reason === 'single_source_confirmation' && result.single_source_confirmation) {
          state = recordSourceConfirmation(state, issue.id, papers[byId.get(result.paper_id)], finishedAt); continue;
        }
        let status = ['not_found', 'quota_exhausted', 'access_restricted', 'source_unavailable'].includes(result.status) ? result.status : 'source_unavailable';
        if (status !== 'quota_exhausted' && (issue.reason === 'possible_duplicate' || result.attempts.some(a => /IDENTITY|MISMATCH|CONFLICT|DOI_ALREADY_ASSIGNED/.test(a.status)) ||
          (issue.field === 'publication_month' && master.entries.some(row => row.id === result.paper_id && row.publication_conflict)))) status = 'identity_conflict';
        const source = [...result.attempts].reverse().find(a => providers.includes(a.source))?.source || 'publisher';
        const reset = status === 'quota_exhausted' ? (typeof quotaResetsAt === 'function' ? await quotaResetsAt(source, finishedAt) : quotaResetsAt) : null;
        if (status === 'quota_exhausted') assertLibrary(isIsoTime(reset) && Date.parse(reset) > finished.getTime(), '免费额度耗尽时必须提供已核实的未来重置时间');
        state = recordRepairAttempt(state, issue.id, { source, status, checkedAt: finishedAt, quotaResetsAt: reset });
      }
    }
    const stats = { added: 0, abstracts_filled: abstracts.filter(a => a.status === 'found').length, abstracts_checked: abstracts.length,
      single_source_confirmed: repairs.filter(r => r.single_source_confirmation).length,
      pending_candidates: 0, papers_checked: repairs.length, papers_changed: papers.filter((p, i) => stableJson(p) !== stableJson(previous.papers[i])).length };
    const status = repairs.every(r => r.status === 'resolved') ? 'success' : 'partial', runId = newRunId(started);
    // An empty library cannot reach this point; its missing-field queue is empty.
    const fromDate = previous.masterList.from_date || runDate, toDate = previous.masterList.to_date || runDate;
    const report = { schema_version: 1, run_id: runId, stage: 'missing_metadata_repair', status, from_date: fromDate, to_date: toDate,
      stats, journals: [], abstracts, repairs, unresolved: repairSummary(state), library_statistics: master.statistics };
    const log = { schema_version: 1, run_id: runId, kind: 'missing_metadata_repair', run_date: runDate, started_at: started.toISOString(),
      finished_at: finishedAt, from_date: fromDate, to_date: toDate, status, stats, report: {} };
    validateEnrichmentReport(report, log);
    log.report = await writeLibraryJson(root, `snapshots/${runId}/enrichment-report.json`, report);
    await publishLibrarySnapshot({ root, config, previous, papers, enrichment: log, repairState: state,
      audit: { duplicates: [], excluded: [], notices: [{ type: 'missing_metadata_repair', report: log.report.path }] }, beforePublish });
    return { committed: true, status, run_id: runId, stats, report };
  });
}
