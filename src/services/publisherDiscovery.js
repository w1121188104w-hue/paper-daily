import { EvidenceError } from './evidenceHttp.js';
import { publisherFor, canonicalPublisherUrl } from './publisherCatalog.js';
import { parsePublisherFeed, parsePublisherArticle, discoverPublisherLinks, aeaIssueLinks, doiFromPublisherUrl } from './publisherParsers.js';

export const safeEvidenceCode = error => /^[A-Z_]{3,50}$/.test(error?.code || '') ? error.code : 'PARSE_ERROR';
const fatal = error => { if (error?.code === 'EVIDENCE_STORAGE_ERROR') throw error; };

/** Bounded, robots-respecting public discovery. No connector is certified exhaustive yet. */
export async function discoverOfficialPapers(journal, window, { http, maxPages = 5, maxArticles = 100, onProgress = () => {} } = {}) {
  const p = publisherFor(journal), attempts = [], leads = [], visited = new Set(), articleUrls = new Set();
  let listRead = false;
  async function fetchPage(url, kind) {
    if (visited.has(url)) return null;
    visited.add(url);
    try { const response = await http.request(url,p.hosts); return response; }
    catch (error) { fatal(error); attempts.push({ url, kind, status: safeEvidenceCode(error) }); return null; }
  }
  async function feed(url) {
    const response = await fetchPage(url,'feed'); if (!response) return;
    try {
      const result = parsePublisherFeed(response,journal); leads.push(...result.rows); listRead = true;
      attempts.push({ url: response.url, kind: 'feed', status: 'PARTIAL_FEED', observed: result.rows.length,
        rejected: result.rejected, body_sha256: response.sha256, fetched_at: response.fetched_at });
    } catch (error) { fatal(error); attempts.push({ url, kind: 'feed', status: safeEvidenceCode(error) }); }
  }
  for (const url of p.feeds) await feed(url);
  const home = await fetchPage(p.home,'list');
  const pages = [];
  if (home) {
    if (p.family === 'aea') {
      const issues = aeaIssueLinks(home,window.fromDate,window.toDate);
      attempts.push({ url: home.url, kind: 'issue_index', status: issues.length ? 'ISSUES_DISCOVERED' : 'NO_VERIFIED_LIST',
        observed: issues.length, body_sha256: home.sha256, fetched_at: home.fetched_at });
      for (const issue of issues.slice(0,maxPages)) { const response = await fetchPage(issue.url,'issue'); if (response) pages.push(response); }
      if (issues.length > maxPages) attempts.push({ kind: 'limit', status: 'PAGE_LIMIT' });
    } else pages.push(home);
  }
  for (let index = 0; index < pages.length && index < maxPages; index++) {
    const response = pages[index], links = discoverPublisherLinks(response,journal);
    for (const url of links.feeds.slice(0,5)) await feed(url);
    for (const url of links.articles) articleUrls.add(canonicalPublisherUrl(url));
    attempts.push({ url: response.url, kind: 'list', status: links.articles.length ? 'ARTICLE_LINKS_DISCOVERED' : 'NO_VERIFIED_LIST',
      observed: links.articles.length, body_sha256: response.sha256, fetched_at: response.fetched_at });
    for (const url of links.next) {
      if (pages.length >= maxPages) { attempts.push({ kind: 'limit', status: 'PAGE_LIMIT' }); break; }
      const next = await fetchPage(url,'next'); if (next) pages.push(next);
    }
  }
  // Feed entries are already identified; fetch HTML-only discoveries for journal and DOI confirmation.
  const known = new Set(leads.map(l => canonicalPublisherUrl(l.url)));
  const toFetch = [...articleUrls].filter(u => !known.has(u));
  for (const url of toFetch.slice(0,maxArticles)) {
    const response = await fetchPage(url,'article'); if (!response) continue;
    try {
      const lead = parsePublisherArticle(response,journal,{ doi: doiFromPublisherUrl(url), scope_url: p.home });
      if (!lead.journal_confirmed) throw new EvidenceError('UNVERIFIED_JOURNAL_LIST');
      leads.push(lead); listRead = true;
    } catch (error) { fatal(error); attempts.push({ url, kind: 'article', status: safeEvidenceCode(error) }); }
    onProgress({ journal_key: journal.key, phase: 'official_article', observed: leads.length });
  }
  if (toFetch.length > maxArticles) attempts.push({ kind: 'limit', status: 'ARTICLE_LIMIT', pending_urls: toFetch.slice(maxArticles) });
  const unique = new Map();
  for (const lead of leads) {
    const key = lead.doi || canonicalPublisherUrl(lead.url), old = unique.get(key);
    // Retain conflicting identities for reconciliation rather than silently accepting a feed winner.
    if (old && old.title !== lead.title) { unique.set(`${key}:${lead.evidence.body_sha256}`,lead); continue; }
    if (!old || (!old.abstract && lead.abstract) || (!old.authors.length && lead.authors.length)) unique.set(key,lead);
  }
  return { journal_key: journal.key, coverage: listRead ? 'partial' : 'restricted',
    coverage_reason: 'Official public lists are supplemental; feeds, pagination, online-first and boundary dates may be incomplete.',
    leads: [...unique.values()], attempts, official_observed_count: listRead ? unique.size : null };
}
