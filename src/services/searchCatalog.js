import { load } from 'cheerio';
import { publisherFor, canonicalPublisherUrl } from './publisherCatalog.js';
import { discoverPublisherLinks, parsePublisherArticle, parsePublisherFeed, aeaIssueLinks, doiFromPublisherUrl, windowMembership } from './publisherParsers.js';
import { safeSearchLink } from './searchSources.js';
import { safeEvidenceCode } from './publisherDiscovery.js';
import { EvidenceError } from './evidenceHttp.js';

const engines = ['zhipu', 'serpapi_scholar', 'serpapi_google'];
export function catalogMonths(window) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(window?.fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(window?.toDate) || window.fromDate > window.toDate) throw new EvidenceError('INVALID_SEARCH_WINDOW');
  const months = [], date = new Date(`${window.fromDate.slice(0, 7)}-01T00:00:00Z`);
  while (date.toISOString().slice(0, 7) <= window.toDate.slice(0, 7)) {
    months.push(date.toISOString().slice(0, 7)); date.setUTCMonth(date.getUTCMonth() + 1);
    if (months.length > 3) throw new EvidenceError('INVALID_SEARCH_WINDOW');
  }
  return months;
}
export function catalogSearchQuery(journal, month, provider) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new EvidenceError('INVALID_SEARCH_WINDOW');
  // Put the month first so truncating a long journal name cannot silently lose the window.
  const prefix = `${month} `, suffix = ' contents online first';
  const name = provider === 'zhipu' ? [...journal.name].slice(0, 70 - prefix.length - suffix.length).join('') : journal.name;
  return prefix + name + suffix;
}
const officialUrl = (value, journal) => {
  const safe = safeSearchLink(value);
  return safe && publisherFor(journal).hosts.includes(new URL(safe).hostname) ? canonicalPublisherUrl(safe) : null;
};
const entryKey = lead => `${lead.doi || lead.url}|${lead.title.toLowerCase().replace(/\W/g, '')}`;

// Only journal-scoped directory links and explicit next-page links. Never crawl an entire publisher.
function directoryLinks(response, journal, window) {
  const p = publisherFor(journal), $ = load(response.body), found = [...aeaIssueLinks(response, window.fromDate, window.toDate).map(row => row.url)];
  $('a[href]').each((i, node) => {
    let value; try { value = new URL($(node).attr('href'), response.url).href; } catch { return; }
    const url = officialUrl(value, journal); if (!url) return;
    const pathname = new URL(url).pathname;
    const scoped = p.family === 'elsevier' ? pathname.startsWith(`/journal/${p.slug}/`) :
      p.family === 'springer' ? pathname.startsWith(`/journal/${p.journal_id}/`) :
      p.family === 'oup' ? pathname.startsWith(`/${p.code}/`) :
      p.family === 'atypon' ? pathname.startsWith(`/toc/${p.code}/`) :
      p.family === 'wiley' ? pathname.startsWith(`/toc/${journal.electronic_issn.replace('-', '')}/`) :
      p.family === 'silverchair' ? pathname.startsWith('/accounting-review/issue') : false;
    if (scoped && /issues?|vol(?:ume)?|advance|articles|toc|online|early/i.test(pathname)) found.push(url);
  });
  return [...new Set(found)];
}

/** First search phase: read ALL bounded official entries, not the first matching paper.
 * Search snippets are never parsed as publication lists or abstracts. Coverage stays partial. */
