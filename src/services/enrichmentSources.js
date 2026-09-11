import { normalizeDoi, normalizeTitleForMatch, normalizeAuthorName, normalizeSourceRecord } from './paperModel.js';
import { normalizeCrossrefWork, normalizeOpenAlexWork } from './sourceNormalizers.js';
import { EvidenceError } from './evidenceHttp.js';
import { publisherFor } from './publisherCatalog.js';
import { authenticAbstract, parsePublisherArticle, parsePublisherFeed, publisherRecord, dateBounds } from './publisherParsers.js';

export const titleIdentity = value => normalizeTitleForMatch(value).replace(/\s/g, '');
const authorIdentity = value => normalizeAuthorName(value).split(' ').filter(Boolean).sort().join(' ');
export const authorOverlap = (a, b) => (a || []).some(x => (b || []).some(y =>
  (x.orcid && x.orcid === y.orcid) || authorIdentity(x.name || x) === authorIdentity(y.name || y)));
export const recordDate = p => p.published_online_date || p.publication_date || p.published_print_date || p.date || '';
export function compatibleDates(a, b) {
  const left = dateBounds(recordDate(a)), right = dateBounds(recordDate(b));
  if (['issue_cover_date','feed_update_date'].includes(a.date_role) && left && right) return left[0].slice(0,4) === right[0].slice(0,4);
  return Boolean(left && right && left[0] <= right[1] && right[0] <= left[1]);
}
export function strongMatch(expected, candidate) {
  if (expected.doi && candidate.doi) return normalizeDoi(expected.doi) === normalizeDoi(candidate.doi);
  return titleIdentity(expected.title || expected.title_original) === titleIdentity(candidate.title || candidate.title_original) &&
    authorOverlap(expected.authors, candidate.authors) && compatibleDates(expected, candidate);
}
function withEvidence(record, response, method) {
  return normalizeSourceRecord({ ...record, source_evidence: { url: response.url, scope_url: response.url,
    fetched_at: response.fetched_at, body_sha256: response.sha256, method } });
}

