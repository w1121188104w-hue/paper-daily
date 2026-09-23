// Isolated directory pilot. Never imports the production library or abstract state.
import { EXTRA_CATALOG_TASKS } from './catalog-registry.js';
import { resolveKnownCatalogAliases } from './catalog-resolutions.js';
import {catalogMembership,withTypedDates} from './catalog-scope.js';
import {catalogOtherSource} from './article-type.js';
import {disabledCatalogUrl} from './collection-policy.js';
const journals = {
  RP: { name: 'Research Policy', host: 'www.sciencedirect.com', prefix: '/journal/research-policy/', issns: ['0048-7333', '1873-7625'] },
  JAR: { name: 'Journal of Accounting Research', host: 'onlinelibrary.wiley.com', prefix: '/toc/1475679x/', issns: ['0021-8456', '1475-679X'] },
  JPE: { name: 'Journal of Political Economy', host: 'www.journals.uchicago.edu', prefix: '/toc/jpe/', issns: ['0022-3808', '1537-534X'] }
};
export const CATALOG_TASKS = [
  ['RP', '最新卷期', 'latest'], ['RP', 'Articles in Press', 'articles-in-press'],
  ['JAR', '最新卷期', 'current'], ['JAR', 'Early View', '0/0'],
  ['JPE', '最新卷期', 'current'], ['JPE', 'Ahead of Print', '0/0'], ['JPE', 'Just Accepted', '0/ja']
].map(([journal, label, tail], i) => ({ ...journals[journal], journal, label, id: `catalog-${i + 1}`,
  url: `https://${journals[journal].host}${journals[journal].prefix}${tail}`, collection: label === '最新卷期' ? 'issue' : 'online' })).concat(EXTRA_CATALOG_TASKS);
