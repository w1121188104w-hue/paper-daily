import { cleanText } from './paperModel.js';
import { EvidenceError } from './evidenceHttp.js';
import { safeSearchDiagnostic } from './searchDiagnostics.js';
import { publisherFor } from './publisherCatalog.js';

const fail = (condition, code) => { if (!condition) throw new EvidenceError(code); };

export function safeSearchLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || value.length > 3000 ||
        !url.hostname.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname) ||
        /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':') ||
        [...url.searchParams.keys()].some(key => /api.?key|token|secret|authorization/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}

// Search output is a LEAD, never a normalized paper or an original abstract.
export function searchLeads(data, provider) {
  const rows = provider === 'zhipu' ? data.search_result : data.organic_results;
  fail(Array.isArray(rows), 'INVALID_SEARCH_RESPONSE');
  const seen = new Set(), leads = [];
  for (const row of rows.slice(0, 50)) {
    const url = safeSearchLink(row?.link), title = cleanText(row?.title);
    if (!url || !title || title.length > 1500 || seen.has(url)) continue;
    seen.add(url);
    leads.push({ title, url, snippet: cleanText(provider === 'zhipu' ? row.content : row.snippet).slice(0, 3000),
      ...(provider === 'zhipu' ? { content: String(row.content || '').slice(0, 40000) } : {}),
      search_provider: provider, requires_original_page_verification: true });
  }
  return leads;
}

export function paperSearchQuery(paper, provider) {
  const title = cleanText(paper.title || paper.title_original), doi = String(paper.doi || '').trim();
  fail(Boolean(title || doi), 'MISSING_SEARCH_IDENTITY');
  // General web search often treats bare DOIs as noisy number tokens. Prefer
  // the complete title where it fits; keep DOI for longer Zhipu queries/Scholar.
  const full = provider === 'zhipu' && title && [...title].length <= 70 ? title : doi || title;
  if (provider === 'zhipu') {
    // API query maximum is 70 characters. Full title remains in the expected identity;
    // a truncated search query must NEVER weaken later original-page matching.
    const prefix = [...full].slice(0, 70).join('');
    return prefix.length < full.length ? prefix.replace(/\s+\S*$/, '') || prefix : prefix;
  }
  return provider === 'serpapi_google' && title ? `"${title.replaceAll('"', '')}"` : doi || `"${title.replaceAll('"', '')}"`;
}

export function journalSearchQuery(journal, month, provider) {
  fail(/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) && typeof journal.name === 'string', 'INVALID_JOURNAL_QUERY');
  const query = `${journal.name} ${month} articles`;
  return provider === 'zhipu' ? [...query].slice(0, 70).join('') : query;
}

// The 70-character search limit must not make long titles disappear from all
// queries. These shortened strings are discovery hints only; acceptance still
// checks the complete title and DOI against original evidence.
export function abstractSearchQueries(paper, journal) {
  const title = cleanText(paper.title || paper.title_original);
  const clip = (text, size) => {
    const chars = [...text];
    if (chars.length <= size) return text;
    const prefix = chars.slice(0, size).join('');
    return prefix.replace(/\s+\S*$/, '') || prefix;
  };
  const query = paperSearchQuery(paper, 'zhipu');
  const doi = String(paper.doi || '').trim();
  const repecSuffix = ' site:ideas.repec.org';
  // Restrict discovery to the journal's verified publisher first. A site:
  // operator is a search hint, not identity proof or permission to bypass a page.
  const publisher = publisherFor(journal);
  const publisherHost = new URL(publisher.home).hostname.replace(/^www\./, '');
  // Only public article surfaces, not every allowed host (which can include an
  // API endpoint). Keep both documented Springer Link domains discoverable.
  const searchHosts = publisher.family === 'springer'
    ? ['link.springernature.com', 'link.springer.com'] : [publisherHost];
  const publisherQueries = searchHosts.flatMap(host => {
    const publisherSuffix = ` site:${host}`;
    return [
      ...(doi && [...doi + publisherSuffix].length <= 70 ? [doi + publisherSuffix] : []),
      ...(title ? [clip(title, 70 - publisherSuffix.length) + publisherSuffix] : [])
    ];
  });
  return [...new Set([...publisherQueries, query,
    ...(title ? [clip(title, 70), clip(title, 61) + ' Abstract'] : []),
    clip(doi || query, 61) + ' Abstract',
    clip(doi || query, 70 - repecSuffix.length) + repecSuffix,
    ...(title ? [clip(title, 70 - repecSuffix.length) + repecSuffix] : [])])];
}

// Historical evidence helpers only. All paid HTTP transports were removed.

