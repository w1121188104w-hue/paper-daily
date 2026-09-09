import { createHash } from 'node:crypto';

export const PAPER_SOURCES = Object.freeze(['openalex', 'crossref']);

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  ndash: '–', mdash: '—', copy: '©', times: '×', le: '≤', ge: '≥'
});

export function decodeEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (Object.hasOwn(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key];
    if (key.startsWith('#x')) {
      const codePoint = Number.parseInt(key.slice(2), 16);
      return codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    if (key.startsWith('#')) {
      const codePoint = Number.parseInt(key.slice(1), 10);
      return codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}

export function cleanText(value) {
  return decodeEntities(String(value || ''))
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/?(?:[\w-]+:)?(?:p|title|sec|br|div)\b[^>]*>/gi, ' ')
      .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanAbstract(value) {
  return cleanText(value)
    .replace(/^abstract\s*[:.]?\s+/i, '')
    .replace(/\s*(?:©|Copyright\s*(?:©|\(c\))?)\s*\d{4}[\s\S]*?all rights reserved\.?\s*$/i, '')
    .trim();
}

export function normalizeDoi(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/\s+/g, '');
}

export function doiUrl(value) {
  const doi = normalizeDoi(value);
  return doi ? `https://doi.org/${doi}` : '';
}

export function normalizeTitleForMatch(value) {
  return cleanText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeAuthorName(value) {
  return cleanText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeOrcid(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/orcid\.org\//i, '')
    .toUpperCase();
}

export function normalizeAuthors(items) {
  const list = Array.isArray(items) ? items : [];
  const seen = new Set();
  const authors = [];
  for (const item of list) {
    const source = typeof item === 'string' ? { name: item } : item || {};
    const name = cleanText(source.name || source.display_name || source.raw_author_name);
    const orcid = normalizeOrcid(source.orcid);
    if (!name) continue;
    const identity = orcid || normalizeAuthorName(name);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    authors.push({ name, orcid });
  }
  return authors;
}

export function normalizeDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '';
  const [, year, month, day] = match;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    return '';
  }
  return `${year}-${month}-${day}`;
}

export function yearFromRecord(record) {
  for (const value of [record?.published_online_date, record?.published_print_date, record?.publication_date]) {
    const date = normalizePartialDate(value);
    if (date) return date.slice(0, 4);
  }
  return '';
}

export function buildFallbackFingerprint(record) {
  const title = normalizeTitleForMatch(record?.title);
  const firstAuthor = normalizeAuthorName(record?.authors?.[0]?.name || record?.authors?.[0]);
  const year = yearFromRecord(record);
  if (!title || !firstAuthor || !year) return '';
  return `${record.journal_key}|${title}|${firstAuthor}|${year}`;
}

// Missing date components stay missing; publication dates are not discovery dates.
export function normalizePartialDate(value) {
  const text = String(value || '');
  if (/^\d{4}$/.test(text) && Number(text) > 0) return text;
  if (/^\d{4}-\d{2}$/.test(text) && normalizeDate(`${text}-01`)) return text;
  return normalizeDate(text);
}

export function hashText(value) {
  const normalized = cleanText(value);
  return normalized ? createHash('sha256').update(normalized).digest('hex') : '';
}

export function buildSourceTextHash(title, abstract) {
  return {
    title: hashText(title),
    abstract: hashText(abstract)
  };
}

export function normalizeSourceRecord(input) {
  const source = String(input?.source || '').trim().toLowerCase();
  if (!PAPER_SOURCES.includes(source)) {
    throw new Error(`未知论文来源：${source || '(empty)'}`);
  }
  const journalKey = String(input?.journal_key || '').trim().toUpperCase();
  const journalName = cleanText(input?.journal_name);
  if (!journalKey || !journalName) {
    throw new Error('来源记录缺少已核验的期刊 key 或期刊全名');
  }

  const title = cleanText(input?.title);
  if (!title) throw new Error(`${source} 来源记录缺少标题`);
  if (!String(input?.source_id || '').trim()) throw new Error('来源记录缺少稳定 source_id');
  const doi = normalizeDoi(input?.doi);
  if (doi && !/^10\.\d{4,9}\/\S+$/.test(doi)) throw new Error('来源记录的 DOI 格式无效');

  return {
    source,
    source_id: String(input?.source_id || '').trim(),
    doi,
    title,
    abstract: cleanAbstract(input?.abstract),
    raw_title: String(input?.raw_title ?? input?.title ?? ''),
    raw_abstract: String(input?.raw_abstract ?? input?.abstract ?? ''),
    raw_dates: structuredClone(input?.raw_dates || {}),
    authors: normalizeAuthors(input?.authors),
    journal_key: journalKey,
    journal_name: journalName,
    journal_category: String(input?.journal_category || '').trim(),
    journal_category_zh: String(input?.journal_category_zh || '').trim(),
    print_issn: String(input?.print_issn || '').trim().toUpperCase(),
    electronic_issn: String(input?.electronic_issn || '').trim().toUpperCase(),
    published_online_date: normalizePartialDate(input?.published_online_date),
    published_print_date: normalizePartialDate(input?.published_print_date),
    publication_date: normalizePartialDate(input?.publication_date),
    source_created_at: String(input?.source_created_at || '').trim(),
    source_updated_at: String(input?.source_updated_at || '').trim(),
    last_checked_at: String(input?.last_checked_at || '').trim(),
    url: String(input?.url || '').trim(),
    volume: cleanText(input?.volume),
    issue: cleanText(input?.issue),
    pages: cleanText(input?.pages),
    type: String(input?.type || '').trim()
  };
}

export function canonicalPaperId(record) {
  const doi = normalizeDoi(record?.doi);
  if (doi) return `doi:${doi}`;
  const fingerprint = buildFallbackFingerprint(record);
  if (fingerprint) {
    return `fp:${createHash('sha256').update(fingerprint).digest('hex').slice(0, 24)}`;
  }
  const source = String(record?.source || 'unknown').toLowerCase();
  const sourceId = String(record?.source_id || record?.title || '').trim();
  return `${source}:${createHash('sha256').update(sourceId).digest('hex').slice(0, 24)}`;
}
