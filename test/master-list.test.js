import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { buildMasterList, publicationFor, publicationWindowStatus, discoverySourcesFor, officialDiscoveries } from '../src/services/masterList.js';
import { reconcileRepairState, emptyRepairState, validateRepairState, dueRepairIssues, recordRepairAttempt, repairSummary } from '../src/services/repairState.js';
import { validatePapers, validateHistoryPreserved, validateRuns } from '../src/services/libraryValidation.js';
import { runJournalCollection, alreadyCoveredToday } from '../src/services/journalRun.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { journalGitFiles } from '../src/services/journalGitFiles.js';
import { runMasterCommand, parseMasterArgs } from '../scripts/master-list.js';
import { runLibraryCommand } from '../scripts/journal-library.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER');
const at = '2026-09-12T01:00:00.000Z', tomorrow = '2026-09-13T01:00:00.000Z';
const proof = method => ({ method, url: 'https://api.semanticscholar.org/graph/v1/paper/search/bulk', scope_url: 'https://api.semanticscholar.org/graph/v1/paper/search/bulk', fetched_at: at, body_sha256: 'a'.repeat(64) });
function record(source = 'crossref', patch = {}) {
  return normalizeSourceRecord({ source, source_id: source === 'crossref' ? '10.1234/master' : source === 'openalex' ? 'W123' : 'b'.repeat(40),
    doi: '10.1234/master', title: 'Credit markets and investment', authors: [{ name: 'Alice Smith' }], abstract: '',
    journal_key: journal.key, journal_name: journal.name, journal_category: journal.category, journal_category_zh: journal.category_zh,
    print_issn: journal.print_issn, electronic_issn: journal.electronic_issn, publication_date: '2026-08-21', last_checked_at: at,
    ...(['publisher', 'semanticscholar'].includes(source) ? { source_evidence: proof(`${source}_discovery_api`) } : {}), ...patch });
}
const papers = (records = [record()], previous = [], time = at) => mergePapers(records, { existingPapers: previous, checkedAt: time, firstSeenDate: time.slice(0, 10) }).papers;
const master = (rows = papers(), time = at, extra = {}) => buildMasterList(rows, { generatedAt: time, fromDate: '2026-07-15', toDate: '2026-09-12', ...extra });
const initial = rows => reconcileRepairState(emptyRepairState(), master(rows));
const client = (source, records, failed = false) => async () => ({ source, journal_key: 'AER', records, ok: !failed, complete: !failed,
  raw_count: records.length, rejected: [], raw_pages: [{ records }], duration_ms: 0, error: failed ? { code: 'HTTP_ERROR' } : null });
const clients = (third = [], failThird = false) => ({ crossref: client('crossref', [record()]), openalex: client('openalex', [record('openalex')]),
  semanticscholar: client('semanticscholar', third, failThird) });
async function fixture(t) {
  const parent = path.resolve(os.tmpdir()), workspace = await fs.mkdtemp(path.join(parent, 'paper-master-test-'));
  t.after(async () => { const resolved = path.resolve(workspace); assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('paper-master-test-')); await fs.rm(resolved, { recursive: true, force: true }); });
  return { workspace, root: path.join(workspace, 'data/journal-store') };
}
const save = (root, extra = {}) => runJournalCollection(config, { root, now: () => new Date(at), journalKey: 'AER', clients: clients(), ...extra });

test('总名册：nullable DOI与月份、原始摘要空缺、首次发现时间均保真', () => {
  const p = papers([record('crossref', { doi: '', authors: [], publication_date: '2026' })]);
  const row = master(p).entries[0];
  assert.equal(row.doi, null); assert.equal(row.doi_status, 'no_doi_yet');
  assert.equal(row.publication_year, 2026); assert.equal(row.publication_month, null); assert.equal(row.abstract, null);
  assert.equal(row.discovered_at, at); assert.equal(row.identity_status, 'candidate');
  assert.equal(row.window_status, 'unknown'); assert.equal(p.length, 1); validatePapers(p, config);
});