export function makeEnrichmentSources(http, { semanticScholarKey = '' } = {}) {
  const cache = new Map(), unavailable = new Map(), feedCache = new Map();
  async function api(url, headers = {}) {
    const host = new URL(url).hostname;
    if (unavailable.has(host)) throw new EvidenceError(unavailable.get(host));
    if (!cache.has(url)) cache.set(url, (async () => {
      try {
        const response = await http.request(url, [host], { checkRobots: false, headers });
        let data; try { data = JSON.parse(response.body); } catch { throw new EvidenceError('INVALID_JSON'); }
        return { response, data };
      } catch (error) {
        if (['ACCESS_RESTRICTED','RATE_LIMITED'].includes(error.code)) unavailable.set(host,error.code);
        throw error;
      }
    })());
    return cache.get(url);
  }
  async function crossref(expected, journal) {
    const doi = normalizeDoi(expected.doi);
    const url = doi ? `https://api.crossref.org/works/${encodeURIComponent(doi)}` :
      `https://api.crossref.org/journals/${journal.print_issn}/works?rows=5&query.title=${encodeURIComponent(expected.title || expected.title_original)}`;
    const { response, data } = await api(url), items = doi ? [data.message] : data.message?.items || [];
    const matches = [];
    for (const item of items) {
      let record; try { record = normalizeCrossrefWork(item,journal,response.fetched_at); } catch { continue; }
      if (strongMatch(expected, record)) matches.push(withEvidence(record, response, 'crossref_api'));
    }
    if (matches.length !== 1) throw new EvidenceError(matches.length ? 'AMBIGUOUS_IDENTITY' : 'UNVERIFIED_IDENTITY');
    return matches[0];
  }
  async function openalex(expected, journal) {
    if (!expected.doi) throw new EvidenceError('NO_DOI');
    const { response, data } = await api(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(normalizeDoi(expected.doi))}`);
    if (data.abstract_inverted_index) {
      const positions = Object.values(data.abstract_inverted_index).flat();
      if (!positions.length || positions.length > 20000 || positions.some(p => !Number.isInteger(p) || p < 0) ||
        new Set(positions).size !== positions.length || Math.max(...positions) !== positions.length - 1) throw new EvidenceError('INVALID_ABSTRACT_INDEX');
    }
    let record; try { record = normalizeOpenAlexWork(data,journal,response.fetched_at); } catch { throw new EvidenceError('UNVERIFIED_IDENTITY'); }
    if (!record.doi || !strongMatch(expected, record)) throw new EvidenceError('UNVERIFIED_IDENTITY');
    return withEvidence(record,response,'openalex_api');
  }
  async function semanticscholar(expected, journal) {
    if (!expected.doi) throw new EvidenceError('NO_DOI');
    const { response, data } = await api(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(normalizeDoi(expected.doi))}?fields=title,abstract,externalIds,authors,journal,publicationDate`,
      semanticScholarKey ? { 'x-api-key': semanticScholarKey } : {});
    if (normalizeDoi(data.externalIds?.DOI) !== normalizeDoi(expected.doi) ||
      titleIdentity(data.title) !== titleIdentity(expected.title || expected.title_original)) throw new EvidenceError('UNVERIFIED_IDENTITY');
    const record = { source: 'semanticscholar', source_id: data.paperId,
      doi: data.externalIds.DOI, title: data.title, abstract: data.abstract || '', authors: data.authors,
      journal_key: journal.key, journal_name: journal.name, journal_category: journal.category,
      journal_category_zh: journal.category_zh, print_issn: journal.print_issn, electronic_issn: journal.electronic_issn,
      publication_date: data.publicationDate, last_checked_at: response.fetched_at, type: 'journal-article',
      url: `https://www.semanticscholar.org/paper/${data.paperId}` };
    return withEvidence(record,response,'semanticscholar_abstract_api');
  }
  async function publisherArticle(expected,journal) {
    const p = publisherFor(journal);
    const url = expected.url;
    const response = await http.request(url,p.hosts);
    return publisherRecord(parsePublisherArticle(response,journal,{ ...expected,title: expected.title || expected.title_original,date: recordDate(expected) }),journal);
  }
  async function publisher(expected, journal, leads = []) {
    // Backfill/retry runs may be separate from today's list audit. Fetch each permitted feed once per run.
    if (!leads.length) {
      if (!feedCache.has(journal.key)) feedCache.set(journal.key, (async () => {
        const p = publisherFor(journal), rows = [];
        for (const url of p.feeds) {
          try { rows.push(...parsePublisherFeed(await http.request(url,p.hosts),journal).rows); }
          catch (error) { if (error.code === 'EVIDENCE_STORAGE_ERROR') throw error; }
        }
        return rows;
      })());
      leads = await feedCache.get(journal.key);
    }
    const matched = leads.filter(l => strongMatch(expected,l));
    const found = matched.find(l => authenticAbstract(l.abstract));
    if (found) {
      // A DOI-less official record matched to an existing DOI must not invent publisher DOI evidence.
      return publisherRecord(found, journal);
    }
    const p = publisherFor(journal);
    const allowedUrl = [expected.url, ...matched.map(l => l.url), ...(expected.source_records || []).map(r => r.url)].find(value => {
      try { const url = new URL(value); return url.protocol === 'https:' && p.hosts.includes(url.hostname); } catch { return false; }
    });
    const url = allowedUrl || (journal.key === 'AER' && expected.doi ? `https://www.aeaweb.org/articles?id=${encodeURIComponent(expected.doi)}` :
      expected.doi ? `https://doi.org/${encodeURIComponent(expected.doi).replace(/%2F/gi,'/')}` : '');
    if (!url) throw new EvidenceError('NO_OFFICIAL_URL');
    const response = await http.request(url,[...p.hosts, 'doi.org', 'dx.doi.org', 'www.doi.org']);
    if (!p.hosts.includes(new URL(response.url).hostname)) throw new EvidenceError('UNVERIFIED_IDENTITY');
    const article = parsePublisherArticle(response,journal,{ ...expected, title: expected.title || expected.title_original, date: recordDate(expected) });
    if (!article.abstract) throw new EvidenceError('PUBLISHER_NO_ABSTRACT');
    return publisherRecord(article,journal);
  }
  return { crossref, openalex, semanticscholar, publisher, publisherArticle };
}
