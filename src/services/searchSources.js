import { cleanText } from './paperModel.js';
import { safeSerpAccount, safeSerpAccountDiagnostics } from './searchBudget.js';
import { EvidenceError } from './evidenceHttp.js';
import { safeSearchDiagnostic } from './searchDiagnostics.js';

const fail = (condition, code) => { if (!condition) throw new EvidenceError(code); };
const credential = value => typeof value === 'string' && value.length >= 8 && value.length <= 1000 && !/\s/.test(value);

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
      search_provider: provider, requires_original_page_verification: true });
  }
  return leads;
}

export function paperSearchQuery(paper, provider) {
  const title = cleanText(paper.title || paper.title_original), doi = String(paper.doi || '').trim();
  fail(Boolean(title || doi), 'MISSING_SEARCH_IDENTITY');
  const full = doi || title;
  if (provider === 'zhipu') {
    // API query maximum is 70 characters. Full title remains in the expected identity;
    // a truncated search query must NEVER weaken later original-page matching.
    const prefix = [...full].slice(0, 70).join('');
    return prefix.length < full.length ? prefix.replace(/\s+\S*$/, '') || prefix : prefix;
  }
  return doi || `"${title.replaceAll('"', '')}"`;
}

export function journalSearchQuery(journal, month, provider) {
  fail(/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) && typeof journal.name === 'string', 'INVALID_JOURNAL_QUERY');
  const query = `${journal.name} ${month} articles`;
  return provider === 'zhipu' ? [...query].slice(0, 70).join('') : query;
}

/** No env access or IO on import. Production callers must wrap request in makeBudgetedSearch
 * with a durable remote checkpoint. Search snippets cannot enter the paper merger. */
