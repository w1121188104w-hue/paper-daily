import { findJournal } from './journals.js';
import { assertLibrary, stableJson } from './libraryValidation.js';
import { duplicateMergeProof } from './duplicateMerge.js';
import { applyDuplicateResolutions, duplicateWorkingState } from './duplicateResolution.js';
import { dateInShanghai } from './paperMerge.js';
import { validateEnrichmentReport } from './enrichmentValidation.js';
import { readJournalLibrary, newRunId, withLibraryLock, writeLibraryJson, publishLibrarySnapshot } from './journalLibrary.js';

export function selectDuplicateClaims(config, previous, checkedAt, { journalKey, maxPapers = 100 } = {}) {
  const candidates = new Map(), claims = [];
  for (const report of [...previous.enrichmentReports].sort((a, b) => b.run_id.localeCompare(a.run_id))) {
    for (const repair of report.repairs || []) {
      if (!Array.isArray(repair.duplicate_claims)) continue;
      if (!candidates.has(repair.paper_id)) candidates.set(repair.paper_id, []);
      candidates.get(repair.paper_id).push(...repair.duplicate_claims);
    }
  }
  let working = previous.papers;
  for (const [originalId, records] of candidates) {
    if (claims.length >= maxPapers) break;
    const original = working.find(p => p.id === originalId);
    if (!original || !findJournal(config, original.journal_key)?.enabled || (journalKey && original.journal_key !== journalKey)) continue;
    const valid = records.filter(claim => {
      const target = working.find(p => p.id === claim.target_id);
      return target && duplicateMergeProof(original, target, claim.record, checkedAt);
    });
    // Two valid-looking DOI destinations are still ambiguous; never choose by
    // recency or array order and silently archive one side of a conflict.
    if (new Set(valid.map(claim => claim.target_id)).size !== 1) continue;
    const entry = { original_id: original.id, target_id: valid[0].target_id, record: valid[0].record };
    working = applyDuplicateResolutions(working, [entry], checkedAt).papers;
    claims.push(entry);
  }
  return claims;
}

/** Consume saved proof without network or new search charges. Archive before-images
 * and retire only the identities whose transaction can be fully replayed. */
export async function runDuplicateResolution(config, { root, journalKey, maxPapers = 100, now = () => new Date(), beforePublish } = {}) {
  assertLibrary(typeof root === 'string' && root && Number.isInteger(maxPapers) && maxPapers >= 0 && maxPapers <= 1000, '归并必须提供库及批量上限');
  if (journalKey) assertLibrary(findJournal(config, journalKey)?.enabled, '归并期刊未启用');
  const started = now();
  return withLibraryLock(root, async () => {
    const previous = await readJournalLibrary({ root, config }), checkedAt = now().toISOString();
    const claims = selectDuplicateClaims(config, previous, checkedAt, { journalKey, maxPapers });
    if (!claims.length) return { committed: false, status: 'skipped', reason: 'NO_VERIFIED_MERGES' };
    const result = applyDuplicateResolutions(previous.papers, claims, checkedAt), state = duplicateWorkingState(previous, result.papers);
    const byId = new Map(previous.papers.map(p => [p.id, p]));
    const abstracts = result.papers.filter(p => !byId.get(p.id)?.abstract_original && p.abstract_original).map(p => ({
      paper_id: p.id, journal_key: p.journal_key, doi: p.doi, status: 'found', abstract_source: p.provenance.abstract_original.source, attempts: [] }));
    const stats = { added: 0, merged: result.merges.length, abstracts_filled: abstracts.length, abstracts_checked: abstracts.length,
      pending_candidates: 0, papers_changed: result.papers.filter(p => stableJson(p) !== stableJson(byId.get(p.id))).length };
    const runId = newRunId(started), runDate = dateInShanghai(started);
    const report = { schema_version: 1, run_id: runId, stage: 'duplicate_resolution', status: 'success', checked_at: checkedAt,
      from_date: previous.masterList.from_date || runDate, to_date: previous.masterList.to_date || runDate,
      stats, journals: [], abstracts, merges: result.merges, archived_issues: state.archived_issues, archived_abstract_state: state.archived_abstract_state };
    const log = { schema_version: 1, run_id: runId, kind: 'duplicate_resolution', run_date: runDate, started_at: started.toISOString(),
      finished_at: checkedAt, from_date: report.from_date, to_date: report.to_date, status: report.status, stats, report: {} };
    validateEnrichmentReport(report, log);
    log.report = await writeLibraryJson(root, `snapshots/${runId}/enrichment-report.json`, report);
    await publishLibrarySnapshot({ root, config, previous, papers: result.papers, enrichment: log, enrichmentState: state.enrichmentState,
      audit: { duplicates: result.merges.map(row => ({ type: 'verified_identity_merge', original_id: row.original.id,
        target_id: row.resolution.target_id, evidence: log.report.path })), excluded: [], notices: [] }, beforePublish });
    return { committed: true, status: 'success', run_id: runId, stats, report };
  });
}