// All engines share the same verification callback. Stop only after the requested issue
// is actually resolved from original evidence, not merely after finding a plausible link.
export async function searchWithFallback({ queryFor, search, verifyLead, verifyResult, maxLeadsPerSource = 10 }) {
  fail(typeof queryFor === 'function' && typeof search === 'function' && typeof verifyLead === 'function' &&
    Number.isInteger(maxLeadsPerSource) && maxLeadsPerSource >= 1 && maxLeadsPerSource <= 50, 'INVALID_SEARCH_OPTIONS');
  const attempts = []; let incomplete = false, blockedQuota = false;
  for (const provider of ['zhipu', 'serpapi_scholar', 'serpapi_google']) {
    for (const query of [queryFor(provider)].flat()) {
    let result;
    try { result = await search({ provider, query }); }
    catch (error) { if (['EVIDENCE_STORAGE_ERROR', 'SEARCH_LEDGER_CHECKPOINT_FAILED'].includes(error?.code)) throw error;
      incomplete = true; attempts.push({ provider, status: 'source_unavailable', stage: 'search_request', diagnostic: safeSearchDiagnostic(error, provider) }); continue; }
    if (!result.called) {
      const status = result.reason === 'quota_exhausted' ? 'quota_exhausted' : 'source_unavailable';
      blockedQuota ||= provider.startsWith('serpapi_') && status === 'quota_exhausted'; incomplete = true;
      attempts.push({ provider, status, called: false, stage: 'search_not_called' });
      // Both SerpAPI engines use one balance; do not re-query an exhausted account.
      if (provider.startsWith('serpapi_') && status === 'quota_exhausted') return { status: 'quota_exhausted', confirmed: null, attempts };
      continue;
    }
    if (!Array.isArray(result.result?.leads)) { incomplete = true; attempts.push({ provider, status: 'source_unavailable', called: true,
      stage: 'search_response', diagnostic: safeSearchDiagnostic(result.diagnostic, provider) }); continue; }
    let confirmed = null, restricted = false;
    const diagnostics = [];
    if (provider === 'zhipu' && verifyResult) {
      try {
        const record = await verifyResult(result.result.leads);
        if (record?.source_evidence && record.title) {
          attempts.push({ provider, status: 'resolved', called: true, stage: 'grounded_extraction' });
          return { status: 'resolved', confirmed: { record }, attempts };
        }
      } catch (error) {
        if (['EVIDENCE_STORAGE_ERROR', 'SEARCH_LEDGER_CHECKPOINT_FAILED'].includes(error.code)) throw error;
        diagnostics.push({ status: 'EXTRACTION_NOT_VERIFIED' });
      }
    }
    for (const lead of result.result.leads.slice(0, maxLeadsPerSource)) {
      try {
        const evidence = await verifyLead(lead);
        diagnostics.push({ status: evidence?.resolved ? 'confirmed' : ['NOT_OFFICIAL_HOST', 'UNSAFE_LINK', 'UNRESOLVED_FIELDS'].includes(evidence?.reason) ? evidence.reason : 'not_verified' });
        if (evidence?.resolved === true && evidence.record?.source_evidence && evidence.record?.title &&
            !Object.hasOwn(evidence.record, 'snippet')) { confirmed = evidence; break; }
      } catch (error) { if (error?.code === 'EVIDENCE_STORAGE_ERROR') throw error; restricted = true;
        const code = ['ACCESS_RESTRICTED', 'RATE_LIMITED', 'ROBOTS_UNAVAILABLE', 'ROBOTS_DISALLOWED', 'REDIRECT_RESTRICTED',
          'UNVERIFIED_IDENTITY', 'NO_ABSTRACT', 'PUBLISHER_NO_ABSTRACT', 'JOURNAL_MISMATCH', 'REQUEST_LIMIT', 'TIMEOUT', 'NOT_FOUND', 'UNSAFE_URL'].includes(error?.code) ? error.code : 'PAGE_UNAVAILABLE';
        diagnostics.push({ status: code }); }
    }
    const detail = { called: true, stage: 'original_page_verification', leads_returned: result.result.leads.length, leads_checked: diagnostics.length,
      lead_statuses: Object.fromEntries([...new Set(diagnostics.map(row => row.status))].map(status => [status, diagnostics.filter(row => row.status === status).length])) };
    if (confirmed) { attempts.push({ provider, status: 'resolved', ...detail }); return { status: 'resolved', confirmed, attempts }; }
    incomplete ||= restricted; attempts.push({ provider, status: restricted ? 'access_restricted' : 'not_found', ...detail });
    }
  }
  return { status: blockedQuota ? 'quota_exhausted' : incomplete ? 'source_unavailable' : 'not_found', confirmed: null, attempts };
}
