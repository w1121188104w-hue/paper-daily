import { load } from 'cheerio';
import { cleanText, cleanAbstract, normalizeDoi, normalizePartialDate, normalizeTitleForMatch,
  normalizeAuthors, normalizeSourceRecord } from './paperModel.js';
import { EvidenceError } from './evidenceHttp.js';
import { canonicalPublisherUrl, publisherFor } from './publisherCatalog.js';

const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const compact = value => normalizeTitleForMatch(value).replace(/\s/g, '').replace(/^the/, '');
export function publicationDate(value) {
  const text = cleanText(value).trim();
  const iso = text.match(/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/);
  if (iso) return normalizePartialDate([iso[1], iso[2].padStart(2,'0'), ...(iso[3] ? [iso[3].padStart(2,'0')] : [])].join('-'));
  const us = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (us) return publicationDate(`${us[2]} ${us[1]} ${us[3]}`);
  const named = text.match(/(?:^|\s)(?:(\d{1,2})\s+)?([A-Za-z]+)\s+(\d{4})(?:\s|$)/);
  if (named) {
    const month = months.findIndex(m => m.startsWith(named[2].toLowerCase()));
    if (month >= 0) return normalizePartialDate(`${named[3]}-${String(month+1).padStart(2,'0')}${named[1] ? '-'+named[1].padStart(2,'0') : ''}`);
  }
  return /^\d{4}$/.test(text) ? normalizePartialDate(text) : '';
}
export function dateBounds(value) {
  const date = normalizePartialDate(value); if (!date) return null;
  if (date.length === 10) return [date, date];
  if (date.length === 4) return [`${date}-01-01`, `${date}-12-31`];
  const next = new Date(`${date}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth()+1); next.setUTCDate(0);
  return [`${date}-01`, next.toISOString().slice(0,10)];
}
export function windowMembership(value, fromDate, toDate) {
  const bounds = dateBounds(value); if (!bounds) return 'unknown_date';
  if (bounds[1] < fromDate || bounds[0] > toDate) return 'outside';
  return bounds[0] >= fromDate && bounds[1] <= toDate ? 'inside' : 'boundary_date_uncertain';
}
export function doiFromPublisherUrl(value) {
  try {
    const u = new URL(value); let raw = '';
    if (['doi.org','dx.doi.org'].includes(u.hostname)) raw = u.pathname.slice(1);
    else if (u.searchParams.get('id')?.startsWith('10.')) raw = u.searchParams.get('id');
    else if (u.hostname === 'academic.oup.com') raw = u.pathname.match(/\/doi\/(10\.\d+\/[^/]+\/[^/]+)/)?.[1] || '';
    else raw = u.pathname.match(/\/(?:doi\/(?:abs\/|full\/|pdf\/|epdf\/)?|article\/)(10\.\d+\/.+)/)?.[1] || '';
    return normalizeDoi(decodeURIComponent(raw));
  } catch { return ''; }
}
export function authenticAbstract(value) {
  const text = cleanAbstract(value);
  if (text.length < 60 || text.length > 20000 || !/[A-Za-z]{3}/.test(text) ||
    /(?:abstract (?:is )?(?:not available|unavailable)|no abstract|access denied|enable javascript|verify (?:that )?you are human|purchase (?:this |the )?article)/i.test(text) ||
    /(?:\.{3}|…)\s*$/.test(text)) return '';
  return text;
}
function journalFields(journal) {
  return { journal_key: journal.key, journal_name: journal.name, journal_category: journal.category,
    journal_category_zh: journal.category_zh, print_issn: journal.print_issn, electronic_issn: journal.electronic_issn };
}
function evidence(response, method, scopeUrl) {
  return { url: response.url, fetched_at: response.fetched_at, body_sha256: response.sha256,
    method, scope_url: scopeUrl || response.url };
}
export function publisherRecord(lead, journal) {
  return normalizeSourceRecord({ source: 'publisher', source_id: canonicalPublisherUrl(lead.url),
    ...journalFields(journal), doi: lead.doi, title: lead.title, authors: lead.authors,
    abstract: lead.abstract || '', raw_abstract: lead.raw_abstract || lead.abstract || '',
    publication_date: lead.date, raw_dates: { publisher_date: lead.raw_date || lead.date, date_role: lead.date_role || 'publisher_publication' },
    url: canonicalPublisherUrl(lead.url), last_checked_at: lead.evidence.fetched_at,
    type: lead.type || 'journal-article', source_evidence: lead.evidence });
}

export function parsePublisherFeed(response, journal) {
  if (/<!DOCTYPE|<!ENTITY/i.test(response.body)) throw new EvidenceError('UNSAFE_XML');
  const $ = load(response.body, { xml: true });
  if (!$('rss, feed, RDF, rdf\\:RDF').length) throw new EvidenceError('INVALID_FEED');
  const channel = $('channel, feed').first(), channelTitle = channel.children('title').first().text();
  if (!compact(channelTitle).includes(compact(journal.name))) throw new EvidenceError('JOURNAL_MISMATCH');
  const rows = [], rejected = [];
  $('item, entry').each((index, node) => {
    const item = $(node), field = name => item.children().filter((i,n) => n.name === name).first().text().trim();
    const title = cleanText(field('title'));
    const itemJournal = field('prism:publicationName');
    if (itemJournal && compact(itemJournal) !== compact(journal.name)) { rejected.push({ index, code: 'JOURNAL_MISMATCH' }); return; }
    let url;
    try { url = canonicalPublisherUrl(field('link') || item.children('link').attr('href') || field('guid'), response.url); }
    catch { rejected.push({ index, code: 'MISSING_ARTICLE_URL' }); return; }
    if (!publisherFor(journal).hosts.includes(new URL(url).hostname)) { rejected.push({ index, code: 'FOREIGN_ARTICLE_URL' }); return; }
    const doiValues = [field('prism:doi'), field('dc:identifier'), field('guid'), doiFromPublisherUrl(url)]
      .map(normalizeDoi).filter(d => /^10\.\d{4,9}\/\S+$/.test(d));
    if (new Set(doiValues).size > 1) { rejected.push({ index, code: 'DOI_CONFLICT' }); return; }
    const description = field('description'), rich = field('content:encoded');
    const plainDescription = cleanText(description);
    const rawDate = field('prism:publicationDate') || field('dc:date') || field('pubDate') ||
      plainDescription.match(/Publication date:\s*(.*?)(?=Source:|Author\(s\):|$)/i)?.[1]?.trim() || '';
    // Generic feed descriptions are frequently TOC labels or marketing. Only explicit abstract fields/headings count.
    let rawAbstract = /^(?:<[^>]*>|\s)*abstract\b/i.test(field('dc:description')) ? field('dc:description') : '';
    if (!rawAbstract && /^(?:<[^>]*>|\s)*abstract\b/i.test(rich)) rawAbstract = rich;
    if (!rawAbstract && /(?:>\s*Abstract\s*<|^\s*Abstract\b)/i.test(description)) rawAbstract = description;
    const creators = item.children().filter((i,n) => ['dc:creator','author'].includes(n.name)).map((i,n) => $(n).text()).get();
    if (!creators.length) {
      const authorText = plainDescription.match(/Author\(s\):\s*(.*)$/i)?.[1]; if (authorText) creators.push(authorText);
    }
    const authors = normalizeAuthors(creators.flatMap(text => text.split(/,\s*(?:\n\s*)?|\s+and\s+/).filter(Boolean)));
    if (!title) { rejected.push({ index, code: 'MISSING_TITLE' }); return; }
    rows.push({ title, doi: doiValues[0] || '', url, authors, date: publicationDate(rawDate), raw_date: rawDate,
      // Wiley and other TOC feeds re-date older online-first papers when assigned to an issue.
      // Never treat RSS/DC timestamps as first publication dates without independent date evidence.
      date_role: publisherFor(journal).family === 'elsevier' ? 'issue_cover_date' : 'feed_update_date', abstract: authenticAbstract(rawAbstract), raw_abstract: rawAbstract,
      type: /correction|erratum|retraction|editorial|book.review/i.test(field('category')) ? field('category').toLowerCase().replace('book review','book-review') : 'journal-article',
      evidence: evidence(response, 'publisher_rss', response.url) });
  });
  return { rows, rejected, channel_title: channelTitle, complete: false, coverage_reason: 'FEED_IS_NOT_FULL_ARCHIVE' };
}

export function parsePublisherArticle(response, journal, expected = {}) {
  const $ = load(response.body), meta = name => $('meta').filter((i,n) =>
    String($(n).attr('name') || $(n).attr('property') || '').toLowerCase() === name.toLowerCase()).map((i,n) => $(n).attr('content')).get();
  const entities = [];
  const walk = value => { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') {
    if ([value['@type']].flat().some(t => ['ScholarlyArticle','Article'].includes(t))) entities.push(value);
    if (value['@graph']) walk(value['@graph']);
  } };
  $('script[type="application/ld+json"]').each((i,n) => { try { walk(JSON.parse($(n).text())); } catch { /* not an article object */ } });
  const doiOf = entity => normalizeDoi(typeof entity?.identifier === 'string' ? entity.identifier :
    [entity?.identifier].flat().find(i => /doi/i.test(i?.propertyID || ''))?.value || doiFromPublisherUrl(entity?.url || entity?.['@id'] || ''));
  const suitable = entities.filter(e => expected.doi ? doiOf(e) === normalizeDoi(expected.doi) : true);
  const jsonArticle = suitable.length === 1 ? suitable[0] : null;
  const doiValues = [...meta('citation_doi'), ...meta('dc.identifier').filter(v => /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?10\./i.test(v)), doiOf(jsonArticle)].map(normalizeDoi).filter(Boolean);
  if (new Set(doiValues).size > 1) throw new EvidenceError('DOI_CONFLICT');
  const doi = doiValues[0] || '', title = cleanText(meta('citation_title')[0] || jsonArticle?.headline || jsonArticle?.name || $('h1').first().text());
  const journalName = meta('citation_journal_title')[0] || meta('prism.publicationname')[0] || jsonArticle?.isPartOf?.name || '';
  const issns = meta('citation_issn'), journalConfirmed = compact(journalName) === compact(journal.name) || issns.some(i => [journal.print_issn,journal.electronic_issn].includes(i));
  if (journalName && compact(journalName) !== compact(journal.name) && !issns.some(i => [journal.print_issn,journal.electronic_issn].includes(i))) throw new EvidenceError('JOURNAL_MISMATCH');
  if (expected.doi && doi && doi !== normalizeDoi(expected.doi)) throw new EvidenceError('DOI_CONFLICT');
  if (expected.title && title && compact(expected.title) !== compact(title)) throw new EvidenceError('TITLE_MISMATCH');
  // No abstract adoption based only on landing URL or a related-article title.
  if (!(expected.doi && doi === normalizeDoi(expected.doi)) && !journalConfirmed) throw new EvidenceError('UNVERIFIED_IDENTITY');
  if (!doi && !expected.title) throw new EvidenceError('UNVERIFIED_IDENTITY');
  const authors = normalizeAuthors(meta('citation_author').length ? meta('citation_author') :
    [jsonArticle?.author].flat().filter(Boolean).map(a => typeof a === 'string' ? a : a.name));
  const rawDate = meta('citation_online_date')[0] || meta('citation_publication_date')[0] || meta('dc.date')[0] || jsonArticle?.datePublished || '';
  const date = publicationDate(rawDate);
  if (!doi && (!expected.title || !authors.length || !date || !expected.authors?.some(a => authors.some(b => compact(a.name || a) === compact(b.name))) ||
    !expected.date || date.slice(0,4) !== expected.date.slice(0,4))) throw new EvidenceError('UNVERIFIED_IDENTITY');
  let rawAbstract = meta('citation_abstract')[0] || jsonArticle?.abstract || '', method = rawAbstract ? 'article_metadata_abstract' : '';
  for (const selector of ['#abstract', '.article-abstract', '.article-information .abstract', '.abstractInFull', '[role="doc-abstract"]', 'section.abstract', 'div.abstract']) {
    if (authenticAbstract(rawAbstract)) break;
    const nodes = $(selector); if (nodes.length !== 1) continue;
    const node = nodes.clone(); node.find('script,style,nav,.related-articles,.recommendations').remove();
    node.find('h2,h3,h4,.title,.boxTitle').each((i,n) => { if (/^abstract\s*$/i.test($(n).text().trim())) $(n).remove(); });
    rawAbstract = node.text().trim(); method = 'article_dom_abstract';
  }
  return { title, doi, authors, date, raw_date: rawDate, abstract: authenticAbstract(rawAbstract), raw_abstract: rawAbstract,
    url: canonicalPublisherUrl(response.url), type: meta('citation_article_type')[0] || 'journal-article',
    evidence: evidence(response, method || 'article_without_abstract', expected.scope_url), journal_confirmed: journalConfirmed };
}

export function discoverPublisherLinks(response, journal) {
  const $ = load(response.body), publisher = publisherFor(journal), feeds = [], articles = [], next = [];
  const allowed = value => { try { const url = new URL(value,response.url); return url.protocol === 'https:' && publisher.hosts.includes(url.hostname) ? url.href : null; } catch { return null; } };
  $('link[rel="alternate"], a[href]').each((i,n) => {
    const element = $(n), url = allowed(element.attr('href')); if (!url) return;
    if (/rss|atom|\.xml(?:\?|$)|\/feed\//i.test(url+' '+(element.attr('type')||''))) feeds.push(url);
    else if (doiFromPublisherUrl(url) || /\/article(?:s)?\/|\/science\/article\/pii\//.test(new URL(url).pathname)) articles.push(url);
    if (/\bnext\b/i.test(element.attr('rel') || '') || /^(?:next|next page|下一页|›|»)$/i.test(element.text().trim())) next.push(url);
  });
  return { feeds: [...new Set(feeds)], articles: [...new Set(articles)], next: [...new Set(next)] };
}

export function aeaIssueLinks(response, fromDate, toDate) {
  const $ = load(response.body), links = [];
  $('a[href]').each((i,n) => {
    const href = $(n).attr('href'), date = publicationDate($(n).text().replace(/\s*\(.*$/, ''));
    if (/^\/issues\/\d+$/.test(href) && date && windowMembership(date,fromDate,toDate) !== 'outside') links.push({ url:new URL(href,response.url).href,date });
  });
  return links;
}
