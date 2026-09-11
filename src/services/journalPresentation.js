import fs from 'node:fs/promises';
import { DEFAULT_LIBRARY_ROOT, libraryPath, readJournalLibrary, readLibraryRef } from './journalLibrary.js';
import { isIsoTime } from './libraryValidation.js';
import { classifyPaper, CLASSIFICATION_VERSION } from './paperClassification.js';
import { translationEligibility } from './translationQueue.js';
import { evidence } from './paperMerge.js';

// Explicit public fields: never serialize a library snapshot or raw source response directly.
const PAPER_FIELDS = ['id', 'doi', 'journal_key', 'journal_name', 'journal_category', 'journal_category_zh',
  'first_seen_date', 'title_original', 'abstract_original', 'title_zh', 'abstract_zh',
  'title_translation_status', 'abstract_translation_status', 'published_online_date',
  'published_print_date', 'publication_date', 'volume', 'issue', 'pages'];
const select = (value, fields) => Object.fromEntries(fields.map((key) => [key, value[key]]));
const DATE_FIELDS = ['published_online_date', 'published_print_date', 'publication_date'];
const publicSource = (source) => ['crossref', 'openalex', 'publisher', 'semanticscholar'].includes(source) ? source : null;
function abstractInfo(paper, state) {
  const provenance = paper.provenance?.abstract_original;
  const record = paper.source_records.find(r => r.source === provenance?.source && r.source_id === provenance?.source_id && r.abstract === paper.abstract_original);
  const retry = state?.abstracts?.[paper.id];
  let url = record?.source_evidence?.url || '';
  if (!url && record?.source === 'crossref' && paper.doi) url = `https://api.crossref.org/works/${encodeURIComponent(paper.doi)}`;
  if (!url && record?.source === 'openalex' && /^W\d+$/.test(record.source_id)) url = `https://openalex.org/${record.source_id}`;
  return { abstract_status: paper.abstract_original ? record?.source_evidence ? 'found' : 'available' : retry?.status || 'missing',
    abstract_source: publicSource(provenance?.source), abstract_source_url: url,
    abstract_last_checked_at: retry?.last_checked_at || record?.last_checked_at || null,
    abstract_next_retry_at: !paper.abstract_original ? retry?.next_retry_at || null : null };
}
const comparableNames = (names) => JSON.stringify(names.map((name) => name.normalize('NFKC')
  .replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()));

// Compare complete ordered lists, not guessed individual identities. Only the latest
// non-empty evidence per source record is shown, matching the merge's history rules.
export function authorVariants(paper) {
  const variants = new Map();
  for (const record of evidence(paper.source_records || [], 'authors')) {
    const source = publicSource(record.source);
    if (!source) continue;
    const names = record.authors.map((author) => author.name), key = comparableNames(names);
    const variant = variants.get(key) || { sources: [], names };
    if (!variant.sources.includes(source)) variant.sources.push(source);
    variants.set(key, variant);
  }
  if (variants.size <= 1) return [];
  return [...variants.values()].map((variant) => ({ ...variant, sources: variant.sources.sort() }))
    .sort((a, b) => a.sources.join(',').localeCompare(b.sources.join(',')) || comparableNames(a.names).localeCompare(comparableNames(b.names)));
}

