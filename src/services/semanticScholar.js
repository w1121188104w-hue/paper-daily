import { createHash } from 'node:crypto';
import { fetchPages, validateWindow } from './sourceClient.js';
import { SourceError } from './sourceHttp.js';
import { normalizeSourceRecord, normalizeTitleForMatch, normalizePartialDate } from './paperModel.js';

const FIELDS = 'title,abstract,externalIds,authors,journal,venue,publicationVenue,publicationDate,year,publicationTypes,url';
const venueName = value => normalizeTitleForMatch(value).replace(/^the /, '');

export function buildSemanticScholarUrl(journal, { fromDate, toDate, cursor = '*' }) {
  validateWindow({ fromDate, toDate });
  if (!journal.name || /[\r\n]/.test(journal.name)) throw new SourceError('INVALID_JOURNAL', 'Semantic Scholar期刊名称无效');
  const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search/bulk');
  // Commas separate DIFFERENT venues in this API (AOS contains a comma in its official name).
  url.searchParams.set('venue', journal.name.replaceAll(',', ''));
  // Date filters treat unknown dates as Jan 1. Fetch relevant YEARS, then filter locally.
  const start = fromDate.slice(0, 4), end = toDate.slice(0, 4);
  url.searchParams.set('year', start === end ? start : `${start}-${end}`);
  url.searchParams.set('fields', FIELDS);
  if (cursor !== '*') url.searchParams.set('token', cursor);
  return url;
}

export function normalizeSemanticScholarWork(work, journal, checkedAt, context) {
  const venue = work?.publicationVenue || {};
  const issns = [venue.issn, ...(Array.isArray(venue.alternate_issns) ? venue.alternate_issns : [])]
    .filter(Boolean).map(value => String(value).toUpperCase());
  const matchesIssn = issns.some(value => [journal.print_issn, journal.electronic_issn].includes(value));
  const names = [work?.journal?.name, venue.name, work?.venue].filter(Boolean);
  if ((issns.length && !matchesIssn) || (!matchesIssn && !names.some(name => venueName(name) === venueName(journal.name))) ||
      (venue.type && venue.type.toLowerCase() !== 'journal')) throw new SourceError('INVALID_RECORD', 'Semantic Scholar期刊身份未核实');
  if (typeof work?.paperId !== 'string' || !/^[a-f0-9]{40}$/i.test(work.paperId)) throw new SourceError('INVALID_RECORD', 'Semantic Scholar论文标识无效');
  const date = normalizePartialDate(work.publicationDate);
  const year = Number.isInteger(work.year) && work.year >= 1000 && work.year <= 9999 ? String(work.year) : '';
  if (work.publicationDate && !date) throw new SourceError('INVALID_RECORD', 'Semantic Scholar出版日期无效');
  const types = Array.isArray(work.publicationTypes) ? work.publicationTypes : [];
  const evidenceUrl = new URL(context.url);
  evidenceUrl.searchParams.delete('token'); // Opaque continuation tokens are not public source URLs.
  return normalizeSourceRecord({ source: 'semanticscholar', source_id: work.paperId,
    doi: work.externalIds?.DOI || '', title: work.title, abstract: work.abstract || '', authors: work.authors,
    journal_key: journal.key, journal_name: journal.name, journal_category: journal.category,
    journal_category_zh: journal.category_zh, print_issn: journal.print_issn, electronic_issn: journal.electronic_issn,
    publication_date: date || year,
    raw_dates: { publication_date: work.publicationDate || null, publication_year: work.year ?? null },
    last_checked_at: checkedAt, url: `https://www.semanticscholar.org/paper/${work.paperId}`,
    volume: work.journal?.volume, pages: work.journal?.pages,
    type: types.includes('Editorial') ? 'editorial' : types.includes('Review') ? 'review' : 'journal-article',
    source_evidence: { url: String(evidenceUrl), scope_url: String(evidenceUrl), fetched_at: checkedAt,
      body_sha256: createHash('sha256').update(JSON.stringify(context.payload)).digest('hex'),
      method: 'semanticscholar_discovery_api' }
  });
}

export function fetchSemanticScholarJournal(journal, options = {}) {
  const { semanticScholarKey = '', ...rest } = options;
  return fetchPages('semanticscholar', journal, {
    ...rest, pageDelayMs: Math.max(rest.pageDelayMs ?? 1100, 1100),
    requestHeaders: semanticScholarKey ? { 'x-api-key': semanticScholarKey } : {}
  }, {
    url: buildSemanticScholarUrl,
    normalize(item, configured, checkedAt, context) {
      const record = normalizeSemanticScholarWork(item, configured, checkedAt, context);
      const date = record.publication_date;
      // Month/year precision is preserved; overlapping boundary records remain candidates.
      if (date && (date < rest.fromDate.slice(0, date.length) || date > rest.toDate.slice(0, date.length))) return null;
      return record;
    },
    page(payload) {
      if (!Array.isArray(payload?.data) || !Number.isFinite(payload?.total) || payload.total < 0 ||
          (payload.token != null && (typeof payload.token !== 'string' || !payload.token))) {
        throw new SourceError('INVALID_RESPONSE', 'Semantic Scholar批量返回结构无效');
      }
      if (!payload.data.length && payload.token) throw new SourceError('INVALID_RESPONSE', 'Semantic Scholar空页仍带分页令牌');
      return { items: payload.data, nextCursor: payload.token, done: payload.token == null };
    }
  });
}