// Called under the existing import writer lock. The ordinary archival validator
// replays these merges and retains both before-images; no history is deleted.
export async function saveReviewedDuplicateMerges(config,{root,previous,sources,at,save}){
  const checkedAt=at.toISOString(),claims=[];let working=previous.papers;
  for(const record of sources.filter(s=>s.doi)){
    const target=working.find(p=>p.journal_key===record.journal_key&&p.doi===record.doi);
    if(!target)continue;
    const originals=working.filter(p=>!p.doi&&duplicateMergeProof(p,target,record,checkedAt)?.method==='deepseek_reviewed_identity');
    for(const original of originals){
      const claim={original_id:original.id,target_id:target.id,record};
      working=applyDuplicateResolutions(working,[claim],checkedAt).papers;claims.push(claim);
    }
  }
  if(!claims.length)return {previous,merged:0};
  const result=applyDuplicateResolutions(previous.papers,claims,checkedAt),state=duplicateWorkingState(previous,result.papers);
  if(!save)return {previous:{...previous,papers:result.papers},merged:claims.length,merges:result.merges};
  const runId=newRunId(at),day=dateInShanghai(at),abstracts=result.papers.filter(p=>!previous.papers.find(o=>o.id===p.id)?.abstract_original&&p.abstract_original)
    .map(p=>({paper_id:p.id,journal_key:p.journal_key,doi:p.doi,status:'found',abstract_source:p.provenance.abstract_original.source,attempts:[]}));
  const stats={added:0,merged:claims.length,abstracts_filled:abstracts.length,abstracts_checked:abstracts.length,pending_candidates:0};
  const report={schema_version:1,run_id:runId,stage:'duplicate_resolution',status:'success',checked_at:checkedAt,from_date:day,to_date:day,
    stats,journals:[],abstracts,merges:result.merges,archived_issues:state.archived_issues,archived_abstract_state:state.archived_abstract_state};
  const log={schema_version:1,run_id:runId,kind:'duplicate_resolution',run_date:day,started_at:checkedAt,finished_at:checkedAt,
    from_date:day,to_date:day,status:'success',stats,report:{}};
  validateEnrichmentReport(report,log);log.report=await writeLibraryJson(root,`snapshots/${runId}/enrichment-report.json`,report);
  await publishLibrarySnapshot({root,config,previous,papers:result.papers,enrichment:log,enrichmentState:state.enrichmentState,
    audit:{...previous.audit,duplicates:[...(previous.audit?.duplicates||[]),...result.merges.map(m=>({type:'reviewed_identity_merge',original_id:m.original.id,target_id:m.resolution.target_id,evidence:log.report.path}))]}});
  return {previous:await readJournalLibrary({root,config}),merged:claims.length,merges:result.merges};
}
