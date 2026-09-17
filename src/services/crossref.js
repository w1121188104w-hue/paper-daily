import { fetchPages } from './sourceClient.js';
import { SourceError, requestSourceJson } from './sourceHttp.js';
import { isValidIssn } from './journals.js';
import { normalizeCrossrefWork } from './sourceNormalizers.js';
import { carTitlePrefix } from './carEnglish.js';

export function buildCrossrefUrl(journal, { fromDate, toDate, pageSize = 100, cursor = '*' }) {
  if (!isValidIssn(journal.crossref_route_issn)) throw new SourceError('INVALID_JOURNAL', '无效 Crossref ISSN');
  const url = new URL(`https://api.crossref.org/journals/${journal.crossref_route_issn}/works`);
  url.searchParams.set('filter', `from-pub-date:${fromDate},until-pub-date:${toDate},type:journal-article`);
  url.searchParams.set('rows', String(pageSize));
  url.searchParams.set('cursor', cursor);
  return url;
}

export async function fetchCrossrefJournal(journal, options) {
  const result = await fetchPages('crossref', journal, options, {
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
  // Repair known CAR identities only; this is not an expansion of discovery's
  // rolling window. DOI and actual ISSN must both agree before accepting a title.
  const clock = options.now || Date.now, deadline = clock() + 120000;
  const markIncomplete = () => {
    result.ok = false;
    result.error ||= { code: 'CAR_TITLE_LOOKUP_FAILED', message: 'CAR英文标题核实暂未完成，将保留原文重试' };
  };
  for (const paper of (journal.key === 'CAR' ? options.carBilingualPapers || [] : []).slice(0, 50)) {
    const remaining = deadline - clock();
    if (remaining <= 0) { markIncomplete(); break; }
    if (result.records.some(r => r.doi === paper.doi && carTitlePrefix(paper.title_original, r.title))) continue;
    try {
      const payload = await requestSourceJson(new URL(`https://api.crossref.org/works/${encodeURIComponent(paper.doi)}`),
        { ...options, maxAttempts: 1, timeoutMs: Math.min(8000, remaining) });
      const index = result.raw_count++;
      result.raw_pages.push({ purpose: 'car_existing_bilingual_title', doi: paper.doi, response: payload });
      const record = normalizeCrossrefWork(payload?.message, journal, options.checkedAt);
      if (record.doi !== paper.doi || !carTitlePrefix(paper.title_original, record.title)) {
        result.rejected.push({ index, code: 'CAR_TITLE_UNVERIFIED', message: 'CAR英文标题边界尚未得到DOI与ISSN共同核实' });
        result.ok = false;
        result.error ||= { code: 'CAR_TITLE_UNVERIFIED', message: 'CAR标题核实返回不一致，保留原文重试' };
        continue;
      }
      result.records.push(record);
    } catch (error) {
      // One missing DOI or timeout must not starve the remaining known papers.
      // Respect host-level rate/access limits and retain the original text.
      markIncomplete();
      if (error.code === 'RETRY_LATER' || [401, 403, 429].includes(error.http_status)) break;
    }
  }
  return result;
}
