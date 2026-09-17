import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { classifyPaper, classifySourceRecord } from '../src/services/paperClassification.js';
import { buildMasterList } from '../src/services/masterList.js';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { buildTranslationQueue, translationEligibility } from '../src/services/translationQueue.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { readJournalLibrary, writeLibraryJson } from '../src/services/journalLibrary.js';
import { emptyRepairState, reconcileRepairState } from '../src/services/repairState.js';
import { runMetadataRepair } from '../src/services/metadataRepairRun.js';

const config = await loadJournalConfig(), at = '2026-09-17T01:00:00.000Z';
const titles = { RP: 'Research Policy', JAE: 'Journal of Accounting and Economics',
  JFE: 'Journal of Financial Economics', JCF: 'Journal of Corporate Finance', MS: 'Management Sciences' };
function record(title, id = 'board', key = 'RP') {
  const j = findJournal(config, key);
  return normalizeSourceRecord({ source: 'crossref', source_id: `10.9999/${id}`, doi: `10.9999/${id}`,
    title, authors: ['Synthetic Author'], abstract: '', publication_date: '2026-09-01', last_checked_at: at,
    journal_key: key, journal_name: j.name, journal_category: j.category, journal_category_zh: j.category_zh,
    print_issn: j.print_issn, electronic_issn: j.electronic_issn, type: 'journal-article' });
}
const papers = rows => mergePapers(rows, { checkedAt: at, firstSeenDate: '2026-09-17' }).papers;

test('期刊名前缀编委名单只匹配已核查的完整标题，不误排正常研究或通知', () => {
  for (const [key, name] of Object.entries(titles)) {
    const row = record(`${name}: Editorial Board`, 'board', key);
    assert.equal(classifySourceRecord(row).kind, 'administrative');
    assert.equal(classifySourceRecord(row, { includePrefixedBoards: false }).kind, 'candidate');
    assert.equal(classifySourceRecord({ ...row, journal_key: 'AER' }).kind, 'candidate');
    assert.equal(classifySourceRecord({ ...row, title: `${name}: Editorial Board Composition and Research Quality` }).kind, 'candidate');
    assert.equal(classifySourceRecord({ ...row, title: `Correction: ${row.title}` }).kind, 'possible_correction');
    assert.equal(classifySourceRecord({ ...row, title: `Retraction: ${row.title}` }).kind, 'possible_retraction');
  }
  assert.equal(classifySourceRecord(record('Management Science: Editorial Board', 'board', 'MS')).kind, 'administrative');
  assert.equal(classifyPaper({ source_records: [record('Research Policy: Editorial Board'), record('A real research title')] }).kind, 'needs_review');
});

test('v1至v5旧总名册不变，v6改分类但不改变原文、总数、真实缺摘要数或完整翻译队列', () => {
  const input = papers([record('Research Policy: Editorial Board'), record('A genuine research paper', 'research')]);
  const before = structuredClone(input), queue = buildTranslationQueue(input);
  for (const policyVersion of [1, 2, 3, 4, 5]) {
    const old = buildMasterList(input, { generatedAt: at, policyVersion });
    assert.equal(old.entries.find(p => p.doi === '10.9999/board').classification, 'candidate');
    assert.equal(old.statistics.total, 2); assert.equal(old.statistics.missing_abstract, 2);
  }
  const current = buildMasterList(input, { generatedAt: at, policyVersion: 6 });
  assert.equal(current.statistics.total, 2); assert.equal(current.statistics.missing_abstract, 2);
  assert.equal(current.statistics.research_candidates, 1);
  assert.deepEqual(translationEligibility(input).eligible.map(p => p.doi), ['10.9999/research']);
  assert.deepEqual(buildTranslationQueue(input), queue); assert.deepEqual(input, before);
});

test('v5正式库兼容回归：保留编委名单历史，只补真正论文，升级后关闭编务补查而不声称补齐摘要', async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'board-history-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('board-history-')); await fs.rm(root, { recursive: true, force: true }); });
  const initialRows = [record('Temporary fixture title'), record('A genuine research paper', 'research')];
  const clients = Object.fromEntries(['crossref', 'openalex'].map(source => [source, async () => ({ source, journal_key: 'RP', ok: true, complete: true,
    records: source === 'crossref' ? initialRows : [], raw_pages: [], raw_count: source === 'crossref' ? 2 : 0, rejected: [], duration_ms: 0, error: null })]));
  await runJournalCollection(config, { root, journalKey: 'RP', clients, now: () => new Date(at) });
  const initial = await readJournalLibrary({ root, config }), prefix = `snapshots/${initial.manifest.run_id}`;
  const input = papers([record('Research Policy: Editorial Board'), initialRows[1]]);
  const legacy = { ...initial.manifest, master_policy_version: 5, papers: {} };
  for (const bucket of Object.keys(initial.manifest.papers)) {
    const rows = input.filter(p => p.first_seen_date.startsWith(bucket));
    legacy.papers[bucket] = { ...await writeLibraryJson(root, `${prefix}/legacy/papers/${bucket}.json`, rows), count: rows.length };
  }
  const master = buildMasterList(input, { generatedAt: legacy.created_at, policyVersion: 5,
    fromDate: initial.masterList.from_date, toDate: initial.masterList.to_date });
  legacy.master_list = await writeLibraryJson(root, `${prefix}/legacy-master.json`, master);
  legacy.translation_queue = await writeLibraryJson(root, `${prefix}/legacy-queue.json`, buildTranslationQueue(input));
  legacy.repair_state = await writeLibraryJson(root, `${prefix}/legacy-repairs.json`, reconcileRepairState(emptyRepairState(), master));
  // Only the fresh, scoped test fixture is edited; never a production snapshot.
  const legacyText = JSON.stringify(legacy);
  await fs.writeFile(path.join(root, `${prefix}/manifest.json`), legacyText);
  const ref = { path: `${prefix}/manifest.json`, sha256: createHash('sha256').update(legacyText).digest('hex') };
  await fs.writeFile(path.join(root, 'current.json'), JSON.stringify({ schema_version: 1, manifest: ref }));
  const before = await readJournalLibrary({ root, config });
  const oldMasterBytes = await fs.readFile(path.join(root, legacy.master_list.path), 'utf8');
  const absent = async p => { assert.equal(p.doi, '10.9999/research'); throw Object.assign(new Error('absent'), { code: 'NOT_FOUND' }); };
  const result = await runMetadataRepair(config, { root, sources: { crossref: absent, openalex: absent, semanticscholar: absent, publisherArticle: absent },
    search: async () => ({ called: true, result: { leads: [] } }), maxAbstracts: 10, retryMissingAbstractsNow: true,
    now: () => new Date('2026-09-18T01:00:00.000Z') });
  assert.equal(result.stats.papers_checked, 1); assert.equal(result.stats.abstracts_filled, 0);
  const after = await readJournalLibrary({ root, config });
  assert.equal(after.manifest.master_policy_version, 6); assert.deepEqual(after.papers, before.papers);
  assert.equal(after.masterList.statistics.missing_abstract, 2);
  assert.ok(Object.values(after.repairState.issues).filter(i => i.paper_id === 'doi:10.9999/board').every(i => i.status === 'resolved' && i.attempt_count === 0));
  assert.equal(await fs.readFile(path.join(root, legacy.master_list.path), 'utf8'), oldMasterBytes);
});
