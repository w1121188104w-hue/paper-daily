import path from 'node:path';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { loadSearchPolicy } from '../src/services/searchPolicy.js';
import { assertLibrary } from '../src/services/libraryValidation.js';
import { publisherFor } from '../src/services/publisherCatalog.js';
import { classifyPaper } from '../src/services/paperClassification.js';
import { knownJournalMismatch } from '../src/services/journalIdentity.js';
import { missingOriginalAbstract } from '../src/services/carAbstractLanguage.js';
import { originalAbstractSection, verifiedSearchRecord } from '../src/services/searchExtraction.js';
import { safeSearchLink, abstractSearchQueries } from '../src/services/searchSources.js';
import { normalizeTitleForMatch, cleanText } from '../src/services/paperModel.js';
import { evidenceHash } from '../src/services/evidenceHttp.js';
import { makePipelineRuntime } from './journal-pipeline.js';

export const PUBLISHER_GROUPS = Object.freeze([
  ['Elsevier', ['AOS', 'JAE', 'JFE', 'JCF', 'RP']], ['Wiley', ['JAR', 'CAR', 'JF', 'JOM']],
  ['Springer Nature', ['RAS', 'JIBS']], ['Oxford University Press', ['QJE', 'RES', 'RFS']],
  ['American Accounting Association', ['TAR']], ['American Economic Association', ['AER']],
  ['University of Chicago Press', ['JPE']], ['INFORMS', ['MS']], ['SAGE', ['JM']]
]);
const fatal = e => ['SEARCH_LEDGER_CHECKPOINT_FAILED', 'EVIDENCE_STORAGE_ERROR'].includes(e.code);
const safeCode = e => /^[A-Z_]{3,50}$/.test(e?.code || '') ? e.code : 'CHECK_FAILED';
export function officialArticleUrl(value, journal) {
  const url = safeSearchLink(value); if (!url) return null;
  const u = new URL(url), p = publisherFor(journal);
  if (!p.hosts.includes(u.hostname) || /^(?:api|rss)\./.test(u.hostname) || /\.pdf$/i.test(u.pathname) || /\/doi\/(?:pdf|epdf)\//i.test(u.pathname)) return null;
  return /\/(?:doi|article|articles)(?:\/|$)/i.test(u.pathname) || /\/advance-article\//i.test(u.pathname) ? url : null;
}
export function knownArticleUrl(paper, journal) {
  const rows = paper.source_records || [];
  const saved = [paper.url, ...rows.flatMap(r => [r.url, r.source_evidence?.url])]
    .map(u => officialArticleUrl(u, journal)).find(Boolean);
  if (saved) return saved;
  if (!paper.doi) return null;
  const p = publisherFor(journal), doi = encodeURIComponent(paper.doi).replace(/%2F/gi, '/');
  // Constructed URLs are only candidates; every returned page still needs identity verification.
  if (p.family === 'wiley' || p.family === 'atypon') return `${new URL(p.home).origin}/doi/abs/${doi}`;
  if (p.family === 'springer') return `https://link.springer.com/article/${doi}`;
  if (p.family === 'aea') return `https://www.aeaweb.org/articles?id=${encodeURIComponent(paper.doi)}`;
  return null;
}
export function selectPublisherSamples(papers, config) {
  const selected = [], groups = [];
  for (const [publisher, keys] of PUBLISHER_GROUPS) {
    const pool = papers.filter(p => keys.includes(p.journal_key) && p.doi && !knownJournalMismatch(p) &&
      classifyPaper(p).kind === 'candidate' && findJournal(config, p.journal_key)?.enabled)
      .sort((a, b) => String(b.publication_date || '').localeCompare(String(a.publication_date || '')) || a.id.localeCompare(b.id));
    const missing = pool.filter(missingOriginalAbstract), controls = pool.filter(p => !missingOriginalAbstract(p));
    const chosen = [], usedJournals = new Set();
    for (const p of missing) if (!usedJournals.has(p.journal_key) && chosen.length < 2) { chosen.push(p); usedJournals.add(p.journal_key); }
    for (const p of missing) if (chosen.length < 2 && !chosen.includes(p)) chosen.push(p);
    const control = controls.find(p => !usedJournals.has(p.journal_key)) || controls[0];
    if (control) chosen.push(control);
    groups.push({ publisher, journals: keys, eligible: pool.length, missing: missing.length, selected: chosen.length });
    chosen.forEach((paper, round) => selected.push({ publisher, paper, round, control: !missingOriginalAbstract(paper) }));
  }
  // Cover every publisher before spending a second or third sample on any one publisher.
  selected.sort((a, b) => a.round - b.round);
  assertLibrary(selected.length <= 27 && new Set(selected.map(t => t.paper.id)).size === selected.length, '测试样本边界错误');
  return { groups, selected };
}
function checkedContent(leads, paper, journal) {
  let record = null, code = null;
  try { record = verifiedSearchRecord(leads, paper, journal, new Date().toISOString()); }
  catch (e) { if (fatal(e)) throw e; code = safeCode(e); }
  // A parser match is not success if it swallowed navigation or access text.
  if (record && /\b(?:Access this article|Log in via an institution|Subscribe and save|Similar content being viewed by others)\b/i.test(record.abstract)) {
    record = null; code = 'CONTAMINATED_ABSTRACT';
  }
  const hasAbstract = leads.some(l => originalAbstractSection(l.content));
  const text = leads.map(l => String(l.content || ''));
  const challenge = text.some(s => /^\s*(?:#\s*)?(?:Just a moment|Access denied|Verify you are human|Robot check|Sign in|Log in)\b/i.test(s));
  const status = record ? 'verified_abstract' : code === 'CONTAMINATED_ABSTRACT' ? 'contaminated_abstract' : challenge ? 'challenge_page' : hasAbstract ? 'identity_not_verified' :
    text.some(s => /\bAbstract\b/i.test(s)) ? 'abstract_section_not_accepted' : text.length ? 'page_without_abstract_marker' : 'no_page_content';
  return { record, result: { status, ...(code ? { code } : {}), content_lengths: text.map(s => s.length),
    bounded_abstract: hasAbstract, ...(record ? { abstract_length: record.abstract.length,
      matches_existing: paper.abstract_original ? cleanText(record.abstract) === cleanText(paper.abstract_original) : null,
      verified_evidence: { url: record.url, abstract: record.abstract, sha256: evidenceHash(record.abstract) } } : {}) } };
}

export async function publisherReaderComparison({ env = process.env, log = console.log, configLoader = loadJournalConfig,
  policyLoader = loadSearchPolicy, readLibrary = readJournalLibrary, runtimeFactory = makePipelineRuntime, now = Date.now } = {}) {
  assertLibrary(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REPOSITORY === 'w1121188104w-hue/paper-daily', '仅允许受控隔离检验');
  const config = await configLoader(), policy = await policyLoader(), root = path.resolve('production-baseline/data/journal-store');
  const before = await readLibrary({ root, config }), plan = selectPublisherSamples(before.papers, config);
  log('PUBLISHER_COMPARISON_PLAN ' + JSON.stringify({ groups: plan.groups, selected: plan.selected.length, paid_request_limit: 81 }));
  const runtime = await runtimeFactory({ env, policy, enableReaderProbe: true }), records = [];
  const start = now(), seen = new Set(); let stopped = null, requested = 0, reads = 0, searches = 0;
  function available() { return !stopped && now() - start < 10 * 60 * 1000 && requested < 81; }
  function captureStop(answer) {
    if (answer?.diagnostic?.provider_error_code === '1113' || answer?.reason === 'provider_payment_required') stopped = 'provider_payment_required';
    if (answer?.diagnostic?.http_status === 401 || answer?.diagnostic?.provider_error_code === '1002') stopped = 'provider_authentication_failed';
  }
  for (const { publisher, paper, control } of plan.selected) {
    const journal = findJournal(config, paper.journal_key), row = { publisher, journal: paper.journal_key, doi: paper.doi,
      control, attempts: [], newly_verified: false }, urls = new Set();
    let verified = false;
    async function tryUrl(url) {
      if (!available() || !url || urls.size >= 2 || urls.has(url) || seen.has(url)) return;
      urls.add(url); seen.add(url);
      // Direct and Reader results are measured separately on the same public URL.
      try {
        const r = await runtime.sources.publisherArticle({ ...paper, url }, journal);
        row.attempts.push({ channel: 'direct', url, status: r?.abstract ? 'verified_abstract' : 'no_abstract', abstract_length: r?.abstract?.length || 0 });
      } catch (e) { if (fatal(e)) throw e; row.attempts.push({ channel: 'direct', url, status: safeCode(e) }); }
      if (!available()) return;
      requested++; reads++;
      const answer = await runtime.sources.readerArticle(paper, journal, url); captureStop(answer);
      const inspected = checkedContent(answer.result?.leads || [], paper, journal);
      row.attempts.push({ channel: 'reader', url, called: Boolean(answer.called), reason: answer.reason || null,
        diagnostic: answer.diagnostic || null, ...inspected.result });
      verified ||= Boolean(inspected.record);
    }
    try {
      if (!available()) row.skipped = stopped || 'test_budget_or_deadline';
      else {
        let initialUrl = knownArticleUrl(paper, journal);
        // DOI metadata can provide the publisher landing page without paid search.
        if (!initialUrl && runtime.http) {
          try {
            const response = await runtime.http.request(`https://api.crossref.org/works/${encodeURIComponent(paper.doi)}`,
              ['api.crossref.org'], { checkRobots: false });
            const work = JSON.parse(response.body).message;
            if (String(work?.DOI || '').toLowerCase() === paper.doi.toLowerCase()) {
              const candidates = [work.resource?.primary?.URL, work.URL];
              // Convert only an explicit publisher PII locator; still verify the article's identity after reading.
              if (publisherFor(journal).family === 'elsevier') for (const value of [...candidates]) {
                const match = /^https:\/\/linkinghub\.elsevier\.com\/retrieve\/pii\/([A-Z0-9]+)$/i.exec(value || '');
                if (match) candidates.push(`https://www.sciencedirect.com/science/article/pii/${match[1]}`);
              }
              initialUrl = candidates.map(u => officialArticleUrl(u, journal)).find(Boolean) || null;
            }
            row.attempts.push({ channel: 'crossref_url_lookup', status: initialUrl ? 'official_url_found' : 'no_official_url' });
          } catch (e) { if (fatal(e)) throw e; row.attempts.push({ channel: 'crossref_url_lookup', status: safeCode(e) }); }
        }
        await tryUrl(initialUrl);
        if (!verified && available()) {
          requested++; searches++;
          const query = abstractSearchQueries(paper, journal)[0];
          const answer = await runtime.search({ provider: 'zhipu', query, taskId: 'publisher-comparison:' + paper.id });
          captureStop(answer);
          const leads = answer.result?.leads || [], inspected = checkedContent(leads, paper, journal);
          row.attempts.push({ channel: 'search', called: Boolean(answer.called), reason: answer.reason || null,
            diagnostic: answer.diagnostic || null, leads: leads.length, ...inspected.result });
          verified ||= Boolean(inspected.record);
          const title = normalizeTitleForMatch(paper.title_original);
          const official = leads.map(l => ({ ...l, url: officialArticleUrl(l.url, journal) })).filter(l => {
            if (!l.url) return false;
            let decoded = l.url; try { decoded = decodeURIComponent(l.url); } catch { return false; }
            return normalizeTitleForMatch(l.title) === title ||
              (decoded + ' ' + (l.content || '')).toLowerCase().includes(paper.doi.toLowerCase());
          });
          official.sort((a, b) => Number(normalizeTitleForMatch(b.title) === title) - Number(normalizeTitleForMatch(a.title) === title));
          for (const lead of official) { if (verified || !available() || urls.size >= 2) break; await tryUrl(lead.url); }
        }
      }
    } catch (e) { if (fatal(e)) throw e; row.error = safeCode(e); }
    row.verified = verified; row.newly_verified = !control && verified;
    records.push(row); log('PUBLISHER_COMPARISON_ROW ' + JSON.stringify(row));
  }
  const after = await readLibrary({ root, config });
  assertLibrary(before.pointerText === after.pointerText, '验证不得改变正式库');
  const groups = plan.groups.map(g => ({ ...g, tested: records.filter(r => r.publisher === g.publisher && !r.skipped).length,
    verified: records.filter(r => r.publisher === g.publisher && r.verified).length,
    newly_verified: records.filter(r => r.publisher === g.publisher && r.newly_verified).length }));
  const result = { groups, records, stopped, requested, reads, searches, ...runtime.summary(),
    baseline: before.pointer.manifest, production_writes: 0, translation_calls: 0 };
  log('PUBLISHER_COMPARISON_RESULT ' + JSON.stringify(result)); return result;
}
