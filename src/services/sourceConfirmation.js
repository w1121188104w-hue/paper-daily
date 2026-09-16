import { discoverySourcesFor } from './masterList.js';
import { titleIdentity, authorOverlap, compatibleDates } from './enrichmentSources.js';
import { publisherFor } from './publisherCatalog.js';
import { supportedRepecUrl } from './repecAbstract.js';
import { isIsoTime } from './libraryValidation.js';

export function evidenceAllowed(record) {
  try {
    const e = record.source_evidence, url = new URL(e.url), scope = new URL(e.scope_url);
    if (!isIsoTime(e.fetched_at) || !/^[a-f0-9]{64}$/.test(e.body_sha256) ||
      [url, scope].some(u => u.protocol !== 'https:' || u.username || u.password || u.port || u.hash)) return false;
    if (record.source === 'publisher') return publisherFor({ ...record, key: record.journal_key }).hosts.includes(url.hostname) &&
      publisherFor({ ...record, key: record.journal_key }).hosts.includes(scope.hostname) &&
      /^(article_|citation_meta_|publisher_rss$)/.test(e.method);
    if (record.source === 'repec') return e.method === 'repec_journal_abstract' && supportedRepecUrl(url.href, { key: record.journal_key });
    if (scope.href !== url.href) return false;
    const pathname = decodeURIComponent(url.pathname).toLowerCase();
    if (record.source === 'crossref') return e.method === 'crossref_api' && url.hostname === 'api.crossref.org' &&
      (pathname === `/works/${record.doi}` || /^\/journals\/[^/]+\/works$/.test(pathname));
    if (record.source === 'openalex') return e.method === 'openalex_api' && url.hostname === 'api.openalex.org' &&
      pathname === `/works/https://doi.org/${record.doi}`;
    return record.source === 'semanticscholar' && e.method === 'semanticscholar_abstract_api' &&
      url.hostname === 'api.semanticscholar.org' && pathname === `/graph/v1/paper/doi:${record.doi}`;
  } catch { return false; }
}

/** A second source confirms identity, not independent discovery or full coverage.
 * Compare to the ORIGINAL discovery row, not newly filled values from the same lookup. */
export function singleSourceConfirmationFor(paper) {
  const discovery = discoverySourcesFor(paper);
  if (discovery.length !== 1) return null;
  const originalSource = discovery[0], title = titleIdentity(paper.title_original);
  const anchors = paper.source_records.filter(r => r.source === originalSource &&
    (!r.source_evidence || r.source_evidence.method === 'semanticscholar_discovery_api'));
  for (const record of paper.source_records) {
    if (record.source === originalSource || record.journal_key !== paper.journal_key ||
      titleIdentity(record.title) !== title || !evidenceAllowed(record)) continue;
    if (paper.doi && record.doi && paper.doi !== record.doi) continue;
    if (paper.authors.length && record.authors.length && !authorOverlap(paper.authors, record.authors)) continue;
    if (!anchors.some(anchor => {
      if (titleIdentity(anchor.title) !== title) return false;
      if (anchor.authors.length && record.authors.length && !authorOverlap(anchor.authors, record.authors)) return false;
      if (anchor.doi && record.doi) return anchor.doi === record.doi;
      return title.length >= 24 && authorOverlap(anchor.authors, record.authors) && compatibleDates(anchor, record);
    })) continue;
    return { source: record.source, source_id: record.source_id, ...record.source_evidence };
  }
  return null;
}
