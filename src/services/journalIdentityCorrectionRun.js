import { journalIdentityCorrection } from './journalIdentityCorrection.js';
import { dateInShanghai } from './paperMerge.js';
import { newRunId, writeLibraryJson, publishLibrarySnapshot, readJournalLibrary } from './journalLibrary.js';

// Caller holds the ordinary library writer lock. No network or paid API calls.
export async function removeApprovedWrongJournalPapers(config, { root, previous, now = () => new Date(), beforePublish } = {}) {
  const result = journalIdentityCorrection(previous);
  if (!result.removed.length) return previous;
  const started = now(), checkedAt = now().toISOString(), runId = newRunId(started), runDate = dateInShanghai(started);
  const stats = { added: 0, removed: result.removed.length, abstracts_filled: 0, abstracts_checked: 0, pending_candidates: 0 };
  const report = { schema_version: 1, removal_policy_version: 2, stage: 'journal_identity_correction', run_id: runId, status: 'success',
    from_date: previous.masterList?.from_date || runDate, to_date: previous.masterList?.to_date || runDate,
    stats, journals: [], abstracts: [], removed: result.removed, checked_at: checkedAt };
  const log = { schema_version: 1, kind: 'journal_identity_correction', run_id: runId, run_date: runDate,
    started_at: started.toISOString(), finished_at: checkedAt, from_date: report.from_date, to_date: report.to_date,
    status: 'success', stats, report: await writeLibraryJson(root, `snapshots/${runId}/enrichment-report.json`, report) };
  await publishLibrarySnapshot({ root, config, previous, papers: result.papers, enrichment: log,
    enrichmentState: result.enrichmentState,
    audit: { duplicates: [], excluded: result.removed, notices: [{ type: 'user_authorized_wrong_journal_removal', backup: previous.pointer.manifest.path }] },
    beforePublish });
  return readJournalLibrary({ root, config });
}