test('总名册：旧数据仅有发现日时不虚构时分秒，再采集也不改写历史', () => {
  const old = papers(); delete old[0].discovered_at;
  const next = papers([record()], old, tomorrow);
  assert.equal(master(next).entries[0].discovered_at, null);
  assert.equal(master(next).entries[0].discovered_at_precision, 'day');
  validateHistoryPreserved(old, next);
  const precise = papers(); assert.throws(() => validateHistoryPreserved(precise, [{ ...precise[0], discovered_at: tomorrow }]));
});

test('总名册：补DOI保留内部ID、发现时间和已完成的标题翻译', () => {
  const old = papers([record('crossref', { doi: '' })]);
  old[0].title_zh = '信贷市场与投资'; old[0].title_translation_status = 'done';
  const next = papers([record('openalex')], old, tomorrow);
  assert.equal(next.length, 1); assert.equal(next[0].id, old[0].id); assert.equal(next[0].discovered_at, at);
  assert.equal(next[0].title_zh, old[0].title_zh); assert.equal(next[0].title_translation_status, 'done');
  validatePapers(next, config); validateHistoryPreserved(old, next);
});

test('无DOI去重：缺少年份、作者顺序和连字符差异不制造重复论文', () => {
  const a = record('crossref', { doi: '', publication_date: '', title: 'Non-linear credit markets and firm investment', authors: [{ name: 'Alice Smith' }, { name: 'Bob Jones' }] });
  const b = record('openalex', { doi: '', publication_date: '2026', title: 'NONLINEAR CREDIT MARKETS: and firm investment', authors: [{ name: 'Bob Jones' }, { name: 'Alice Smith' }] });
  const rows = papers([a, b]); assert.equal(rows.length, 1); validatePapers(rows, config);
  const uncertain = papers([record('crossref', { doi: '', publication_date: '', authors: [] }), record('openalex', { doi: '', publication_date: '', authors: [] })]);
  assert.equal(uncertain.length, 2); // Title alone must not force an ambiguous merge.
  assert.ok(master(uncertain).entries.every(row => row.conflicts.includes('possible_duplicate')));
  assert.ok(Object.values(initial(uncertain).issues).some(issue => issue.reason === 'possible_duplicate'));
});

test('总名册：独立发现不把DOI摘要补全冒充第三路发现', () => {
  const p = papers([record(), record('openalex', { source_evidence: proof('openalex_api') }),
    record('semanticscholar', { source_evidence: proof('semanticscholar_abstract_api') })])[0];
  assert.deepEqual(discoverySourcesFor(p), ['crossref']);
  assert.deepEqual(master([p]).entries[0].available_sources, ['crossref', 'openalex', 'semanticscholar']);
  const third = papers([record('semanticscholar')], [p])[0];
  assert.deepEqual(discoverySourcesFor(third), ['crossref', 'semanticscholar']);
});

test('总名册：官网清单匹配证据才算官网发现，摘要查页不算', () => {
  const p = papers([record(), record('publisher', { source_evidence: proof('publisher_abstract') })])[0];
  assert.equal(master([p]).entries[0].found_official_site, false);
  const ids = officialDiscoveries([{ journals: [{ entries: [{ status: 'existing', paper_id: p.id }, { status: 'pending', paper_id: 'unknown' }] }] }]);
  assert.equal(master([p], at, { officialIds: ids }).entries[0].found_official_site, true);
  assert.equal(ids.has('unknown'), false);
});

test('总名册：在线月份优先，来源冲突留空，RSS更新时间不是发表月', () => {
  const p = papers([record('crossref', { published_online_date: '2026-07', published_print_date: '2026-09' })])[0];
  assert.equal(publicationFor(p).publication_month, '2026-07');
  const conflict = papers([record('openalex', { published_online_date: '2026-08' })], [p])[0];
  assert.equal(publicationFor(conflict).publication_month, null); assert.equal(publicationFor(conflict).publication_conflict, true);
  const rss = papers([record('publisher', { publication_date: '', raw_dates: { publisher_date: '2026-09-12', date_role: 'feed_update_date' } })])[0];
  assert.equal(publicationFor(rss).publication_month, null);
});

