import { fetchPages } from './sourceClient.js';
import { SourceError } from './sourceHttp.js';
import { isValidIssn } from './journals.js';
import { normalizeCrossrefWork } from './sourceNormalizers.js';

export function buildCrossrefUrl(journal, { fromDate, toDate, pageSize = 100, cursor = '*' }) {
  if (!isValidIssn(journal.crossref_route_issn)) throw new SourceError('INVALID_JOURNAL', '无效 Crossref ISSN');
  const url = new URL(`https://api.crossref.org/journals/${journal.crossref_route_issn}/works`);
  url.searchParams.set('filter', `from-pub-date:${fromDate},until-pub-date:${toDate},type:journal-article`);
  url.searchParams.set('rows', String(pageSize));
  url.searchParams.set('cursor', cursor);
  return url;
}

export function fetchCrossrefJournal(journal, options) {
  return fetchPages('crossref', journal, options, {
    url: buildCrossrefUrl,
    normalize: normalizeCrossrefWork,
    page(payload, pageSize) {
      if (payload?.status !== 'ok' || !Array.isArray(payload?.message?.items) ||
          !Number.isFinite(payload?.message?.['total-results'])) {
        throw new SourceError('INVALID_RESPONSE', 'Crossref 返回结构不完整');
      }
      return { items: payload.message.items, nextCursor: payload.message['next-cursor'],
        done: payload.message.items.length < pageSize };
    }
  });
}
