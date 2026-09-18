import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { paperDocumentType, evidenceWindowStatus } from '../src/services/paperScope.js';
import { buildMasterList } from '../src/services/masterList.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { readJournalLibrary, writeLibraryJson } from '../src/services/journalLibrary.js';
import { reconcileCatalogDiscovery } from '../src/services/catalogDiscoveryRun.js';
import { runIsolatedPilot } from '../scripts/search-pilot.js';
import { emptyRepairState, reconcileRepairState } from '../src/services/repairState.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER'), at = '2026-09-14T01:00:00.000Z';
const scope = (title, others = []) => paperDocumentType({ source_records: [title, ...others].map(title => ({ title, type: 'journal-article' })) });
const record = (title, date, id = 'test') => normalizeSourceRecord({ source: 'crossref', source_id: `10.1257/${id}`, doi: `10.1257/${id}`,
  title, authors: ['Alice Smith'], abstract: '', publication_date: date, last_checked_at: at,
  journal_key: journal.key, journal_name: journal.name, journal_category: journal.category, journal_category_zh: journal.category_zh,
  print_issn: journal.print_issn, electronic_issn: journal.electronic_issn });
const papers = rows => mergePapers(rows, { checkedAt: at, firstSeenDate: '2026-09-14' }).papers;
const options = { generatedAt: at, fromDate: '2026-07-17', toDate: '2026-09-14' };

test('演讲精分：只匹配明确标题前缀，保留记录，不根据缺摘要排除研究论文', () => {
  assert.equal(scope('Nobel Lecture: Creative Destruction and Economic Growth').document_type, 'lecture');
  assert.equal(scope('Presidential Address — A Theory of Prices').research_candidate, false);
  assert.equal(scope('The effects of Nobel lectures on research').document_type, 'research_candidate');
  assert.equal(scope('Economic growth without an abstract').research_candidate, true);
  assert.equal(scope('Correction: Nobel Lecture: Growth').document_type, 'possible_correction');
  assert.equal(scope('Nobel Lecture: Growth', ['Growth']).document_type, 'needs_review');
});

test('精确日只用于范围核对；不改变月份展示、论文原字段或旧版统计', () => {
  const input = papers([record('Nobel Lecture: Innovation', '2026-07-20', 'lecture'), record('Economic growth and trade', '2026-09-09', 'paper')]);
  const saved = JSON.stringify(input), old = buildMasterList(input, options), next = buildMasterList(input, { ...options, policyVersion: 2 });
  assert.equal(old.statistics.research_candidates, 2); assert.equal(old.policy_version, undefined);
  assert.equal(next.statistics.total, 2); assert.equal(next.statistics.research_candidates, 1); assert.equal(next.statistics.lectures, 1);
  assert.equal(next.statistics.research_confirmed_inside_window, 1);
  assert.ok(next.entries.every(e => e.window_status === 'inside'));
  assert.equal(next.entries.find(e => e.doi.endsWith('/paper')).publication_month, '2026-09');
  assert.equal(JSON.stringify(input), saved); assert.throws(() => buildMasterList(input, { ...options, policyVersion: 99 }));
});

test('窗口边界：保留月精度/年精度不确定；真实窗口外日不算漏收；矛盾日不武断取一个', () => {
  const rows = papers([record('Month only study', '2026-07', 'month'), record('Year only study', '2026', 'year'),
    record('Early paper outside window', '2026-07-01', 'outside')]);
  const master = buildMasterList(rows, { ...options, policyVersion: 2 });
  assert.equal(master.entries.find(e => e.doi.endsWith('/month')).window_status, 'boundary_uncertain');
  assert.equal(master.entries.find(e => e.doi.endsWith('/year')).window_status, 'unknown');
  assert.equal(master.entries.find(e => e.doi.endsWith('/outside')).window_status, 'outside');
  const pub = values => ({ publication_conflict: false, publication_evidence: values.map(value => ({ value })) });
  assert.equal(evidenceWindowStatus(pub(['2026-07-01', '2026-07-20']), options.fromDate, options.toDate, 'inside'), 'boundary_uncertain');
  assert.equal(evidenceWindowStatus(pub(['2026-07-20', '2026-07-21']), options.fromDate, options.toDate, 'unknown'), 'inside');
  assert.equal(evidenceWindowStatus({ ...pub(['2026-07-20']), publication_conflict: true }, options.fromDate, options.toDate, 'inside'), 'unknown');
});

