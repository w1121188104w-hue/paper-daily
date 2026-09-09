import { fetchPages } from './sourceClient.js';
import { SourceError } from './sourceHttp.js';
import { normalizeOpenAlexWork } from './sourceNormalizers.js';

export function buildOpenAlexUrl(journal, { fromDate, toDate, pageSize = 100, cursor = '*' }) {
  if (!/^S\d+$/.test(journal.openalex_source_id)) throw new SourceError('INVALID_JOURNAL', '无效 OpenAlex source ID');
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('filter', `primary_location.source.id:${journal.openalex_source_id},from_publication_date:${fromDate},to_publication_date:${toDate}`);
  url.searchParams.set('per_page', String(pageSize));
  url.searchParams.set('cursor', cursor);
  return url;
}

export function fetchOpenAlexJournal(journal, options) {
  return fetchPages('openalex', journal, options, {
    url: buildOpenAlexUrl,
    normalize: normalizeOpenAlexWork,
    page(payload) {
      if (!Array.isArray(payload?.results) || !Number.isFinite(payload?.meta?.count)) {
        throw new SourceError('INVALID_RESPONSE', 'OpenAlex 返回结构不完整');
      }
      const nextCursor = payload.meta.next_cursor;
      if (!Object.hasOwn(payload.meta, 'next_cursor')) {
        throw new SourceError('INVALID_RESPONSE', 'OpenAlex 缺少分页信息');
      }
      return { items: payload.results, nextCursor,
        done: nextCursor === null || (payload.results.length === 0 && payload.meta.count === 0) };
    }
  });
}