export async function readSearchCatalog(journal, window, seeds, { http, maxPages = 12, maxArticles = 100 } = {}) {
  const p = publisherFor(journal), pending = [], visited = new Set(), queued = new Set(), rows = new Map(), attempts = [];
  let pages = 0, articles = 0, listRead = false, incomplete = false;
  function enqueue(value, kind, scope) {
    const url = officialUrl(value, journal); if (!url || queued.has(url)) return;
    if (queued.size >= 1000) { incomplete = true; return; }
    queued.add(url); pending.push({ url, kind, scope: scope || url });
  }
  for (const seed of seeds) enqueue(seed.url || seed, 'unknown');
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index];
    if (visited.has(item.url)) continue;
    if ((item.kind === 'article' ? articles >= maxArticles : pages >= maxPages)) {
      incomplete = true; attempts.push({ url: item.url, status: item.kind === 'article' ? 'ARTICLE_LIMIT' : 'PAGE_LIMIT' }); continue;
    }
    visited.add(item.url); item.kind === 'article' ? articles++ : pages++;
    let response;
    try { response = await http.request(item.url, p.hosts); }
    catch (error) { if (error.code === 'EVIDENCE_STORAGE_ERROR') throw error;
      incomplete = true; attempts.push({ url: item.url, status: safeEvidenceCode(error) }); continue; }
    let article = null;
    try { article = parsePublisherArticle(response, journal, { doi: doiFromPublisherUrl(item.url), scope_url: item.scope, discovery: true }); }
    catch { /* A directory is not an article. A rejected article is never accepted from a snippet. */ }
    if (article?.journal_confirmed) {
      rows.set(entryKey(article), article);
      attempts.push({ url: response.url, status: 'VERIFIED_ARTICLE', body_sha256: response.sha256, fetched_at: response.fetched_at });
      continue;
    }
    if (item.kind === 'article') { incomplete = true; attempts.push({ url: response.url, status: 'UNVERIFIED_ARTICLE' }); continue; }
    if (/xml|rss|atom/.test(response.content_type || '') || /^\s*(?:<\?xml[^>]*>\s*)?<(?:rss|feed|rdf:)/i.test(response.body)) {
      try {
        const result = parsePublisherFeed(response, journal); listRead = true;
        result.rows.forEach(row => rows.set(entryKey(row), row));
        // A feed alone never establishes coverage of the complete publication archive.
        incomplete = true; attempts.push({ url: response.url, status: 'PARTIAL_FEED', observed: result.rows.length });
      } catch { incomplete = true; attempts.push({ url: response.url, status: 'UNVERIFIED_FEED' }); }
      continue;
    }
    const links = discoverPublisherLinks(response, journal);
    if (links.articles.length) listRead = true;
    attempts.push({ url: response.url, status: links.articles.length ? 'CATALOG_READ' : 'NO_ARTICLE_LIST',
      observed: links.articles.length, body_sha256: response.sha256, fetched_at: response.fetched_at });
    links.articles.forEach(url => enqueue(url, 'article', response.url));
    [...links.next, ...directoryLinks(response, journal, window)].forEach(url => enqueue(url, 'list', response.url));
    links.feeds.forEach(url => enqueue(url, 'feed', response.url));
  }
  const leads = [...rows.values()];
  return { journal_key: journal.key, coverage: leads.length ? 'partial' : 'restricted',
    coverage_reason: 'Search-assisted official catalog evidence; complete publication coverage is not certified.',
    official_observed_count: leads.length || (listRead ? 0 : null), leads, attempts,
    verified_list_read: listRead && leads.some(row => row.evidence.scope_url !== row.url || row.evidence.method === 'publisher_rss'),
    incomplete, pending_urls: pending.filter(item => !visited.has(item.url)).map(item => item.url),
    checked_urls: [...visited] };
}

export async function searchJournalCatalog(journal, window, { search, readCatalog = readSearchCatalog, http, months = catalogMonths(window) } = {}) {
  const records = new Map(), attempts = [], queries = [], seen = new Set(); let anyList = false;
  for (const month of months) {
    let taskStatus = 'not_found';
    for (const provider of engines) {
      let result;
      try { result = await search({ provider, query: catalogSearchQuery(journal, month, provider),
        taskId: `catalog:${journal.key}:${month}` }); }
      catch { taskStatus = 'source_unavailable'; attempts.push({ month, provider, status: 'SOURCE_UNAVAILABLE' }); continue; }
      if (!result.called || !result.result?.leads) {
        taskStatus = result.reason === 'quota_exhausted' ? 'quota_exhausted' : 'source_unavailable';
        attempts.push({ month, provider, status: taskStatus.toUpperCase() });
        if (provider.startsWith('serpapi_') && taskStatus === 'quota_exhausted') break;
        continue;
      }
      // Only known publisher domains become fetch targets. No generated text enters the list.
      const seeds = result.result.leads.filter(lead => officialUrl(lead.url, journal) && !seen.has(lead.url));
      let found;
      try { found = await readCatalog(journal, window, seeds, { http }); }
      catch (error) { if (error.code === 'EVIDENCE_STORAGE_ERROR') throw error;
        taskStatus = 'source_unavailable'; continue; }
      found.checked_urls.forEach(url => seen.add(url));
      found.leads.forEach(row => records.set(entryKey(row), row));
      anyList ||= found.verified_list_read;
      attempts.push(...found.attempts.map(row => ({ ...row, month, provider })));
      // Finding one article is NOT a completed catalog search. Dates must support this query month.
      const relevant = found.leads.some(row => row.date?.startsWith(month) && !['feed_update_date', 'issue_cover_date'].includes(row.date_role));
      if (found.verified_list_read && !found.incomplete && relevant) { taskStatus = 'catalog_checked_partial'; break; }
      if (found.incomplete) taskStatus = 'access_restricted';
    }
    queries.push({ month, status: taskStatus });
  }
  return { journal_key: journal.key, coverage: records.size ? 'partial' : 'restricted',
    coverage_reason: 'Journal-level search supplements official lists; it does not certify exhaustive coverage.',
    official_observed_count: records.size || (anyList ? 0 : null), leads: [...records.values()], attempts,
    search_queries: queries };
}
