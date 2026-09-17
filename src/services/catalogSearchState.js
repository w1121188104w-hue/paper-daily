import { assertLibrary, isObject, isIsoTime, isDay, isCount } from './libraryValidation.js';
import { safeSearchLink } from './searchSources.js';

export const CATALOG_STATUSES = ['catalog_checked_partial', 'not_found', 'quota_exhausted', 'access_restricted', 'source_unavailable'];
export function validateCatalogSearchState(state) {
  assertLibrary(isObject(state) && Object.keys(state).length <= 2000, '清单搜索缓存无效');
  for (const [key, row] of Object.entries(state)) {
    assertLibrary(isObject(row) && /^[A-Z]{2,4}$/.test(row.journal_key) &&
      isDay(`${row.month}-01`) && key === `${row.journal_key}:${row.month}` &&
      CATALOG_STATUSES.includes(row.status) && isCount(row.attempt_count) && row.attempt_count > 0 &&
      isIsoTime(row.checked_at) && isIsoTime(row.next_retry_at) && Date.parse(row.next_retry_at) > Date.parse(row.checked_at) &&
      Array.isArray(row.urls) && row.urls.length <= 100 && new Set(row.urls).size === row.urls.length && row.urls.every(url => safeSearchLink(url)) &&
      Object.keys(row).every(k => ['journal_key', 'month', 'status', 'attempt_count', 'checked_at', 'next_retry_at', 'urls'].includes(k)), '清单搜索缓存条目无效');
  }
  return state;
}

export function catalogSearchDue(state, journalKey, month, now) {
  const old = state[`${journalKey}:${month}`];
  return !old || Date.parse(old.next_retry_at) <= now.getTime();
}
