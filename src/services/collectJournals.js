import { enabledJournals, findJournal } from './journals.js';
import { fetchOpenAlexJournal } from './openalex.js';
import { fetchCrossrefJournal } from './crossref.js';
import { dateInShanghai, mergePapers } from './paperMerge.js';
import { validateWindow } from './sourceClient.js';
import { filterSourceRecords } from './paperClassification.js';

/** Stage 2: collect and merge in memory; the caller owns validation/persistence/publication. */
export async function collectJournals(config, { journalKey, fromDate, toDate,
  existingPapers = [], checkedAt = new Date().toISOString(), firstSeenDate = dateInShanghai(new Date(checkedAt)),
  clients = { openalex: fetchOpenAlexJournal, crossref: fetchCrossrefJournal }, onSourceResult, ...requestOptions } = {}) {
  validateWindow({ fromDate, toDate });
  const selected = journalKey ? [findJournal(config, journalKey)].filter((journal) => journal?.enabled) : enabledJournals(config);
  if (!selected.length) throw new Error('没有匹配的已启用期刊');
  const sourceResults = [];
  for (const journal of selected) {
    // Always dispatch BOTH; neither source is a fallback for the other.
    const outcomes = await Promise.allSettled(['openalex', 'crossref'].map((source) =>
      Promise.resolve().then(() => clients[source](journal, { ...requestOptions, fromDate, toDate, checkedAt }))));
    for (const [index, outcome] of outcomes.entries()) {
      const result = outcome.status === 'fulfilled' ? outcome.value : { source: ['openalex', 'crossref'][index], journal_key: journal.key,
        ok: false, complete: false, records: [], raw_pages: [], raw_count: 0, rejected: [], duration_ms: 0,
        error: { code: 'CLIENT_ERROR', message: '数据源客户端执行失败' } };
      // The persistence runner stages raw pages BEFORE filtering and merging.
      if (onSourceResult) await onSourceResult(result);
      sourceResults.push(result);
    }
  }
  const filtered = filterSourceRecords(sourceResults.flatMap((result) => result.records));
  const merged = mergePapers(filtered.accepted, { existingPapers, firstSeenDate, checkedAt });
  const allOk = sourceResults.every((result) => result.ok && result.complete);
  const anyUseful = sourceResults.some((result) => result.ok || result.records.length);
  const status = allOk ? merged.stats.added || merged.stats.updated ? 'success' : 'no_updates'
    : anyUseful ? 'partial_failure' : 'full_failure';
  return { ...merged, status, excluded: filtered.excluded, notices: filtered.notices,
    source_results: sourceResults, from_date: fromDate, to_date: toDate, checked_at: checkedAt };
}