test('总名册：仅在线年份不能被次年纸刊月份替换；月初边界不虚构日期', () => {
  const row = publicationFor(papers([record('crossref', { published_online_date: '2025', published_print_date: '2026-08' })])[0]);
  assert.equal(row.publication_year, 2025); assert.equal(row.publication_month, null);
  assert.equal(publicationWindowStatus({ publication_month: '2026-07' }, '2026-07-15', '2026-09-12'), 'boundary_uncertain');
  assert.equal(publicationWindowStatus({ publication_month: '2026-08' }, '2026-07-15', '2026-09-12'), 'inside');
  assert.equal(publicationWindowStatus({ publication_month: '2026-06' }, '2026-07-15', '2026-09-12'), 'outside');
});

test('总名册：标点大小写差异不是标题冲突，真实差异进入自动身份待办', () => {
  const same = papers([record(), record('openalex', { title: 'CREDIT MARKETS: and investment' })]);
  assert.deepEqual(master(same).entries[0].conflicts, []);
  const conflict = papers([record(), record('openalex', { title: 'Investment and unemployment' })]);
  assert.equal(master(conflict).entries[0].identity_status, 'conflict');
  assert.ok(Object.values(initial(conflict).issues).some(issue => issue.reason === 'title_conflict'));
});

test('总名册：统计区分三源并集、单刊与缺失字段，不能声明完整覆盖', () => {
  const rows = papers([record(), record('openalex'), record('semanticscholar', { doi: '10.1234/second', title: 'A separate paper' })]);
  const list = master(rows);
  assert.equal(list.statistics.total, 2); assert.equal(list.statistics.independent_source_union, 2);
  assert.equal(list.statistics.by_discovery_source.crossref, 1); assert.equal(list.statistics.missing_abstract, 2);
  assert.equal(list.coverage, 'not_proven_complete'); assert.equal(list.journals[0].total, 2);
});

test('自动待办：重复读取不产生新任务，问题数不等于论文数', () => {
  const rows = papers([record('crossref', { doi: '', authors: [], publication_date: '2026' })]);
  const state = initial(rows), next = reconcileRepairState(state, master(rows, tomorrow));
  assert.deepEqual(next, state); assert.equal(repairSummary(state).unresolved_papers, 1);
  assert.equal(repairSummary(state).unresolved_issues, 5); validateRepairState(state, rows);
});

test('自动待办：not_found和quota_exhausted分别重试，额度重置不能猜下月一日', () => {
  const rows = papers(), state = initial(rows), id = Object.keys(state.issues)[0];
  const notFound = recordRepairAttempt(state, id, { source: 'zhipu', status: 'not_found', checkedAt: at });
  assert.equal(notFound.issues[id].next_retry_at, tomorrow);
  assert.ok(!dueRepairIssues(notFound, new Date(at)).some(issue => issue.id === id));
  assert.throws(() => recordRepairAttempt(state, id, { source: 'serpapi_google', status: 'quota_exhausted', checkedAt: at }));
  const exhausted = recordRepairAttempt(state, id, { source: 'serpapi_google', status: 'quota_exhausted', checkedAt: at, quotaResetsAt: '2026-10-12T00:00:00Z' });
  assert.equal(exhausted.issues[id].status, 'quota_exhausted');
  assert.ok(!dueRepairIssues(exhausted, new Date('2026-10-01T00:00:00Z')).some(issue => issue.id === id));
  validateRepairState(exhausted, rows); assert.deepEqual(state, initial(rows));
});

test('自动待办：摘要补齐后只关闭摘要问题，其余已失败任务保留冷却', () => {
  const rows = papers(), state = initial(rows);
  const identity = Object.values(state.issues).find(issue => issue.field === 'identity');
  const tried = recordRepairAttempt(state, identity.id, { source: 'zhipu', status: 'source_unavailable', checkedAt: at });
  const nextRows = papers([record('crossref', { abstract: 'We study firms using published English evidence.', last_checked_at: tomorrow })], rows, tomorrow);
  const next = reconcileRepairState(tried, master(nextRows, tomorrow));
  assert.equal(Object.values(next.issues).find(issue => issue.field === 'abstract').status, 'resolved');
  assert.equal(next.issues[identity.id].status, 'source_unavailable'); validateRepairState(next, nextRows);
});