test('官网新发现统计：演讲、边界研究候选、确定窗口内研究论文分开，记录均保留', () => {
  const leads = [['Nobel Lecture: Growth', '2026-08'], ['Month-only economic study', '2026-07'], ['Confirmed trade study', '2026-08']].map(([title, date], i) => {
    const url = `https://www.aeaweb.org/articles?id=10.1257/scope${i}`;
    return { title, date, doi: `10.1257/scope${i}`, authors: ['Alice Smith'], abstract: '', url, journal_confirmed: true,
      evidence: { url, scope_url: 'https://www.aeaweb.org/issues/123', method: 'article_without_abstract', fetched_at: at, body_sha256: 'a'.repeat(64) } };
  });
  const result = reconcileCatalogDiscovery({ leads }, journal, [], { fromDate: options.fromDate, toDate: options.toDate }, { checkedAt: at, runDate: '2026-09-14' });
  assert.equal(result.papers.length, 3); assert.equal(result.report.added_count, 3);
  assert.equal(result.report.added_lectures, 1); assert.equal(result.report.added_research_confirmed_in_window, 1);
  assert.equal(result.report.added_research_uncertain_window, 1);
});

test('历史版本兼容：按v1读取旧总名册，新写入采用当前规则，不改旧论文或引用文件', async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'scope-history-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('scope-history-')); await fs.rm(root, { recursive: true, force: true }); });
  const rs = [record('Nobel Lecture: Growth', '2026-09-01')];
  const clients = Object.fromEntries(['crossref', 'openalex'].map(source => [source, async () => ({ source, journal_key: 'AER', ok: true, complete: true,
    records: source === 'crossref' ? rs : [], raw_pages: [], raw_count: source === 'crossref' ? 1 : 0, rejected: [], duration_ms: 0, error: null })]));
  await runJournalCollection(config, { root, journalKey: 'AER', clients, now: () => new Date(at) });
  const initial = await readJournalLibrary({ root, config });
  const prefix = `snapshots/${initial.manifest.run_id}`;
  const legacy = { ...initial.manifest }; delete legacy.master_policy_version;
  const legacyMaster = buildMasterList(initial.papers, { generatedAt: legacy.created_at,
    fromDate: initial.masterList.from_date, toDate: initial.masterList.to_date, policyVersion: 1 });
  legacy.master_list = await writeLibraryJson(root, `${prefix}/legacy-master-list.json`, legacyMaster);
  legacy.repair_state = await writeLibraryJson(root, `${prefix}/legacy-repair-state.json`, reconcileRepairState(emptyRepairState(), legacyMaster));
  // Construct a pre-upgrade fixture only in this fresh temp test directory.
  const legacyText = JSON.stringify(legacy);
  await fs.writeFile(path.join(root, `${prefix}/manifest.json`), legacyText);
  const legacyRef = { path: `${prefix}/manifest.json`, sha256: createHash('sha256').update(legacyText).digest('hex') };
  await fs.writeFile(path.join(root, 'current.json'), JSON.stringify({ schema_version: 1, manifest: legacyRef }));
  const before = await readJournalLibrary({ root, config });
  assert.equal(before.masterList.statistics.research_candidates, 1); assert.equal(before.masterList.policy_version, undefined);
  const legacyBytes = await fs.readFile(path.join(root, legacy.master_list.path), 'utf8');
  await runJournalCollection(config, { root, journalKey: 'AER', clients, now: () => new Date('2026-09-15T01:00:00Z') });
  const after = await readJournalLibrary({ root, config });
  assert.equal(after.manifest.master_policy_version, 7); assert.equal(after.masterList.statistics.research_candidates, 0);
  assert.equal(after.masterList.statistics.lectures, 1); assert.equal(after.papers[0].discovered_at, before.papers[0].discovered_at);
  assert.equal(await fs.readFile(path.join(root, legacy.master_list.path), 'utf8'), legacyBytes);
});

test('扩展试跑只允许审核过的单刊，未知期刊在任何文件复制或联网前拒绝', async () => {
  await assert.rejects(runIsolatedPilot(config, { journalKey: 'ALL', repositoryRoot: '/must-not-read' }));
});
