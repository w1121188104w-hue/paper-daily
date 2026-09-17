import {
  cleanText,
  normalizePartialDate,
  normalizeDoi,
  crossrefNoticeFromWork,
  crossrefNoticeType,
  normalizeSourceRecord
} from './paperModel.js';
import { matchesJournalIssn, knownJournalMismatch } from './journalIdentity.js';

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
  if (index == null) return '';
  const invalid = () => { throw Object.assign(new Error('OpenAlex 摘要位置或结构无效'), { code: 'INVALID_ABSTRACT_INDEX' }); };
  if (typeof index !== 'object' || Array.isArray(index)) invalid();
  const positioned = new Map();
  for (const [token, positions] of Object.entries(index)) {
    if (!token.trim() || !Array.isArray(positions) || !positions.length) invalid();
    for (const position of positions) {
      if (!Number.isInteger(position) || position < 0 || position >= 20000 || positioned.has(position)) invalid();
      positioned.set(position, token);
    }
  }
  // Every original position must occur exactly once, starting at zero. A gap is
  // not permission to concatenate the remaining words into a different abstract.
  if (positioned.size && (Math.min(...positioned.keys()) !== 0 || Math.max(...positioned.keys()) !== positioned.size - 1)) invalid();
  return Array.from(positioned).sort(([a], [b]) => a - b).map(([, token]) => token).join(' ');
}

export function normalizeOpenAlexWork(work, journal, checkedAt = new Date().toISOString(), { onWarning = () => {} } = {}) {
  const configuredSourceId = sourceId(journal?.openalex_source_id);
  const actualSource = work?.primary_location?.source || {};
  const actualSourceId = sourceId(actualSource?.id);
  if (knownJournalMismatch({ journal_key: journal.key, doi: normalizeDoi(work?.doi || work?.ids?.doi) }) ||
      !actualSourceId || actualSourceId !== configuredSourceId ||
      (actualSource.issn?.length && !matchesJournalIssn(actualSource.issn, journal))) {
    throw new Error(
      `OpenAlex 期刊不匹配：期望 ${configuredSourceId}，实际 ${actualSourceId}`
    );
  }

  let abstract = '';
  try { abstract = abstractFromInvertedIndex(work?.abstract_inverted_index); }
  catch (error) {
    if (error.code !== 'INVALID_ABSTRACT_INDEX') throw error;
    // An unusable optional abstract must not discard an otherwise valid paper.
    onWarning(error.code);
  }
  return normalizeSourceRecord({
    source: 'openalex',
    source_id: sourceId(work?.id),
    doi: normalizeDoi(work?.doi || work?.ids?.doi),
    title: work?.title || work?.display_name,
    abstract,
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
  if (knownJournalMismatch({ journal_key: journal.key, doi: normalizeDoi(item?.DOI) }) || !matchesJournalIssn([...itemIssns], journal)) {
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
  const notice = crossrefNoticeFromWork(item);

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
    type: notice ? crossrefNoticeType(notice) : item?.type,
    ...(notice ? { crossref_notice: notice } : {})
  });
}
