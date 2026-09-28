import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { readJournalLibrary, readLibraryRef } from '../src/services/journalLibrary.js';
import { runMetadataRepair } from '../src/services/metadataRepairRun.js';
import { runDuplicateResolution, selectDuplicateClaims } from '../src/services/duplicateResolutionRun.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { validateDuplicateTransition, validateDuplicateState } from '../src/services/duplicateResolution.js';
import { exportTranslationBatch, importTranslationFile } from '../src/services/translationWorkflow.js';
import { presentJournalLibrary } from '../src/services/journalPresentation.js';
import { officialDiscoveries } from '../src/services/masterList.js';
import { journalGitFiles } from '../src/services/journalGitFiles.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER');
const early = '2026-09-15T01:00:00.000Z', at = '2026-09-16T01:00:00.000Z', checked = '2026-09-16T02:00:00.000Z';
const doi = '10.1257/archive-merge', title = 'Financial markets and the allocation of resources';
const abstract = 'We investigate how financial constraints affect the allocation of resources across firms and identify persistent differences in investment.';
const titleZh = '金融市场与企业资源配置', abstractZh = '我们研究融资约束如何影响企业之间的资源配置，并利用详细的企业数据识别投资行为中持续存在的差异。';
function record(source, patch = {}) {
  return normalizeSourceRecord({ source, source_id: source === 'crossref' ? doi : 'W777', doi: source === 'crossref' ? doi : '',
    title, abstract: source === 'openalex' ? abstract : '', authors: source === 'crossref' ? ['Alice Smith'] : [], publication_date: '2026-08',
    journal_key: journal.key, journal_name: journal.name, journal_category: journal.category, journal_category_zh: journal.category_zh,
    print_issn: journal.print_issn, electronic_issn: journal.electronic_issn, type: 'journal-article', last_checked_at: at, ...patch });
}
const absent = async () => { throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' }); };
function clients(rows) {
  return Object.fromEntries(['crossref', 'openalex', 'semanticscholar'].map(source => [source, async () => ({ source, journal_key: 'AER',
    records: rows.filter(row => row.source === source), ok: true, complete: true, raw_count: rows.filter(row => row.source === source).length,
    raw_pages: [], rejected: [], duration_ms: 0, error: null })]));
}
async function seed(t, { translate = true, prepare = true } = {}) {
  const parent = await fs.realpath(os.tmpdir()), repositoryRoot = await fs.mkdtemp(path.join(parent, 'duplicate-resolution-'));
  t.after(async () => { assert.equal(path.dirname(repositoryRoot), parent); assert.ok(path.basename(repositoryRoot).startsWith('duplicate-resolution-')); await fs.rm(repositoryRoot, { recursive: true, force: true }); });
  const root = path.join(repositoryRoot, 'data', 'journal-store'), originalRecord = record('openalex', { last_checked_at: early });
  await runJournalCollection(config, { root, journalKey: 'AER', now: () => new Date(early), clients: clients([originalRecord]) });
  let response = null;
  if (translate) {
    const { batch } = await exportTranslationBatch(config, { root, now: () => new Date(early) });
    response = { schema_version: 1, batch_id: batch.batch_id, model: 'offline-test', translated_at: early,
      items: [{ id: batch.items[0].id, source_text_hash: batch.items[0].source_text_hash, title_zh: titleZh, abstract_zh: abstractZh }] };
    assert.equal((await importTranslationFile(config, { root, result: response, save: true, now: () => new Date(early) })).committed, true);
  }
  await runJournalCollection(config, { root, journalKey: 'AER', now: () => new Date(at), clients: clients([record('crossref')]) });
  const before = await readJournalLibrary({ root, config }), original = before.papers.find(p => !p.doi);
  assert.equal(before.papers.length, 2);
  const withProof = source => {
    const url = source === 'crossref' ? `https://api.crossref.org/works/${encodeURIComponent(doi)}` : `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`;
    return record(source, { doi, authors: ['Alice Smith'], last_checked_at: checked,
      source_evidence: { url, scope_url: url, method: `${source}_api`, fetched_at: checked, body_sha256: 'a'.repeat(64) } });
  };
  if (prepare) {
    const repaired = await runMetadataRepair(config, { root, paperIds: [original.id], now: () => new Date(checked),
    sources: { crossref: async () => withProof('crossref'), openalex: async () => withProof('openalex'), semanticscholar: absent, publisherArticle: absent },
    search: () => assert.fail('Verified without search') });
    assert.equal(repaired.report.repairs[0].status, 'merge_ready');
  }
  return { root, repositoryRoot, original, originalRecord, response, withProof, before: await readJournalLibrary({ root, config }) };
}

test('归并实际保存：父版本可重演、完整原记录留档，日期保真，名册与旧UI/翻译队列一致', async t => {
  const data = await seed(t), { root, before, original } = data;
  const parentBytes = await fs.readFile(path.join(root, before.pointer.manifest.path), 'utf8');
  const result = await runDuplicateResolution(config, { root, now: () => new Date(checked) });
  assert.equal(result.status, 'success'); assert.equal(result.stats.merged, 1);
  const after = await readJournalLibrary({ root, config }), paper = after.papers[0];
  assert.equal(after.papers.length, 1); assert.equal(after.masterList.statistics.total, 1);
  assert.equal(paper.id, before.papers.find(p => p.doi).id); assert.equal(paper.doi, doi);
  assert.equal(paper.discovered_at, early); assert.equal(paper.first_seen_date, '2026-09-15');
  assert.equal(paper.title_zh, titleZh); assert.equal(paper.abstract_zh, abstractZh);
  assert.equal(after.queue.field_count, 0); assert.equal(presentJournalLibrary(after, config).papers.length, 1);
  const report = after.enrichmentReports.find(row => row.run_id === after.manifest.run_id);
  assert.deepEqual(report.merges[0].original, original);
  assert.ok(report.archived_issues.length > 0);
  assert.ok(Object.values(after.repairState.issues).every(issue => issue.paper_id === paper.id && issue.status === 'resolved'));
  validateDuplicateTransition(before.papers, after.papers, report);
  validateDuplicateState(before, after.papers, report, after.enrichmentState);
  assert.equal(await fs.readFile(path.join(root, before.pointer.manifest.path), 'utf8'), parentBytes);
  const closure = await journalGitFiles(config, data);
  assert.ok(closure.files.some(file => file.endsWith(after.enrichments.find(row => row.run_id === after.manifest.run_id).report.path)));
  assert.ok(closure.files.some(file => file.endsWith(before.pointer.manifest.path)));
});

test('归并后再次收集无DOI旧来源不会复活旧身份，旧翻译结果不会写入其他论文', async t => {
  const data = await seed(t);
  await runDuplicateResolution(config, { root: data.root, now: () => new Date(checked) });
  assert.equal((await runDuplicateResolution(config, { root: data.root, now: () => new Date(checked) })).status, 'skipped');
  await runJournalCollection(config, { root: data.root, journalKey: 'AER', now: () => new Date('2026-09-17T01:00:00.000Z'),
    clients: clients([{ ...data.originalRecord, last_checked_at: '2026-09-17T01:00:00.000Z' }]) });
  const after = await readJournalLibrary({ root: data.root, config });
  assert.equal(after.papers.length, 1); assert.equal(after.papers[0].doi, doi); assert.equal(after.papers[0].discovered_at, early);
  assert.equal(after.papers[0].abstract_zh, abstractZh); assert.equal(after.queue.field_count, 0);
  const oldImport = await importTranslationFile(config, { root: data.root, result: data.response, now: () => new Date('2026-09-17T01:00:00.000Z') });
  assert.equal(oldImport.report.stats.completed_fields, 0); assert.ok(oldImport.report.fields.some(field => field.code === 'UNKNOWN_ID'));
});

test('归并中断保留旧指针和两条记录，重新执行可恢复且不联网', async t => {
  const { root, before } = await seed(t, { translate: false });
  await assert.rejects(runDuplicateResolution(config, { root, now: () => new Date(checked), beforePublish: () => { throw new Error('Interrupted'); } }));
  const unchanged = await readJournalLibrary({ root, config });
  assert.equal(unchanged.pointerText, before.pointerText); assert.equal(unchanged.papers.length, 2);
  await runDuplicateResolution(config, { root, now: () => new Date(checked) });
  const after = await readJournalLibrary({ root, config });
  assert.equal(after.papers.length, 1); assert.equal(after.queue.paper_count, 1); assert.equal(after.queue.field_count, 2);
});

test('归并结果、完整归档及重试状态任何篡改都不能通过父版本重演', async t => {
  const { root, before } = await seed(t);
  await runDuplicateResolution(config, { root, now: () => new Date(checked) });
  const after = await readJournalLibrary({ root, config }), report = after.enrichmentReports.find(row => row.run_id === after.manifest.run_id);
  const badPapers = structuredClone(after.papers); badPapers[0].title_zh = '偷偷改写';
  assert.throws(() => validateDuplicateTransition(before.papers, badPapers, report));
  const badArchive = structuredClone(report); badArchive.merges[0].original.abstract_zh = '';
  assert.throws(() => validateDuplicateTransition(before.papers, after.papers, badArchive));
  const badState = structuredClone(report); badState.archived_issues = [];
  assert.throws(() => validateDuplicateState(before, after.papers, badState, after.enrichmentState));
  assert.equal((await readLibraryRef(root, after.manifest.parent)).run_id, before.manifest.run_id);
});




test('两份证据指向不同DOI时不按先后顺序强行归并，仍保留未解决身份', async t => {
  const { before, original, withProof } = await seed(t);
  const otherDoi = '10.1257/another-target';
  const other = mergePapers([record('crossref', { doi: otherDoi, source_id: otherDoi })], { checkedAt: at, firstSeenDate: '2026-09-16' }).papers[0];
  const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(otherDoi)}`;
  const evidence = normalizeSourceRecord({ ...withProof('openalex'), doi: otherDoi,
    source_evidence: { ...withProof('openalex').source_evidence, url, scope_url: url } });
  const library = { ...before, papers: [...before.papers, other], enrichmentReports: [...before.enrichmentReports,
    { run_id: '20260916-another-claim', repairs: [{ paper_id: original.id, duplicate_claims: [{ target_id: other.id, record: evidence }] }] }] };
  assert.deepEqual(selectDuplicateClaims(config, library, checked), []);
  assert.deepEqual(selectDuplicateClaims(config, { ...library, enrichmentReports: [...library.enrichmentReports].reverse() }, checked), []);
  assert.equal(library.papers.length, 3);
});

test('官网独立发现标记沿已验证归并关系保留，不把普通查询当官网发现', () => {
  const merged = { stage: 'duplicate_resolution', merges: [{ resolution: { original_id: 'old', target_id: 'new' } }] };
  assert.deepEqual([...officialDiscoveries([merged])], []);
  assert.ok(officialDiscoveries([{ journals: [{ entries: [{ status: 'added', paper_id: 'old' }] }] }, merged]).has('new'));
});
