import { readJournalLibrary } from './journalLibrary.js';
import { runCatalogDiscovery } from './catalogDiscoveryRun.js';
import { runMetadataRepair, metadataRepairIssue } from './metadataRepairRun.js';
import { catalogMonths } from './searchCatalog.js';
import { catalogSearchDue } from './catalogSearchState.js';
import { collectionWindow } from './journalRun.js';
import { dueRepairIssues } from './repairState.js';
import { assertLibrary } from './libraryValidation.js';

/** Reopen persisted state with fresh, deliberately offline clients. This verifies
 * restart-safe skipping, rather than relying on in-memory HTTP caches. If work
 * remains due (batch bound/day rollover), report untested instead of executing it. */
export async function verifyPilotReuse(config, { root, journalKey, now = () => new Date() } = {}) {
  const checked = now(), before = await readJournalLibrary({ root, config });
  const months = catalogMonths(collectionWindow({ now: checked, lookbackDays: 60 }));
  const catalogDue = months.filter(month => catalogSearchDue(before.enrichmentState.catalog_search || {}, journalKey, month, checked)).length;
  const metadataDue = dueRepairIssues(before.repairState, checked, { limit: 10000 }).filter(issue => issue.journal_key === journalKey &&
    metadataRepairIssue(issue)).length;
  let calls = 0;
  const forbidden = async () => { calls++; throw Object.assign(new Error('Replay must not request network'), { code: 'EVIDENCE_STORAGE_ERROR' }); };
  const common = { root, journalKey, now: () => checked, search: forbidden };
  let catalog = { status: 'not_tested_due_work', due_months: catalogDue }, metadata = { status: 'not_tested_due_work', due_fields: metadataDue };
  if (!catalogDue) {
    const result = await runCatalogDiscovery(config, { ...common, http: { request: forbidden }, discover: forbidden, readCatalog: forbidden, searchCatalog: forbidden });
    assertLibrary(result.status === 'skipped' && result.committed === false, '清单冷却未正确跳过');
    catalog = { status: 'verified_skipped', due_months: 0 };
  }
  if (!metadataDue) {
    const result = await runMetadataRepair(config, { ...common, sources: { crossref: forbidden, openalex: forbidden, semanticscholar: forbidden, publisherArticle: forbidden } });
    assertLibrary(result.status === 'skipped' && result.committed === false, '字段冷却未正确跳过');
    metadata = { status: 'verified_skipped', due_fields: 0 };
  }
  assertLibrary(calls === 0 && (await readJournalLibrary({ root, config })).pointerText === before.pointerText, '复用验证发生意外请求或版本更新');
  return { checked_at: checked.toISOString(), catalog, metadata, network_calls: calls, pointer_unchanged: true,
    status: catalogDue || metadataDue ? 'partial_not_tested_due_work' : 'verified_no_repeat_requests' };
}
