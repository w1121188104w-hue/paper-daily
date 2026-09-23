export const ALLOWED_HOSTS = new Set([
  'doi.org', 'www.sciencedirect.com', 'onlinelibrary.wiley.com',
  'link.springer.com', 'link.springernature.com', 'www.journals.uchicago.edu',
  'academic.oup.com', 'pubsonline.informs.org', 'journals.sagepub.com',
  'publications.aaahq.org', 'www.aeaweb.org', 'pubs.aeaweb.org'
]);
export const normalizeTitle = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function normalizeDoi(value) {
  const text = String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  let decoded; try { decoded = decodeURIComponent(text); } catch { return ''; }
  return /^10\.\d{4,9}\/\S+$/i.test(decoded) ? decoded.toLowerCase() : '';
}
export function safeSourceUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !ALLOWED_HOSTS.has(u.hostname)) return null;
    // Never persist session tokens or general query strings. AEA's article id is a DOI.
    const id = u.hostname.endsWith('aeaweb.org') ? normalizeDoi(u.searchParams.get('id')) : '';
    u.search = ''; u.hash = '';
    if (id) u.searchParams.set('id', id);
    return u.href;
  } catch { return null; }
}
export function validateSamples(input) {
  if (!input || !Array.isArray(input.papers) || !input.papers.length || input.papers.length > 20) throw Error('样本需为 1–20 条。');
  const seen = new Set();
  return input.papers.map(p => {
    const doi = normalizeDoi(p.doi);
    if (!doi || seen.has(doi) || typeof p.title !== 'string' || p.title.length < 10 || p.title.length > 1500) throw Error('样本 DOI 或标题无效/重复。');
    seen.add(doi);
    const url = p.url || 'https://doi.org/' + doi;
    if (!safeSourceUrl(url)) throw Error('样本网址不是允许的官方 HTTPS 页面。');
    return { doi, title: p.title, journal: String(p.journal || ''), url: safeSourceUrl(url) };
  });
}
export function identityMatches(paper, dois, titles) {
  const expected = normalizeDoi(paper.doi), actual = [...new Set(dois.map(normalizeDoi).filter(Boolean))];
  // Contradictory article metadata is never overridden by a similar title.
  if (actual.some(d => d !== expected)) return { ok: false, reason: 'doi_conflict' };
  if (actual.includes(expected)) return { ok: true, method: 'exact_doi' };
  if (titles.some(t => normalizeTitle(t) === normalizeTitle(paper.title))) return { ok: true, method: 'exact_normalized_title' };
  return { ok: false, reason: 'identity_unconfirmed' };
}
export function assessCapture(paper, capture) {
  const source = safeSourceUrl(capture.url), base = { source_url: source, abstract: null };
  if (!source || new URL(source).hostname === 'doi.org') return { ...base, status: 'unsupported_page' };
  if (capture.challenge) return { ...base, status: 'needs_user_verification' };
  const identity = identityMatches(paper, capture.dois || [], capture.titles || []);
  if (!identity.ok) return { ...base, status: identity.reason };
  if (capture.noAbstract) return { ...base, status: 'no_abstract_stated', identity };
  let partial = false;
  for (const candidate of capture.candidates || []) {
    if (candidate.doi && normalizeDoi(candidate.doi) !== normalizeDoi(paper.doi)) continue;
    const text = String(candidate.text || '').trim();
    if (text.length < 150 || text.length > 20000) continue;
    if (candidate.truncated || /(?:\.{3}|…)\s*$/.test(text) || /(?:read more|show more)\s*$/i.test(text)) { partial = true; continue; }
    if (/access denied|verify (?:you are|that you)|enable javascript|sign in to (?:access|view)/i.test(text)) continue;
    // Conservative language gate; no translation or reconstruction here.
    const words = text.match(/\b[A-Za-z]+\b/g) || [];
    if (words.length < 25 || !/\b(?:the|this|we|of|and|in)\b/i.test(text) || /[\u4e00-\u9fff]{5}/u.test(text)) continue;
    if (candidate.language && !/^en(?:[-_]|$)/i.test(candidate.language)) continue;
    return { ...base, status: 'candidate_extracted', abstract: text, identity,
      abstract_field: candidate.field, abstract_length: text.length,
      verification: 'page_identity_checked_not_independently_reviewed' };
  }
  return { ...base, status: partial ? 'partial_only' : 'not_found', identity };
}
