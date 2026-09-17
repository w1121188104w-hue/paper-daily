import { load } from 'cheerio';
import { normalizeTitleForMatch } from './paperModel.js';
import { EvidenceError } from './evidenceHttp.js';
import { supportedRepecUrl } from './repecAbstract.js';

// Verified journal-series mappings, not independent discovery sources. Only
// locate already-known papers; the article adapter must still verify its DOI.
const series = Object.freeze({ JFE: 'jfinec', RP: 'respol', JAE: 'jaecon', JCF: 'corfin', AOS: 'aosoci' });
const titleKey = value => normalizeTitleForMatch(value).replace(/\s/g, '');
export const repecCatalogUrl = journal => series[journal.key]
  ? `https://ideas.repec.org/s/eee/${series[journal.key]}.html` : null;

export function parseRepecCatalog(response, journal) {
  const url = repecCatalogUrl(journal);
  if (!url || response.url !== url) throw new EvidenceError('UNVERIFIED_IDENTITY');
  const $ = load(response.body);
  const issns = $('b').toArray().filter(e => /^ISSN\s*:$/.test($(e).text().trim()))
    .map(e => e.next?.type === 'text' ? e.next.data.trim().toUpperCase() : '')
    .filter(value => /^\d{4}-\d{3}[\dX]$/.test(value));
  if (!$('h1').toArray().some(e => titleKey($(e).text()) === titleKey(journal.name)) ||
    issns.length !== 1 || ![journal.print_issn, journal.electronic_issn].includes(issns[0])) {
    throw new EvidenceError('UNVERIFIED_IDENTITY');
  }
  const found = new Map();
  for (const e of $('li.list-group-item a[href]').toArray().slice(0, 1000)) {
    let link; try { link = new URL($(e).attr('href'), url).href; } catch { continue; }
    if (!supportedRepecUrl(link, journal) || !new URL(link).pathname.startsWith(`/a/eee/${series[journal.key]}/`)) continue;
    const title = $(e).text().trim();
    if (titleKey(title).length >= 8 && !found.has(link)) found.set(link, { title, url: link });
  }
  return [...found.values()];
}

export function repecCatalogCandidates(rows, paper) {
  if (!paper.doi) return [];
  const title = titleKey(paper.title_original || paper.title || '');
  return rows.filter(row => titleKey(row.title) === title).slice(0, 3);
}

// A bounded ordering hint, never an acceptance decision. The normal per-paper
// three-source lookups and strict article verification remain unchanged.
export async function prioritizeRepecCatalogPapers(papers, { sources, journalFor, shouldContinue = () => true }) {
  if (typeof sources.repecCatalogHasMatch !== 'function') return [...papers];
  const matches = new Set();
  for (const paper of papers) {
    if (!shouldContinue()) break;
    const journal = journalFor(paper.journal_key);
    if (!paper.doi || !repecCatalogUrl(journal)) continue;
    try { if (await sources.repecCatalogHasMatch(paper, journal)) matches.add(paper.id); }
    catch (error) { if (error.code === 'EVIDENCE_STORAGE_ERROR') throw error; }
  }
  return [...papers.filter(p => matches.has(p.id)), ...papers.filter(p => !matches.has(p.id))];
}
