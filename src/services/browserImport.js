import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { makeReviewJobs, reviewedCatalogPapers, validateReviewOutput } from '../../tools/browser-abstract-extension/review-core.js';
import { prepareReviewPlan } from '../../tools/browser-abstract-extension/review-client.js';
import { verdictOutput, canonicalEvidence } from '../../tools/browser-abstract-extension/article-review.js';
import { CATALOG_TASKS, catalogUrl, articleUrl, titleKey } from '../../tools/browser-abstract-extension/catalog-core.js';
import { disabledCatalogUrl, excludedJpeRecord } from '../../tools/browser-abstract-extension/collection-policy.js';
import { detailOtherSource, catalogOtherSource } from '../../tools/browser-abstract-extension/article-type.js';
import { applyAbstractAvailability } from '../../tools/browser-abstract-extension/abstract-availability.js';
import { normalizeSourceRecord, normalizeDoi, cleanText } from './paperModel.js';
import { knownJournalMismatch } from './journalIdentity.js';
import { carTitlePrefix } from './carEnglish.js';
import { dateInShanghai, mergePapers } from './paperMerge.js';
import { matchOfficialPaper, fillMissingAbstract } from './journalEnrichment.js';
import { readJournalLibrary, withLibraryLock, newRunId, writeLibraryJson, publishLibrarySnapshot } from './journalLibrary.js';
import { assertLibrary, isIsoTime, validatePapers, stableJson } from './libraryValidation.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const kinds = new Set(['paper_catalog_sample_trial', 'paper_catalog_supplement_trial', 'paper_project_trial']);
function articleIdentityUrl(value) {
  try {
    const u = new URL(value);
    u.hostname = u.hostname.replace('link.springernature.com', 'link.springer.com');
    u.pathname = u.pathname.replace('/article-abstract/', '/article/').replace('/advance-article-abstract/', '/advance-article/')
      .replace('/science/article/abs/pii/', '/science/article/pii/').replace(/\/doi\/(?:abs|full)\//, '/doi/');
    u.hash = ''; return u.href;
  } catch { return ''; }
}
export async function readBrowserExport(file) {
  assertLibrary((await fs.stat(file)).size <= 150 * 1024 * 1024, '插件导出文件超过150MB');
  const text = await fs.readFile(file, 'utf8'), data = JSON.parse(text.replace(/^\uFEFF/, ''));
  assertLibrary(kinds.has(data.kind) && Array.isArray(data.records) && data.records.length <= 10000 &&
    Array.isArray(data.catalog?.pages), '需要包含目录证据和详情核对结果的插件导出文件');
  return { data, sha256: hash(text) };
}
export function verifiedPages(data) {
  return data.catalog.pages.filter(page => {
    const task = CATALOG_TASKS.find(t => t.id === page.task_id && t.journal === page.journal);
    if (!task || !catalogUrl(page.source_url, task) || disabledCatalogUrl(page.source_url) || !Array.isArray(page.items)) return false;
    const issns = page.identity_evidence?.observed_issns || page.identity?.observed_issns || [];
    if (issns.length && !issns.some(i => task.issns.includes(String(i).toUpperCase()))) return false;
    const heading = [...(page.identity_evidence?.headings || []), page.page_title || ''].some(h => titleKey(h).includes(titleKey(task.name.replace(/^The\s+/i, ''))));
    const pathIssn = new URL(page.source_url).pathname.match(/^\/toc\/([\dXx]{8})\//)?.[1]?.toUpperCase();
    const aerForthcoming = task.journal === 'AER' && new URL(page.source_url).pathname === '/journals/aer/forthcoming';
    return issns.length > 0 || heading || aerForthcoming || (pathIssn && task.issns.some(i => i.replace('-', '') === pathIssn));
  });
}
function matchingCard(pages, record) {
  for (const page of pages) {
    if (page.journal !== record.journal) continue;
    const task = CATALOG_TASKS.find(t => t.id === page.task_id);
    // OUP/Silverchair redirects an article to the public abstract view.
    const detailUrl = String(record.source_url || '').replace('/article-abstract/', '/article/').replace('/advance-article-abstract/', '/advance-article/');
    if (!articleUrl(detailUrl, task)) continue;
    for (const item of page.items) {
      if (item.journal !== record.journal || !titleKey(item.evidence?.text).includes(titleKey(item.title))) continue;
      // Require the SAME article link and title; an unrelated DOI in a card is not enough.
      if (articleUrl(item.url, task) === articleUrl(record.url, task) && titleKey(item.title) === titleKey(record.title) &&
          (!item.doi || normalizeDoi(item.doi) === normalizeDoi(record.doi))) return { page, item };
    }
  }
  return null;
}
function checkedCaches(results = {}) {
  // Cached verdicts must be bound to the exact original request, not just a status flag.
  // Chrome storage may reorder object keys. Bind against the reconstructed job
  // below using canonical evidence, not JSON property insertion order.
  return Object.fromEntries(Object.entries(results).filter(([key, row]) => /^[a-f0-9]{64}$/.test(key) && row?.input));
}
function parseAuthors(text) {
  if (!text) return [];
  // Preserve ambiguous surname-comma strings as missing rather than guessing.
  const parts = text.includes(';') ? text.split(';') : text.split(/,\s*/);
  return parts.every(p => /\s/.test(p.trim()) && !/\bet al\b|\.{3}|…/i.test(p)) ? parts.map(name => ({ name: name.trim() })) : [];
}

/** Offline only. Re-extract exact spans from raw evidence; ignore exported derived papers. */
export async function prepareBrowserImport(data, config, inputHash = hash(JSON.stringify(data))) {
  assertLibrary(kinds.has(data.kind) && Array.isArray(data.records) && Array.isArray(data.catalog?.pages), '插件导出格式无效');
  const pages = verifiedPages(data), catalog = { pages };
  const caches = checkedCaches(data.ai_review_results), catalogCaches = checkedCaches(data.catalog_review_results);
  const plan = await prepareReviewPlan(makeReviewJobs(null, data), caches);
  const catalogPlan = await prepareReviewPlan(makeReviewJobs(catalog, null), catalogCaches);
  for (const job of catalogPlan.jobs) if (catalogCaches[job.hash] && canonicalEvidence(catalogCaches[job.hash].input) !== canonicalEvidence(job.input)) delete catalogCaches[job.hash];
  const catalogPapers = reviewedCatalogPapers(catalog, catalogPlan, catalogCaches);
  const sources = [], decisions = [];
  for (const raw of data.records) {
    const decision = { doi: normalizeDoi(raw.doi), journal_key: raw.journal, action: 'skipped', reason: '' };
    const reject = reason => { decisions.push({ ...decision, reason }); };
    if (excludedJpeRecord(raw)) { reject('excluded_by_user'); continue; }
    const match = matchingCard(pages, raw), journal = config.journals.find(j => j.key === raw.journal);
    if (!match || !journal) { reject('catalog_identity_unconfirmed'); continue; }
    if (knownJournalMismatch({ doi: decision.doi, journal_key: raw.journal })) { reject('wrong_journal'); continue; }
    const job = plan.jobs.find(j => j.id === `article:${raw.doi}`), result = job && caches[job.hash];
    if (!job || !result?.verdict || (result.error && result.error !== 'PROVIDER_ABSTRACT_NOT_EXTRACTED') ||
        canonicalEvidence(result.input) !== canonicalEvidence(job.input)) { reject('review_not_complete'); continue; }
    const checked = validateReviewOutput(job.input, verdictOutput(job.input, result.verdict));
    // Deterministic identity fallback uses only observed title blocks / the
    // official DOI URL. It cannot rescue an explicit conflicting model value.
    const sourceTitle = checked.fields.title || job.input.blocks.find(b => b.kind === 'title' && titleKey(b.text) === titleKey(raw.title))?.text;
    let urlDoi = '';
    try { const u = new URL(job.input.source_url); urlDoi = normalizeDoi(decodeURIComponent(u.pathname).match(/^\/(?:doi\/(?:abs\/|full\/)?|article\/)(10\.\d{4,9}\/[^?#]+)$/i)?.[1] ||
      (u.hostname === 'www.aeaweb.org' && u.pathname === '/articles' ? u.searchParams.get('id') : '') || ''); } catch { }
    const sourceDoi = checked.fields.doi || (urlDoi === decision.doi ? urlDoi : '');
    if (checked.status !== 'source_checked_candidate' || !sourceTitle || !sourceDoi ||
        titleKey(sourceTitle) !== titleKey(raw.title) || sourceDoi !== decision.doi ||
        (urlDoi && urlDoi !== decision.doi) ||
        (!urlDoi && articleIdentityUrl(raw.source_url) !== articleIdentityUrl(match.item.url)) ||
        ['DOI_CONFLICT','QUOTE_NOT_UNIQUE_IN_SOURCE','INVALID_SPAN'].includes(checked.states.doi) ||
        ['QUOTE_NOT_UNIQUE_IN_SOURCE','INVALID_SPAN'].includes(checked.states.title)) { reject('article_identity_unconfirmed'); continue; }
    const capturedAt = raw.extracted_at || raw.captured_at;
    if (!isIsoTime(capturedAt)) { reject('capture_time_missing'); continue; }
    const card = catalogPapers.find(p => p.journal === raw.journal && p.url === match.item.url && titleKey(p.title) === titleKey(raw.title));
    const authorsText = checked.fields.authors || (card?.field_sources?.authors_raw?.method === 'deepseek_source_checked' ? card.authors_raw : '');
    const month = checked.publication_month || (card?.field_sources?.publication_month?.method === 'deepseek_source_checked' ? card.publication_month : '');
    const carTitle = raw.journal === 'CAR' && job.input.blocks.filter(b => b.kind === 'title' && b.text.length >= 20)
      .map(b => carTitlePrefix(sourceTitle, b.text)).filter(Boolean).sort((a,b) => a.length-b.length)[0];
    const selected = { title: carTitle || sourceTitle, doi: sourceDoi, abstract: checked.fields.abstract || '', authors: authorsText || '', publication_month: month || '' };
    const evidenceHash = hash(JSON.stringify(selected));
    const typeEvidence = detailOtherSource(raw) || catalogOtherSource(match.item);
    const source = normalizeSourceRecord({ source: 'publisher', source_id: `browser:${decision.doi}:${evidenceHash}`,
      doi: selected.doi, title: selected.title, abstract: selected.abstract, raw_title: selected.title, raw_abstract: selected.abstract,
      authors: parseAuthors(authorsText), publication_date: month || '',
      journal_key: journal.key, journal_name: journal.name, journal_category: journal.category, journal_category_zh: journal.category_zh,
      print_issn: journal.print_issn, electronic_issn: journal.electronic_issn,
      last_checked_at: capturedAt, url: job.input.source_url,
      type: typeEvidence ? 'other' : 'journal-article',
      raw_dates: { browser_import: { export_sha256: inputHash, request_sha256: job.hash, selected_fields: selected,
        abstract_state: selected.abstract ? 'source_checked' : applyAbstractAvailability({...raw,abstract:null}).abstract_status === 'confirmed_absent' ? 'confirmed_absent' : 'not_in_checked_source', scope: 'captured_details_only', type_evidence: typeEvidence } },
      source_evidence: { url: job.input.source_url, scope_url: match.page.source_url, fetched_at: capturedAt,
        body_sha256: evidenceHash, method: 'browser_verified_source_spans' } });
    sources.push(source);
  }
  // Reject an inconsistent batch rather than letting array order pick a winner.
  const conflicted = new Set(sources.filter(s => sources.some(t => t.doi === s.doi &&
    (t.journal_key !== s.journal_key || titleKey(t.title) !== titleKey(s.title) || (t.abstract && s.abstract && t.abstract !== s.abstract)))).map(s => s.doi));
  const unique = new Map();
  for (const s of sources) {
    if (conflicted.has(s.doi)) { decisions.push({ doi: s.doi, journal_key: s.journal_key, action: 'skipped', reason: 'batch_identity_or_abstract_conflict' }); continue; }
    if (!unique.has(s.doi) || (!unique.get(s.doi).abstract && s.abstract)) unique.set(s.doi, s);
  }
  return { input_sha256: inputHash, sources: [...unique.values()], decisions, raw_record_count: data.records.length };
}

export function planBrowserImport(prepared, previous, config, now = new Date()) {
  const papers = [...previous.papers], decisions = [...prepared.decisions], abstracts = [], journals = [];
  for (const source of prepared.sources) {
    let jr = journals.find(j => j.journal_key === source.journal_key);
    if (!jr) { jr = { journal_key: source.journal_key, coverage: 'partial', official_observed_count: null,
      existing_total_count: previous.papers.filter(p => p.journal_key === source.journal_key).length,
      official_in_window_count: 0, matched_count: 0, missing_count: 0, added_count: 0, pending_count: 0, entries: [], attempts: [] }; journals.push(jr); }
    const match = matchOfficialPaper(source, papers, source.journal_key);
    const row = { doi: source.doi, journal_key: source.journal_key, action: 'unchanged', reason: '', source_url: source.url };
    if (match.status === 'conflict' || (match.paper && titleKey(match.paper.title_original) !== titleKey(source.title))) {
      row.action = 'conflict'; row.reason = match.reason || 'existing_title_conflict'; jr.pending_count++;
      jr.entries.push({ ...row, status: 'pending' });
    } else if (match.status === 'missing') {
      const paper = mergePapers([source], { firstSeenDate: dateInShanghai(now), checkedAt: now.toISOString(), normalizeCar: true }).papers[0];
      assertLibrary(paper && !papers.some(p => p.id === paper.id), '新论文标识冲突');
      papers.push(paper); row.action = 'added'; jr.missing_count++; jr.added_count++;
      jr.entries.push({ ...row, paper_id: paper.id, status: 'added' });
    } else {
      jr.matched_count++;
      if (!match.paper.abstract_original && source.abstract) {
        papers[papers.indexOf(match.paper)] = fillMissingAbstract(match.paper, source); row.action = 'abstract_filled';
        abstracts.push({ paper_id: match.paper.id, journal_key: source.journal_key, doi: source.doi, status: 'found', abstract_source: 'publisher' });
      } else if (source.abstract && cleanText(source.abstract) !== cleanText(match.paper.abstract_original)) row.reason = 'existing_abstract_preserved';
      jr.entries.push({ ...row, paper_id: match.paper.id, status: 'existing' });
    }
    decisions.push(row);
  }
  validatePapers(papers, config);
  return { papers, decisions, journals, abstracts, stats: { added: journals.reduce((n,j) => n+j.added_count,0),
    abstracts_filled: abstracts.length, abstracts_checked: abstracts.length,
    pending_candidates: decisions.filter(d => ['skipped','conflict'].includes(d.action) && d.reason !== 'excluded_by_user').length },
    input_sha256: prepared.input_sha256, scope: 'captured_details_only', paid_requests: 0 };
}

export async function importBrowserExport(config, { root, prepared, save = false, now = () => new Date() }) {
  assertLibrary(typeof root === 'string' && root.length > 3, '必须明确指定导入库目录');
  const execute = async () => {
    const previous = await readJournalLibrary({ root, config }), at = now();
    const plan = planBrowserImport(prepared, previous, config, at);
    if (!save || !plan.stats.added && !plan.stats.abstracts_filled) return { ...plan, committed: false };
    const runId = newRunId(at), day = dateInShanghai(at), status = plan.stats.pending_candidates ? 'partial' : 'success';
    const report = { schema_version: 1, run_id: runId, status, from_date: day, to_date: day,
      stats: plan.stats, journals: plan.journals, abstracts: plan.abstracts, decisions: plan.decisions,
      input_sha256: plan.input_sha256, scope: plan.scope, stage: 'browser_import',
      note: 'Capture import date, not publication window; does not establish complete journal coverage.' };
    const ref = await writeLibraryJson(root, `snapshots/${runId}/browser-import-report.json`, report);
    const log = { schema_version: 1, run_id: runId, run_date: day, started_at: at.toISOString(), finished_at: at.toISOString(),
      from_date: day, to_date: day, status, stats: plan.stats, report: ref };
    await publishLibrarySnapshot({ root, config, previous, papers: plan.papers, enrichment: log,
      audit: previous.audit || { duplicates: [], excluded: [], notices: [] } });
    // Re-read is part of the commit acknowledgement, not just a file-write success.
    const saved = await readJournalLibrary({ root, config });
    assertLibrary(stableJson(saved.papers) === stableJson([...plan.papers].sort((a,b) => a.id.localeCompare(b.id))), '写入后论文校验不一致');
    return { ...plan, committed: true, run_id: runId };
  };
  return save ? withLibraryLock(root, execute) : execute();
}
