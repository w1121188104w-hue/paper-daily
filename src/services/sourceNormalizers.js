import {
  cleanText,
  normalizePartialDate,
  normalizeDoi,
  normalizeSourceRecord
} from './paperModel.js';

function sourceId(value) {
  return String(value || '').replace(/^https:\/\/openalex\.org\//i, '').trim();
}

function dateFromParts(value) {
  const parts = Array.isArray(value?.['date-parts']?.[0]) ? value['date-parts'][0] : [];
  if (!parts.length) return '';
  return normalizePartialDate(parts.slice(0, 3).map((part, i) => String(part).padStart(i ? 2 : 4, '0')).join('-'));
}

function journalFields(journal) {
  return {
    journal_key: journal.key,
    journal_name: journal.name,
    journal_category: journal.category,
    journal_category_zh: journal.category_zh,
    print_issn: journal.print_issn,
    electronic_issn: journal.electronic_issn
  };
}

export function abstractFromInvertedIndex(index) {
  if (!index || typeof index !== 'object') return '';
  const positioned = new Map();
  for (const [token, positions] of Object.entries(index)) {
    for (const position of Array.isArray(positions) ? positions : []) {
      if (!Number.isInteger(position) || position < 0 || position > 100000) {
        throw new Error('OpenAlex 摘要位置无效');
      }
      positioned.set(position, token);
    }
  }
  return Array.from(positioned).sort(([a], [b]) => a - b).map(([, token]) => token).join(' ');
}

export function normalizeOpenAlexWork(work, journal, checkedAt = new Date().toISOString()) {
  const configuredSourceId = sourceId(journal?.openalex_source_id);
  const actualSource = work?.primary_location?.source || {};
  const actualSourceId = sourceId(actualSource?.id);
  const issns = [journal.print_issn, journal.electronic_issn];
  if (!actualSourceId || actualSourceId !== configuredSourceId ||
      (actualSource.issn?.length && !actualSource.issn.some((issn) => issns.includes(issn)))) {
    throw new Error(
      `OpenAlex 期刊不匹配：期望 ${configuredSourceId}，实际 ${actualSourceId}`
    );
  }

  return normalizeSourceRecord({
    source: 'openalex',
    source_id: sourceId(work?.id),
    doi: normalizeDoi(work?.doi || work?.ids?.doi),
    title: work?.title || work?.display_name,
    abstract: abstractFromInvertedIndex(work?.abstract_inverted_index),
    authors: (Array.isArray(work?.authorships) ? work.authorships : []).map((authorship) => ({
      name: authorship?.author?.display_name || authorship?.raw_author_name,
      orcid: authorship?.author?.orcid
    })),
    ...journalFields(journal),
    published_online_date: '',
    published_print_date: '',
    publication_date: work?.publication_date,
    raw_dates: { publication_date: work?.publication_date || '', publication_year: work?.publication_year || null },
    source_created_at: work?.created_date,
    source_updated_at: work?.updated_date,
    last_checked_at: checkedAt,
    url: work?.primary_location?.landing_page_url || work?.doi || work?.id,
    volume: work?.biblio?.volume,
    issue: work?.biblio?.issue,
    pages: [work?.biblio?.first_page, work?.biblio?.last_page].filter(Boolean).join('-'),
    type: work?.type
  });
}

export function normalizeCrossrefWork(item, journal, checkedAt = new Date().toISOString()) {
  const itemIssns = new Set(
    (Array.isArray(item?.ISSN) ? item.ISSN : []).map((value) => String(value).toUpperCase())
  );
  const configuredIssns = [journal?.print_issn, journal?.electronic_issn]
    .filter(Boolean)
    .map((value) => String(value).toUpperCase());
  if (!configuredIssns.some((issn) => itemIssns.has(issn))) {
    throw new Error(
      `Crossref 期刊不匹配：期望 ${configuredIssns.join('/')}，实际 ${Array.from(itemIssns).join('/')}`
    );
  }

  const authors = (Array.isArray(item?.author) ? item.author : []).map((author) => ({
    name: [author?.given, author?.family].filter(Boolean).join(' ') || author?.name,
    orcid: author?.ORCID
  }));
  const onlineDate = dateFromParts(item?.['published-online']);
  const printDate = dateFromParts(item?.['published-print']);

  return normalizeSourceRecord({
    source: 'crossref',
    source_id: normalizeDoi(item?.DOI) || String(item?.URL || '').trim(),
    doi: item?.DOI,
    title: Array.isArray(item?.title) ? item.title[0] : item?.title,
    abstract: item?.abstract,
    authors,
    ...journalFields(journal),
    published_online_date: onlineDate,
    published_print_date: printDate,
    publication_date: dateFromParts(item?.published) || dateFromParts(item?.issued),
    raw_dates: Object.fromEntries(['published-online', 'published-print', 'published', 'issued']
      .filter((key) => item?.[key]).map((key) => [key, item[key]])),
    source_created_at: item?.created?.['date-time'],
    source_updated_at: item?.indexed?.['date-time'],
    last_checked_at: checkedAt,
    url: item?.URL || (item?.DOI ? `https://doi.org/${normalizeDoi(item.DOI)}` : ''),
    volume: item?.volume,
    issue: item?.issue,
    pages: item?.page,
    type: item?.type
  });
}
