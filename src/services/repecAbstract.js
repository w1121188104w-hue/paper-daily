import { load } from 'cheerio';
import { normalizeDoi, normalizeSourceRecord, normalizeTitleForMatch, normalizeAuthors, normalizeAuthorName, cleanAbstract } from './paperModel.js';
import { authenticAbstract } from './publisherParsers.js';
import { EvidenceError } from './evidenceHttp.js';
const titleKey = value => normalizeTitleForMatch(value).replace(/\s/g, '');
export function repecJournalUrl(doi, journal) {
  const normalized = normalizeDoi(doi);
  return journal.key === 'JPE' && /^10\.1086\/\d+$/.test(normalized)
    ? `https://ideas.repec.org/a/ucp/jpolec/doi${normalized.replace('/', '-')}.html` : null;
}
export function supportedRepecUrl(value, journal) {
  try {
    const url = new URL(value);
    return journal.key === 'JPE' && url.protocol === 'https:' && url.hostname === 'ideas.repec.org' &&
      !url.username && !url.password && !url.port && !url.search && !url.hash &&
      /^\/a\/ucp\/jpolec\/doi10\.1086-\d+\.html$/.test(url.pathname);
  } catch { return false; }
}
/** Narrow journal-article adapter. Working papers and arbitrary repositories are
 * deliberately excluded. RePEc is metadata evidence, not a fourth discovery API. */
export function parseRepecAbstract(response, journal, expected) {
  if (!supportedRepecUrl(response.url, journal)) throw new EvidenceError('UNSAFE_URL');
  const $ = load(response.body), meta = name => $('meta').filter((i, e) => $(e).attr('name') === name).map((i, e) => $(e).attr('content')).get();
  const single = name => { const values = [...new Set(meta(name))]; if (values.length !== 1) throw new EvidenceError('UNVERIFIED_IDENTITY'); return values[0]; };
  const handle = single('handle'), title = single('citation_title');
  const doi = normalizeDoi(handle.replace(/^RePEc:ucp:jpolec:doi:/, ''));
  if (!/^RePEc:ucp:jpolec:doi:10\.1086\/\d+$/.test(handle) || doi !== normalizeDoi(expected.doi) ||
    titleKey(title) !== titleKey(expected.title_original || expected.title) ||
    titleKey(single('citation_journal_title')) !== titleKey(journal.name) || single('citation_type') !== 'redif-article' ||
    single('citation_publisher') !== 'University of Chicago Press' ||
    new URL(response.url).pathname !== `/a/ucp/jpolec/doi${doi.replace('/', '-')}.html`) throw new EvidenceError('UNVERIFIED_IDENTITY');
  const authors = normalizeAuthors(single('citation_authors').split(';'));
  if (!authors.length || (expected.authors?.length && !authors.some(a => expected.authors.some(b => normalizeAuthorName(a.name) === normalizeAuthorName(b.name))))) throw new EvidenceError('UNVERIFIED_IDENTITY');
  const nodes = $('#abstract-body');
  const abstract = nodes.length === 1 ? authenticAbstract(nodes.text()) : '';
  if (!abstract || abstract !== cleanAbstract(single('citation_abstract'))) throw new EvidenceError('PUBLISHER_NO_ABSTRACT');
  return normalizeSourceRecord({ source: 'repec', source_id: handle, doi, title, authors, abstract, raw_abstract: nodes.text(),
    journal_key: journal.key, journal_name: journal.name, journal_category: journal.category, journal_category_zh: journal.category_zh,
    print_issn: journal.print_issn, electronic_issn: journal.electronic_issn, type: 'journal-article', url: response.url,
    last_checked_at: response.fetched_at, source_evidence: { url: response.url, scope_url: response.url,
      fetched_at: response.fetched_at, body_sha256: response.sha256, method: 'repec_journal_abstract' } });
}
