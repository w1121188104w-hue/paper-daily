import { assertLibrary } from './libraryValidation.js';
import { runJournalCollection } from './journalRun.js';
import { runCatalogDiscovery } from './catalogDiscoveryRun.js';
import { runMetadataRepair } from './metadataRepairRun.js';
import { readJournalLibrary } from './journalLibrary.js';
import { repairSummary } from './repairState.js';
import { translationEligibility } from './translationQueue.js';

/** Shared daily ordering; deliberately no credentials, translation, git or
 * deployment here. Caller owns the cross-process production concurrency gate
 * and supplies one durable budgeted search service to both search phases. */
export async function runJournalPipeline(config, { root, http, sources, search, quotaResetsAt,
  journalKey, now = () => new Date(), maxPapers = 100, maxPages = 1000,
  collectionOptions = {}, onProgress = () => {},
  collect = runJournalCollection, catalog = runCatalogDiscovery, repair = runMetadataRepair,
  readLibrary = readJournalLibrary } = {}) {
  assertLibrary(typeof root === 'string' && root && typeof http?.request === 'function' &&
    sources && typeof search === 'function' && Number.isInteger(maxPapers) && maxPapers >= 0 && maxPapers <= 1000 &&
    Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 1000, '统一流程必须显式提供库、来源、带持久化额度保护的搜索器和上限');
  // Reject corruption before *any* source requests or search budget reservation.
  await readLibrary({ root, config });
  const common = { root, journalKey, now }, stages = [];
  async function stage(name, action) {
    onProgress({ phase: `${name}_start` });
    // Source-level failures are isolated within the existing collectors. Do not
    // catch storage/validation/ledger errors here and mistake them for outages.
    const result = await action();
    assertLibrary(result && typeof result.status === 'string', '流程阶段缺少有效状态');
    stages.push({ stage: name, status: result.status, committed: Boolean(result.committed), run_id: result.run_id || null });
    await readLibrary({ root, config });
    onProgress({ phase: `${name}_done`, status: result.status });
    return result;
  }
  const collected = await stage('discovery', () => collect(config, { ...collectionOptions, ...common,
    lookbackDays: 60, onlyIfNeeded: true, withSemanticScholar: true, maxPages,
    onProgress: row => onProgress({ phase: 'discovery_source', ...row }) }));
  const catalogs = await stage('official_catalog', () => catalog(config, { ...common, http, search, onProgress }));
  const repaired = await stage('metadata', () => repair(config, { ...common, sources, search, quotaResetsAt, maxPapers, onProgress }));
  const library = await readLibrary({ root, config }), translation = translationEligibility(library.papers);
  return { schema_version: 1, status: stages.every(s => ['success', 'no_updates', 'skipped'].includes(s.status)) ? 'success' : 'partial',
    stages, discovery_sources: collected.run?.sources || collected.sources || [],
    catalog_statistics: catalogs.report?.library_statistics || null, metadata_statistics: repaired.stats || null,
    master: library.masterList.statistics, journals: library.masterList.journals,
    unresolved: repairSummary(library.repairState),
    translation_ready: { papers: translation.ready.paper_count, fields: translation.ready.field_count },
    translation_held: { papers: translation.held.paper_count, fields: translation.held.field_count },
    coverage: 'not_proven_complete', translation_calls: 0 };
}
