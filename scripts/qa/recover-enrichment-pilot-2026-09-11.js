// One-time recovery of THIS unpublished local pilot only. Exact hashes, no network, no deletion.
// 28 RSS-update-date candidates were outside the agreed first-publication window. Their
// immutable local files are retained for diagnosis but are not ancestors of the public library.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { loadJournalConfig } from '../../src/services/journals.js';
import { DEFAULT_LIBRARY_ROOT as root, withLibraryLock, readJournalLibrary, readLibraryRef, newRunId,
  writeLibraryJson, publishLibrarySnapshot } from '../../src/services/journalLibrary.js';
import { emptyEnrichmentState } from '../../src/services/enrichmentValidation.js';
import { dateInShanghai } from '../../src/services/paperMerge.js';

assert.deepEqual(process.argv.slice(2),['--recover']);
const baselineRef = { path: 'snapshots/20260911T044059336Z-ea01e2d1-0469-48bf-bdda-bd3e09236922/manifest.json',
  sha256: '665c45630cacb11dda70b570bfc234f5449263413993d391e5624c9ea256f6c3' };
const pilotRef = { path: 'snapshots/20260911T065608503Z-87328246-c335-4260-826d-65cc1aec1cae/manifest.json',
  sha256: '450ff130c74b1b269130f16ba017fa69d1383a137bb4f484a5786a7f8eaba4fd' };
assert.deepEqual(JSON.parse(execFileSync('git',['show','HEAD:data/journal-store/current.json'],{ encoding: 'utf8',windowsHide: true })).manifest,baselineRef);
const config = await loadJournalConfig();
await withLibraryLock(root,async () => {
  const current = await readJournalLibrary({ root,config }); assert.deepEqual(current.pointer.manifest,pilotRef);
  const manifest = await readLibraryRef(root,baselineRef);
  const readBuckets = async buckets => (await Promise.all(Object.values(buckets).map(ref => readLibraryRef(root,ref)))).flat();
  const oldPapers = await readBuckets(manifest.papers), ids = new Set(oldPapers.map(p => p.id)); assert.equal(ids.size,497);
  const papers = current.papers.filter(p => ids.has(p.id)); assert.equal(current.papers.length-papers.length,28);
  const state = emptyEnrichmentState();
  state.abstracts = Object.fromEntries(Object.entries(current.enrichmentState.abstracts).filter(([id]) => ids.has(id)));
  const oldReport = await readLibraryRef(root,current.enrichments.find(r => r.run_id === '20260911T065608503Z-87328246-c335-4260-826d-65cc1aec1cae').report);
  const abstracts = oldReport.abstracts.filter(r => ids.has(r.paper_id)); assert.equal(abstracts.length,163);
  const stats = { added: 0,abstracts_filled: abstracts.filter(r => r.status === 'found').length,abstracts_checked: abstracts.length,pending_candidates: 0 };
  assert.equal(stats.abstracts_filled,31);
  const now = new Date(), runId = newRunId(now), report = { ...oldReport,run_id: runId,stats,journals: [],abstracts };
  const log = { schema_version: 1,run_id: runId,run_date: dateInShanghai(now),started_at: now.toISOString(),finished_at: now.toISOString(),
    from_date: report.from_date,to_date: report.to_date,status: report.status,stats,
    report: await writeLibraryJson(root,`snapshots/${runId}/enrichment-report.json`,report) };
  const previous = { manifest,papers: oldPapers,runs: await readBuckets(manifest.runs),imports: await readBuckets(manifest.translation_imports),
    enrichments: [],enrichmentState: emptyEnrichmentState(),pointer: { schema_version: 1,manifest: baselineRef },
    // CAS against the exact unpublished local pilot, while the parent is the last committed good baseline.
    pointerText: current.pointerText };
  await publishLibrarySnapshot({ root,config,previous,papers,enrichment: log,enrichmentState: state,
    audit: { duplicates: [],excluded: [],notices: [{ type: 'unpublished_pilot_recovery',
      reason: '28 RSS update-date candidates excluded from publication; first-publication dates were outside the 60-day scope. No historical files deleted.',
      retained_real_abstracts: 31 }] } });
  console.log(JSON.stringify({ recovered: true,papers: papers.length,missing_abstracts: papers.filter(p => !p.abstract_original).length,stats }));
});