export function makeSearchSources({ zhipuKey = '', serpapiKey = '', zhipuEngine = 'search_std',
  fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = 20000, maxBytes = 2000000 } = {}) {
  fail(['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark'].includes(zhipuEngine), 'INVALID_SEARCH_ENGINE');
  fail(Number.isFinite(timeoutMs) && timeoutMs > 0 && Number.isInteger(maxBytes) && maxBytes > 0, 'INVALID_SEARCH_OPTIONS');
  async function json(url, init, provider) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    let httpStatus = null;
    try {
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
      httpStatus = response.status;
      const httpCode = response.status === 429 ? 'RATE_LIMITED' : [401, 403].includes(response.status) ? 'ACCESS_RESTRICTED' : 'SEARCH_HTTP_ERROR';
      // Error bodies have the same byte/time bounds as successful responses. Their
      // message text is discarded; only a known numeric business code can survive.
      const reader = response.body?.getReader(); fail(reader, response.ok ? 'INVALID_SEARCH_RESPONSE' : httpCode);
      const chunks = []; let size = 0;
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
          fail(size <= maxBytes, 'SEARCH_RESPONSE_TOO_LARGE'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new EvidenceError(response.ok ? 'INVALID_SEARCH_RESPONSE' : httpCode); }
      if (!response.ok || data?.error) throw new EvidenceError(response.ok ? 'SEARCH_PROVIDER_ERROR' : httpCode,
        { provider_error_code: data?.error?.code });
      fail(data && typeof data === 'object', 'SEARCH_PROVIDER_ERROR'); return data;
    } catch (error) {
      const diagnostic = safeSearchDiagnostic({
        code: error instanceof EvidenceError ? error.code : controller.signal.aborted ? 'TIMEOUT' : 'SEARCH_NETWORK_ERROR',
        http_status: httpStatus, provider_error_code: error instanceof EvidenceError ? error.provider_error_code : null
      }, provider);
      throw new EvidenceError(diagnostic.code, diagnostic);
    } finally { clearTimeout(timer); }
  }
  async function readAccount() {
      fail(credential(serpapiKey), 'MISSING_SERPAPI_KEY');
      const url = new URL('https://serpapi.com/account.json'); url.searchParams.set('api_key', serpapiKey);
      return json(url.href, { method: 'GET', headers: { Accept: 'application/json' } });
  }
  return {
    async accountDiagnostics() { return safeSerpAccountDiagnostics(await readAccount(), now().toISOString()); },
    async account() {
      // Do not log or persist data: /account.json includes the private API key.
      return safeSerpAccount(await readAccount(), now().toISOString());
    },
    async request({ provider, query }) {
      fail(typeof query === 'string' && query.trim() && query.length <= 2000, 'INVALID_SEARCH_QUERY');
      let data;
      if (provider === 'zhipu') {
        fail(credential(zhipuKey), 'MISSING_ZHIPU_KEY'); fail([...query].length <= 70, 'SEARCH_QUERY_TOO_LONG');
        data = await json('https://open.bigmodel.cn/api/paas/v4/web_search', { method: 'POST',
          headers: { Authorization: `Bearer ${zhipuKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ search_engine: zhipuEngine, search_query: query, search_intent: false,
            count: 10, search_recency_filter: 'noLimit', content_size: 'medium' }) }, provider);
      } else {
        fail(['serpapi_scholar', 'serpapi_google'].includes(provider), 'INVALID_SEARCH_PROVIDER');
        fail(credential(serpapiKey), 'MISSING_SERPAPI_KEY');
        const url = new URL('https://serpapi.com/search.json');
        url.searchParams.set('api_key', serpapiKey); url.searchParams.set('q', query);
        url.searchParams.set('engine', provider === 'serpapi_scholar' ? 'google_scholar' : 'google');
        url.searchParams.set('num', '10');
        data = await json(url.href, { method: 'GET', headers: { Accept: 'application/json' } });
        fail(data.search_metadata?.status === 'Success', 'INVALID_SEARCH_RESPONSE');
        // Some successful zero-result queries omit organic_results.
        if (!data.organic_results && data.search_information?.total_results === 0) data.organic_results = [];
      }
      return { provider, charged: 1, leads: searchLeads(data, provider), searched_at: now().toISOString() };
    }
  };
}

// All engines share the same verification callback. Stop only after the requested issue
// is actually resolved from original evidence, not merely after finding a plausible link.
export async function searchWithFallback({ queryFor, search, verifyLead, maxLeadsPerSource = 10 }) {
  fail(typeof queryFor === 'function' && typeof search === 'function' && typeof verifyLead === 'function' &&
    Number.isInteger(maxLeadsPerSource) && maxLeadsPerSource >= 1 && maxLeadsPerSource <= 50, 'INVALID_SEARCH_OPTIONS');
  const attempts = []; let incomplete = false, blockedQuota = false;
  for (const provider of ['zhipu', 'serpapi_scholar', 'serpapi_google']) {
    let result;
    try { result = await search({ provider, query: queryFor(provider) }); }
    catch (error) { if (['EVIDENCE_STORAGE_ERROR', 'SEARCH_LEDGER_CHECKPOINT_FAILED'].includes(error?.code)) throw error;
      incomplete = true; attempts.push({ provider, status: 'source_unavailable' }); continue; }
    if (!result.called) {
      const status = result.reason === 'quota_exhausted' ? 'quota_exhausted' : 'source_unavailable';
      blockedQuota ||= provider.startsWith('serpapi_') && status === 'quota_exhausted'; incomplete = true;
      attempts.push({ provider, status });
      // Both SerpAPI engines use one balance; do not re-query an exhausted account.
      if (provider.startsWith('serpapi_') && status === 'quota_exhausted') break;
      continue;
    }
    if (!Array.isArray(result.result?.leads)) { incomplete = true; attempts.push({ provider, status: 'source_unavailable' }); continue; }
    let confirmed = null, restricted = false;
    for (const lead of result.result.leads.slice(0, maxLeadsPerSource)) {
      try {
        const evidence = await verifyLead(lead);
        if (evidence?.resolved === true && evidence.record?.source_evidence && evidence.record?.title &&
            !Object.hasOwn(evidence.record, 'snippet')) { confirmed = evidence; break; }
      } catch (error) { if (error?.code === 'EVIDENCE_STORAGE_ERROR') throw error; restricted = true; }
    }
    if (confirmed) { attempts.push({ provider, status: 'resolved' }); return { status: 'resolved', confirmed, attempts }; }
    incomplete ||= restricted; attempts.push({ provider, status: restricted ? 'access_restricted' : 'not_found' });
  }
  return { status: blockedQuota ? 'quota_exhausted' : incomplete ? 'source_unavailable' : 'not_found', confirmed: null, attempts };
}