export function presentJournalLibrary(library, config) {
  const papers = library.papers.map((paper) => ({ ...select(paper, PAPER_FIELDS),
    ...abstractInfo(paper,library.enrichmentState),
    sources: [...paper.sources], authors: paper.authors.map((author) => select(author, ['name', 'orcid'])),
    author_variants: authorVariants(paper),
    date_sources: Object.fromEntries(DATE_FIELDS.map((field) => [field, publicSource(paper.provenance?.[field]?.source)])),
    classification: classifyPaper(paper) }));
  const eligibility = translationEligibility(library.papers);
  return {
    schema_version: 1, initialized: Boolean(library.manifest),
    snapshot_at: library.manifest?.created_at || null,
    journals: config.journals.filter((journal) => journal.enabled)
      .map((journal) => select(journal, ['key', 'name', 'category', 'category_zh'])),
    papers,
    classification_summary: { version: CLASSIFICATION_VERSION,
      counts: papers.reduce((counts, paper) => { counts[paper.classification.kind] = (counts[paper.classification.kind] || 0) + 1; return counts; }, {}) },
    translation_eligibility: { ready: select(eligibility.ready, ['paper_count', 'field_count']),
      held: select(eligibility.held, ['paper_count', 'field_count']) },
    runs: library.runs.map((run) => ({
      ...select(run, ['run_date', 'started_at', 'finished_at', 'from_date', 'to_date', 'status']),
      journal_keys: [...run.journal_keys], stats: select(run.stats, ['added', 'updated', 'new_pending_fields']),
      sources: run.sources.map((source) => select(source, ['source', 'journal_key', 'ok', 'complete']))
    })).sort((a, b) => b.started_at.localeCompare(a.started_at)),
    pending: select(library.queue, ['paper_count', 'field_count']),
    enrichment: { latest: [...(library.enrichments || [])].sort((a,b) => b.started_at.localeCompare(a.started_at))[0] ?
      select([...(library.enrichments || [])].sort((a,b) => b.started_at.localeCompare(a.started_at))[0], ['started_at','finished_at','from_date','to_date','status','stats']) : null,
      journals: [], missing_abstracts: papers.filter(p => !p.abstract_original).length },
    attempt_warning: null
  };
}

async function optionalJson(root, relative) {
  try {
    const file = await libraryPath(root, relative);
    if ((await fs.stat(file)).size > 64 * 1024) throw new Error('Attempt too large');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Uncommitted collection attempts are NOT in the formal run log. Do not hide them behind an old green badge.
export async function latestAttemptWarning(root, library) {
  try {
    let entries;
    try { entries = await fs.readdir(await libraryPath(root, 'attempts'), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const committed = new Set(library.runs.map((run) => run.run_id));
    const latest = library.runs.reduce((time, run) => run.started_at > time ? run.started_at : time, '');
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9-]{10,100}$/.test(entry.name) || committed.has(entry.name)) continue;
      const prefix = `attempts/${entry.name}`;
      const started = await optionalJson(root, `${prefix}/started.json`);
      if (started?.operation === 'translation_import') continue;
      if (!started || started.run_id !== entry.name || !isIsoTime(started.started_at)) throw new Error('Invalid attempt');
      if (started.started_at < latest) continue;
      if (await optionalJson(root, `${prefix}/skipped.json`)) continue;
      const failed = await optionalJson(root, `${prefix}/failed.json`);
      return { status: failed ? 'uncommitted_failure' : 'unconfirmed', started_at: started.started_at };
    }
    return null;
  } catch { return { status: 'unavailable', started_at: null }; }
}

export async function loadJournalPresentation(config, { root = DEFAULT_LIBRARY_ROOT } = {}) {
  const library = await readJournalLibrary({ root, config });
  const data = presentJournalLibrary(library, config);
  // Most recent OFFICIAL result per journal survives later abstract-only and collection/translation runs.
  const seen = new Set();
  for (const run of [...(library.enrichments || [])].sort((a,b) => b.started_at.localeCompare(a.started_at))) {
    const report = await readLibraryRef(root,run.report);
    for (const j of report.journals) if (!seen.has(j.journal_key)) {
      seen.add(j.journal_key);
      data.enrichment.journals.push({ ...select(j,['journal_key','coverage','official_observed_count','official_in_window_count','existing_total_count','matched_count','missing_count','added_count','pending_count']),
        checked_at: run.finished_at,from_date: run.from_date,to_date: run.to_date });
    }
  }
  data.attempt_warning = await latestAttemptWarning(root, library);
  return data;
}
