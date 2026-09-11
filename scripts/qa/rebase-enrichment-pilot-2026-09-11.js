// One-time reconciliation of locally verified evidence onto the newer remote automated run.
// Does not rewrite original fields, translations, or histories. Exact baseline checks prevent reuse.
import assert from 'node:assert/strict';
import { loadJournalConfig } from '../../src/services/journals.js';
import { DEFAULT_LIBRARY_ROOT as root,withLibraryLock,readJournalLibrary,readLibraryRef,newRunId,
  writeLibraryJson,publishLibrarySnapshot } from '../../src/services/journalLibrary.js';
import { fillMissingAbstract } from '../../src/services/journalEnrichment.js';
import { emptyEnrichmentState } from '../../src/services/enrichmentValidation.js';
import { dateInShanghai } from '../../src/services/paperMerge.js';

assert.deepEqual(process.argv.slice(2),['--reconcile']);
const config = await loadJournalConfig();
await withLibraryLock(root,async () => {
  const previous = await readJournalLibrary({ root,config });
  assert.deepEqual(previous.pointer.manifest,{ path: 'snapshots/20260911T094211527Z-34bf4dcd-8a42-4630-aedc-c494e5f96ec8/manifest.json',
    sha256: '9d9e7808912d851385dd9274d2b68fcb631b478e206cf675fd5e4e74f890e43e' });
  const local = await readLibraryRef(root,{ path: 'snapshots/20260911T111646910Z-9b9d45fc-148b-4530-b214-ad41ba862f64/manifest.json',
    sha256: 'd3a4350969df5d4b0637eae6947363e5b45d850cd400fb980fba65254219a805' });
  const localPapers = (await Promise.all(Object.values(local.papers).map(ref => readLibraryRef(root,ref)))).flat();
  const localById = new Map(localPapers.map(p => [p.id,p])), ids = new Set(previous.papers.map(p => p.id));
  const localLogs = (await Promise.all(Object.values(local.enrichment_runs).map(ref => readLibraryRef(root,ref)))).flat();
  const reports = await Promise.all(localLogs.map(log => readLibraryRef(root,log.report)));
  const abstracts = structuredClone(reports.flatMap(r => r.abstracts)), journals = structuredClone(reports.flatMap(r => r.journals));
  let filled = 0;
  const papers = previous.papers.map(p => {
    const report = abstracts.find(a => a.paper_id === p.id), saved = localById.get(p.id);
    if (p.abstract_original || report?.status !== 'found') return p;
    assert.ok(saved?.abstract_original);
    const proof = saved.source_records.find(r => r.source === saved.provenance.abstract_original.source &&
      r.source_id === saved.provenance.abstract_original.source_id && r.abstract === saved.abstract_original);
    const next = fillMissingAbstract(p,proof); filled++; return next;
  });
  assert.equal(filled,31); assert.equal(papers.length,498);
  for (const j of journals) {
    j.existing_total_count = previous.papers.filter(p => p.journal_key === j.journal_key).length;
    for (const e of j.entries) if (e.status === 'added') {
      assert.ok(ids.has(e.paper_id)); // New remote collector has already acquired this DOI.
      e.status = 'existing'; e.reconciliation_note = 'Already collected and translated by the newer remote run; not counted as a new repair.';
      j.added_count--; j.missing_count--; j.matched_count++;
    }
  }
  const localState = await readLibraryRef(root,local.enrichment_state), state = emptyEnrichmentState();
  state.abstracts = Object.fromEntries(Object.entries(localState.abstracts).filter(([id]) => ids.has(id)));
  state.official_last_run_date = '2026-09-11';
  const now = new Date(), runId = newRunId(now), stats = { added: 0,abstracts_filled: filled,abstracts_checked: abstracts.length,
    pending_candidates: journals.reduce((sum,j) => sum+j.pending_count,0) };
  const report = { schema_version: 1,run_id: runId,from_date: '2026-07-14',to_date: '2026-09-11',status: 'partial',stats,journals,abstracts };
  const log = { schema_version: 1,run_id: runId,run_date: dateInShanghai(now),started_at: now.toISOString(),finished_at: now.toISOString(),
    from_date: report.from_date,to_date: report.to_date,status: report.status,stats,
    report: await writeLibraryJson(root,`snapshots/${runId}/enrichment-report.json`,report) };
  await publishLibrarySnapshot({ root,config,previous,papers,enrichment: log,enrichmentState: state,
    audit: { duplicates: [],excluded: [],notices: [{ type: 'newer_remote_history_preserved',
      reason: 'Local source evidence reconciled onto latest automated collection/translation. RSS update dates never count as first publication dates.' }] } });
  console.log(JSON.stringify({ stats,papers: papers.length,missing_abstracts: papers.filter(p => !p.abstract_original).length,run_id: runId }));
});