export const CATALOG_STATE = 'paper_catalog_trial_v1';
// Retain legacy IDs for saved pages and queue validation.
export const ACTIVE_CATALOG_TASKS=CATALOG_TASKS.filter(t=>!disabledCatalogUrl(t.url));
export const titleKey = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function cleanDoi(s) {
  try {
    const d = decodeURIComponent(String(s || '')).trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
    return /^10\.\d{4,9}\/[^\s?#]+$/i.test(d) ? d.toLowerCase() : null;
  } catch { return null; }
}
export function catalogUrl(value, task) {
  try {
    const u = new URL(value);
    const hosts = task.hosts || [task.host];
    const pathOK = task.catalog_pattern ? new RegExp(task.catalog_pattern).test(u.pathname) : u.pathname.startsWith(task.prefix);
    if (u.protocol !== 'https:' || !hosts.includes(u.hostname) || u.port || u.username || u.password || !pathOK) return null;
    // Only numeric pagination parameters are kept. Never persist session/query tokens.
    const original = new URL(u); u.search = ''; u.hash = '';
    for (const key of ['page', 'pageNumber', 'startPage', 'offset', 'pageSize', 'size']) {
      const v = original.searchParams.get(key);
      if (v !== null && /^\d{1,5}$/.test(v)) u.searchParams.set(key, v);
    }
    return u.href;
  } catch { return null; }
}
// A publisher can resolve /current to /year/volume/issue while its numbered
// pagination still uses /current. Accept only that alias, never another issue.
export function sameCatalogList(from, to, task) {
  const a = catalogUrl(from, task), b = catalogUrl(to, task);
  if (!a || !b) return false;
  const x = new URL(a), y = new URL(b);
  if (x.origin !== y.origin) return false;
  if (x.pathname === y.pathname) return true;
  if (x.hostname !== 'onlinelibrary.wiley.com') return false;
  const p = x.pathname.match(/^\/toc\/([^/]+)\/(current|\d{4}\/\d+\/\d+)\/?$/i);
  const q = y.pathname.match(/^\/toc\/([^/]+)\/(current|\d{4}\/\d+\/\d+)\/?$/i);
  return !!(p && q && p[1] === q[1] && (p[2] === 'current' || q[2] === 'current') &&
    ['page', 'pageNumber', 'startPage', 'offset'].some(k => y.searchParams.has(k)));
}
export function articleUrl(value, task) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if (u.hostname === 'doi.org' && cleanDoi(u.pathname.slice(1))) { u.search = ''; u.hash = ''; return u.href; }
    if (!(task.hosts || [task.host]).includes(u.hostname)) return null;
    if (task.family === 'aea' && u.pathname === '/articles') {
      const doi = cleanDoi(u.searchParams.get('id')); if (!doi || !doi.startsWith('10.1257/aer.')) return null;
      u.search = ''; u.hash = ''; u.searchParams.set('id', doi); return u.href;
    }
    const pattern = task.article_pattern || '^/(?:doi/|science/article/)';
    if (!new RegExp(pattern).test(u.pathname)) return null;
    u.search = ''; u.hash = ''; return u.href;
  } catch { return null; }
}
// Repair only fields explicitly present in this article's stored card. Raw pages
// remain unchanged, so old captures can be repaired without visiting sites again.
export function enrichCatalogItem(original) {
  const item = structuredClone(original), text = item.evidence?.text || '';
  const sources = { ...item.field_sources };
  const otherSource=catalogOtherSource(item);
  if(otherSource){item.type='other';sources.type=otherSource;}
  const fill = (field, value, quote = value) => {
    if (!item[field] && value && text.includes(quote)) {
      item[field] = value;
      sources[field] = { method: 'catalog_rule', quote, source_url: item.evidence.catalog_url };
    }
  };
  if (item.journal === 'RP') {
    // ScienceDirect flattens adjacent nodes without whitespace. Do not consume
    // "Research article" / "Erratum" as part of the DOI, or use a cited DOI.
    const m = text.match(/https:\/\/doi\.org\/(10\.1016\/j\.respol\.\d{4}\.\d+)(?=Research article|Review article|Short communication|Erratum|Corrigendum|Publisher['’]s note|\s|$)/);
    if (m) fill('doi', m[1].toLowerCase(), m[1]);
    const role = text.match(/https:\/\/doi\.org\/10\.1016\/j\.respol\.\d{4}\.\d+(Erratum|Corrigendum|Publisher['’]s note)(?=Free access|Open access|Abstract only|\s|$)/);
    if (role) { item.type = 'other'; sources.type = { method: 'catalog_label', quote: role[1], source_url: item.evidence.catalog_url }; }
  }
  if (/^(?:retracted|retraction|erratum|corrigendum)\b/i.test(item.title || '')) item.type = 'other';
  if (/^retracted\s*:/i.test(item.title || '')) item.retraction_status = 'retracted';
  if (/^retraction\s*:/i.test(item.title || '')) item.retraction_status = 'retraction_notice';
  // The first publication label belongs to this card; later labels may describe
  // an article linked inside a retraction notice. Never take an issue's date.
  const date = text.match(/(?:Version of Record online:|First Published(?: online)?:|Available online)\s*((?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2},?\s+)?(?:19|20)\d{2})/i);
  if (date) fill('date_raw', date[1]);
  const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const month = String(item.date_raw || '').match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2},?\s+)?((?:19|20)\d{2})\b/i);
  if (!item.publication_month && month && (String(item.date_raw).match(/\b(?:19|20)\d{2}\b/g) || []).length === 1) {
    item.publication_month = `${month[2]}-${String(monthNames.indexOf(month[1].toLowerCase()) + 1).padStart(2, '0')}`;
    sources.publication_month = { method: 'explicit_article_date', quote: item.date_raw, source_url: item.evidence?.catalog_url };
  }
  item.doi_status = item.doi ? 'present' : 'no_doi_yet'; item.field_sources = sources;
  return item;
}
export function assessCatalog(task, capture) {
  const source = catalogUrl(capture.url, task);
  const base = { task_id: task.id, journal: task.journal, label: task.label, source_url: source, items: [], completeness: 'not_established',
    // Keep bounded diagnostics even when identity fails. Never save whole-page
    // text, cookies, form values, or unrelated navigation as a workaround.
    identity_evidence: { headings: (capture.headings || []).slice(0, 15).map(s => String(s).slice(0, 300)),
      observed_issns: (capture.issns || []).slice(0, 15), raw_card_count: capture.raw_card_count || 0 },
    page_title: String(capture.page_title || '').slice(0, 500), warnings: capture.warnings || [] };
  if (!source) return { ...base, status: 'wrong_catalog' };
  if (capture.challenge) return { ...base, status: 'needs_user_verification' };
  if (capture.page_not_found) return { ...base, status: 'catalog_not_found' };
  const issns = (capture.issns || []).map(x => x.toUpperCase());
  const issnMatches = issns.some(x => task.issns.includes(x));
  if (issns.length && !issnMatches) return { ...base, status: 'journal_conflict', observed_issns: issns };
  const headingMatches = (capture.headings || []).some(h => titleKey(h).includes(titleKey(task.name.replace(/^The\s+/i,''))));
  // Wiley's official TOC path embeds the registered electronic ISSN. This is
  // stronger evidence than a generic "Early View" heading, but still requires
  // actual article cards (or an explicit empty-list notice), never a gate page.
  const pathIssn = new URL(source).hostname === 'onlinelibrary.wiley.com' ? new URL(source).pathname.match(/^\/toc\/([\dXx]{8})\//)?.[1]?.toUpperCase() : null;
  const pathIdentity = pathIssn && task.issns.some(i => i.replace('-', '') === pathIssn) &&
    ((capture.items || []).some(r => r.title && articleUrl(r.url, task)) || capture.empty_message);
  if (!issnMatches && !headingMatches && !pathIdentity) return { ...base, status: 'identity_unconfirmed' };
  const identity = { method: issnMatches ? 'official_catalog_path_and_issn' : headingMatches ? 'official_catalog_path_and_journal_heading' : 'official_wiley_toc_issn_and_content', observed_issns: issns };
  const landing = task.landing && new URL(source).pathname === new URL(task.url).pathname;
  if (landing) {
    const links = (capture.issue_links || []).map(x => ({...x, url: catalogUrl(x.url, task)})).filter(x => x.url && x.url !== source);
    const latest = task.family === 'springer' ? links.filter(x => /\/volumes-and-issues\/\d+-[\d-]+$/.test(new URL(x.url).pathname)).sort((a,b) => b.url.localeCompare(a.url, undefined, {numeric:true}))[0] : links.find(x => /^current issue$/i.test(x.label));
    return {...base, identity, status: latest ? 'catalog_landing' : 'latest_issue_link_missing', issue_target: latest?.url || null,
      issue_heading: capture.issue_heading, warnings: [], next_links: [], more_controls: [], completeness: 'not_established'};
  }
  const items = [], excluded = [];
  for (const row of capture.items || []) {
    const url = articleUrl(row.url, task), title = String(row.title || '').trim();
    if (!title || title.length > 1500 || !url) { excluded.push({ reason: 'missing_title_or_unsupported_link' }); continue; }
    const doi = cleanDoi(row.doi);
    const other = /^(?:covers? and front matter|front matter|back matter|issue information|editorial board|list of (?:editors|reviewers)|recent referees|jpe turnaround times|nobel (?:lecture|prize lecture)|corrigendum|erratum|retraction|publisher['’]s note)\b/i.test(title) || /^editorial policy(?: and style information)?$/i.test(title) ||
      /^(?:erratum|corrigendum|retraction|publisher['’]s note|editorial board)$/i.test(String(row.section || '').trim());
    items.push(enrichCatalogItem({ title, doi, journal: task.journal, journal_name: task.name, expected_issns: task.issns,
      url, authors_raw: row.authors_raw || null, date_raw: row.date_raw || null,
      publication_month: null, catalog_collection: task.collection, type: other ? 'other' : 'unclassified', doi_status: doi ? 'present' : 'no_doi_yet',
      evidence: { catalog_url: source, selector: row.selector, text: row.evidence_text, section: row.section || null, version: row.evidence_version || 1 } }));
  }
  const next = (capture.next_links || []).map(x => catalogUrl(x, task)).filter(Boolean).filter(x => x !== source);
  return { ...base, status: items.length ? 'catalog_candidates' : capture.empty_message ? 'catalog_empty' : 'no_entries_found', identity, items,
    page_title: capture.page_title, issue_heading: capture.issue_heading || null,
    adapter: capture.adapter, raw_card_count: capture.raw_card_count, excluded,
    observed_article_links: (capture.observed_article_links || []).map(u=>articleUrl(u,task)).filter(Boolean),
    unmatched_article_links: (capture.unmatched_article_links || []).map(u=>articleUrl(u,task)).filter(Boolean),
    empty_message: capture.empty_message || null, next_links: [...new Set(next)],
    pagination_current: capture.pagination_current || null, pagination_unresolved: !!capture.pagination_unresolved,
    more_controls: capture.more_controls || [], navigation_links: (capture.navigation_links || []).map(x => catalogUrl(x, task)).filter(Boolean),
    completeness: 'page_candidates_only', warnings: capture.warnings || [] };
}
export function mergeCatalog(pages) {
  // Exact DOI / official URL only. Similar titles are flagged, never silently collapsed.
  const out = [];
  for (const page of pages) for (const original of page.items || []) {
    const item = enrichCatalogItem(original);
    const membership=catalogMembership(page,CATALOG_TASKS.find(t=>t.id===page.task_id));
    const found = out.find(p => p.journal === item.journal && ((p.doi && item.doi && p.doi === item.doi) ||
      (p.url === item.url && !(p.doi && item.doi && p.doi !== item.doi))));
    if (found) {
      if(item.type==='other'){found.type='other';found.field_sources={...found.field_sources,...(item.field_sources?.type?{type:item.field_sources.type}:{})};}
      if (!found.doi && item.doi) { found.doi = item.doi; found.doi_status = 'present'; }
      if (!found.catalog_urls.includes(page.source_url)) found.catalog_urls.push(page.source_url);
      found.catalog_memberships.push(membership);
      if (titleKey(found.title) !== titleKey(item.title)) found.title_conflict = true;
      continue;
    }
    out.push({ ...item, catalog_urls: [page.source_url],catalog_memberships:[membership] });
  }
  const resolved=resolveKnownCatalogAliases(out);
  for (const item of resolved) item.possible_duplicate = resolved.some(x => x !== item && x.journal === item.journal && titleKey(x.title) === titleKey(item.title));
  return resolved.map(withTypedDates);
}