test('正式库：三源独立执行并集，保存总名册和自动待办且可重新读取', async t => {
  const { root } = await fixture(t), calls = [];
  const all = clients([record('semanticscholar', { doi: '10.1234/new', title: 'Only in Semantic Scholar' })]);
  for (const [source, fn] of Object.entries(all)) all[source] = async (...args) => { calls.push(source); return fn(...args); };
  const result = await save(root, { withSemanticScholar: true, clients: all });
  assert.equal(result.status, 'success'); assert.equal(result.papers.length, 2); assert.equal(calls.length, 3);
  assert.equal(result.run.discovery_summary.union_count, 2);
  assert.equal(result.run.discovery_summary.sources.find(row => row.source === 'semanticscholar').observed_unique_papers, 1);
  const saved = await readJournalLibrary({ root, config });
  assert.ok(saved.manifest.master_list); assert.ok(saved.manifest.repair_state);
  assert.equal(saved.masterList.entries.length, 2); assert.ok(repairSummary(saved.repairState).unresolved_issues > 0);
  validateRuns(saved.runs);
});

test('正式库：第三路失败不阻断原双源，旧双源成功不能冒充三源已完成', async t => {
  const { root } = await fixture(t);
  await save(root);
  const old = await readJournalLibrary({ root, config });
  assert.equal(alreadyCoveredToday(old.runs, { runDate: '2026-09-12', journalKeys: ['AER'], fromDate: '2026-07-15', toDate: '2026-09-12', requiredSources: ['crossref', 'openalex', 'semanticscholar'] }), false);
  const result = await save(root, { onlyIfNeeded: true, withSemanticScholar: true, clients: clients([], true) });
  assert.equal(result.status, 'partial_failure'); assert.equal(result.papers.length, 1);
  assert.equal(result.run.sources.length, 3); assert.equal(result.committed, true);
  assert.equal(result.run.discovery_summary.sources.find(row => row.source === 'semanticscholar').status, 'partial_failure');
});

test('正式库：总名册和待办损坏时拒读，切换前中断保留旧库', async t => {
  const { root } = await fixture(t); await save(root);
  const old = await readJournalLibrary({ root, config }), pointer = await fs.readFile(path.join(root, 'current.json'), 'utf8');
  await assert.rejects(save(root, { beforePublish: async () => { throw new Error('simulated interruption'); } }));
  assert.equal(await fs.readFile(path.join(root, 'current.json'), 'utf8'), pointer);
  const target = path.join(root, old.manifest.master_list.path);
  await fs.writeFile(target, '{}'); await assert.rejects(readJournalLibrary({ root, config }));
});

test('正式库：Git清单包括总名册及待办历史，不包含孤立试验文件', async t => {
  const { root, workspace } = await fixture(t); await save(root);
  const plan = await journalGitFiles(config, { root, repositoryRoot: workspace });
  assert.ok(plan.files.some(file => file.endsWith('/master-list.json')));
  assert.ok(plan.files.some(file => file.endsWith('/repair-state.json')));
});

test('只读总名册命令：输出可供Codex读取，无网络、无写入、无密钥请求', async t => {
  const { root } = await fixture(t); await save(root);
  const before = await fs.readFile(path.join(root, 'current.json'), 'utf8'), logs = [];
  assert.equal(await runMasterCommand(['--unresolved', '--root', root], { log: value => logs.push(value) }), 0);
  const data = JSON.parse(logs[0]); assert.equal(data.manual_review_required, false); assert.ok(data.issue_count > 0);
  assert.equal(await fs.readFile(path.join(root, 'current.json'), 'utf8'), before);
  assert.throws(() => parseMasterArgs(['--status', '--due'])); assert.throws(() => parseMasterArgs(['--run']));
});

test('第三来源密钥只在显式采集模式读取，默认和只读均不取密钥', async () => {
  let reads = 0, received;
  const getSemanticScholarKey = () => { reads++; return 'private-s2-fixture'; };
  const log = () => {};
  await runLibraryCommand([], { log, getSemanticScholarKey });
  await runLibraryCommand(['--status'], { log, getSemanticScholarKey, read: async () => ({ runs: [], papers: [] }) });
  assert.equal(reads, 0);
  const run = async (_config, options) => { received = options; return { status: 'success' }; };
  await runLibraryCommand(['--collect', '--save', '--journal', 'AER', '--with-semantic-scholar'], { log, getSemanticScholarKey, run });
  assert.equal(reads, 1); assert.equal(received.semanticScholarKey, 'private-s2-fixture');
});
