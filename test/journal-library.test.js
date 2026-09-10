import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { collectJournals } from '../src/services/collectJournals.js';
import { classifySourceRecord } from '../src/services/paperClassification.js';
import { validatePapers, validateRuns, validateHistoryPreserved } from '../src/services/libraryValidation.js';
import { collectionWindow, runJournalCollection, alreadyCoveredToday, safeRunError } from '../src/services/journalRun.js';
import { readJournalLibrary, readLibraryRef, withLibraryLock, libraryPath } from '../src/services/journalLibrary.js';
import { parseLibraryArgs, runLibraryCommand } from '../scripts/journal-library.js';

const config = await loadJournalConfig();
const journal = findJournal(config, 'AER');
const at = '2026-09-07T01:00:00.000Z';
const fixed = (value = at) => () => new Date(value);
function record(source = 'openalex', overrides = {}) {
  return normalizeSourceRecord({ source, source_id: source === 'openalex' ? 'W1' : '10.1234/test',
    doi: '10.1234/test', title: 'Credit markets and firms', abstract: '',
    authors: [{ name: 'Alice Smith', orcid: '' }], journal_key: journal.key, journal_name: journal.name,
    journal_category: journal.category, journal_category_zh: journal.category_zh,
    print_issn: journal.print_issn, electronic_issn: journal.electronic_issn,
    publication_date: '2026-08-01', last_checked_at: at, ...overrides });
}
function clients(oa = [record()], cr = [record('crossref')], { failed = [], calls = [] } = {}) {
  return Object.fromEntries(['openalex', 'crossref'].map((source) => [source, async (j, options) => {
    calls.push({ source, journal_key: j.key, fromDate: options.fromDate, toDate: options.toDate });
    const ok = !failed.includes(source);
    const records = (ok ? source === 'openalex' ? oa : cr : []).map((row) => ({ ...row, last_checked_at: options.checkedAt }));
    return { source, journal_key: j.key, ok, complete: ok, records,
      raw_pages: ok ? [{ fixture: true, items: records }] : [], rejected: [], raw_count: records.length, duration_ms: 1,
      error: ok ? null : { code: 'HTTP_ERROR', message: 'should-not-log-secret-body', stack: 'private stack' } };
  }]));
}
async function fixture(t) {
  const tempParent = path.resolve(os.tmpdir());
  const tempRoot = await fs.mkdtemp(path.join(tempParent, 'paper-library-test-'));
  t.after(async () => {
    // Test cleanup is limited to this exact, freshly created temporary directory.
    const resolved = path.resolve(tempRoot);
    assert.equal(path.dirname(resolved), tempParent);
    assert.ok(path.basename(resolved).startsWith('paper-library-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root: path.join(tempRoot, 'library') };
}
const run = (root, options = {}) => runJournalCollection(config, { root, journalKey: 'AER', now: fixed(), clients: clients(), ...options });
const read = (root) => readJournalLibrary({ root, config });
const pointerText = (root) => fs.readFile(path.join(root, 'current.json'), 'utf8');
const basePapers = () => mergePapers([record(), record('crossref')], { firstSeenDate: '2026-09-07', checkedAt: at }).papers;

test('行政资料精确排除，缺摘要研究候选和相似标题不误删', () => {
  for (const title of ['Front Matter', '<p>Table of Contents</p>', 'Cover', 'Editorial Board', 'Index to Volume 116']) {
    assert.equal(classifySourceRecord(record('openalex', { title })).excluded, true);
  }
  for (const title of ['The Front Matter Effect', 'Cover and Credit Risk', 'Retraction Risk and Investment', 'Credit markets']) {
    assert.equal(classifySourceRecord(record('openalex', { title })).excluded, false);
  }
  assert.equal(classifySourceRecord(record('openalex', { title: 'Correction to: Credit markets' })).kind, 'possible_correction');
  assert.equal(classifySourceRecord(record('openalex', { title: 'Retraction: Credit markets' })).kind, 'possible_retraction');
});

test('新采集规则排除明确期刊信息，原始页与排除理由仍持久保存', async (t) => {
  const { root } = await fixture(t);
  const result = await run(root, { clients: clients([record('openalex', { title: 'Issue Information' })], []) });
  assert.equal(result.committed, true); assert.equal(result.papers.length, 0);
  const saved = await read(root);
  assert.equal(saved.audit.excluded.length, 1); assert.equal(saved.audit.excluded[0].classification.version, 2);
  assert.ok(saved.manifest.raw.length === 2);
  assert.equal((await readLibraryRef(root, saved.manifest.raw[0])).pages[0].items[0].title, 'Issue Information');
});

test('旧版库中已有的期刊资料不因新规则消失，也不破坏完整翻译队列的校验', async (t) => {
  const { root } = await fixture(t);
  // Reproduce an older collector that retained this title, using only the private test library.
  const legacyCollect = async (_config, options) => {
    const source_results = [];
    for (const source of ['openalex', 'crossref']) {
      const value = await options.clients[source](journal, options);
      await options.onSourceResult(value); source_results.push(value);
    }
    return { ...mergePapers(source_results.flatMap((value) => value.records), options),
      status: 'success', source_results, excluded: [], notices: [] };
  };
  const records = clients([record('openalex', { title: 'Issue Information' })], []);
  await run(root, { clients: records, collect: legacyCollect });
  const first = await read(root), original = structuredClone(first.papers[0]);
  assert.equal(first.queue.field_count, 1);
  const next = await run(root, { clients: records });
  const saved = await read(root);
  assert.equal(next.status, 'no_updates'); assert.equal(saved.papers.length, 1);
  assert.deepEqual(saved.papers[0], original); assert.deepEqual(saved.queue, first.queue);
  assert.equal(saved.audit.excluded.length, 1);
});

test('默认60天含北京时间今天，支持跨年、闰年和单日', () => {
  assert.deepEqual(collectionWindow({ now: new Date(at) }), { fromDate: '2026-07-10', toDate: '2026-09-07' });
  assert.deepEqual(collectionWindow({ now: new Date('2025-12-31T16:00:00Z'), lookbackDays: 2 }),
    { fromDate: '2025-12-31', toDate: '2026-01-01' });
  assert.deepEqual(collectionWindow({ now: new Date('2024-03-01T01:00:00Z'), lookbackDays: 2 }),
    { fromDate: '2024-02-29', toDate: '2024-03-01' });
  assert.equal(collectionWindow({ now: new Date(at), lookbackDays: 1 }).fromDate, '2026-09-07');
  assert.throws(() => collectionWindow({ lookbackDays: 0 }));
  assert.throws(() => collectionWindow({ fromDate: '2026-02-30', toDate: '2026-03-01' }));
});

test('正式结构拒绝重复ID、错刊、坏哈希、假日期和无正文的完成译文', () => {
  assert.doesNotThrow(() => validatePapers(basePapers(), config));
  assert.throws(() => validatePapers([...basePapers(), ...basePapers()], config));
  for (const patch of [{ journal_name: 'Wrong journal' }, { first_seen_date: '2026-02-30' },
    { source_text_hash: { title: 'bad', abstract: '' } }, { title_translation_status: 'done' }, { unexpected_secret: 'not allowed' }]) {
    assert.throws(() => validatePapers([{ ...basePapers()[0], ...patch }], config));
  }
});

test('历史保护拒绝删除、移动首次发现日、清空已有译文或丢失来源原文', () => {
  const original = basePapers(); original[0].title_zh = '已有译文';
  assert.throws(() => validateHistoryPreserved(original, []));
  for (const patch of [{ first_seen_date: '2026-09-08' }, { title_zh: '' }, { source_records: original[0].source_records.slice(0, 1) }]) {
    assert.throws(() => validateHistoryPreserved(original, [{ ...original[0], ...patch }]));
  }
});

test('首次保存：先暂存双源原始页，再生成按年论文、按月日志和可重读版本', async (t) => {
  const { root } = await fixture(t);
  const result = await run(root, { beforePublish: async ({ manifest }) => {
    assert.equal(manifest.raw.length, 2);
    for (const ref of manifest.raw) assert.equal((await readLibraryRef(root, ref)).pages.length, 1);
    await assert.rejects(fs.stat(path.join(root, 'current.json')), { code: 'ENOENT' });
  } });
  assert.equal(result.status, 'success'); assert.equal(result.committed, true);
  const restarted = await read(root);
  assert.equal(restarted.papers.length, 1); assert.equal(restarted.runs.length, 1);
  assert.deepEqual(Object.keys(restarted.manifest.papers), ['2026']);
  assert.deepEqual(Object.keys(restarted.manifest.runs), ['2026-09']);
  assert.equal(restarted.runs[0].sources.length, 2);
  assert.equal(restarted.papers[0].first_seen_date, '2026-09-07');
  await assert.rejects(fs.stat(path.join(root, 'writer.lock')), { code: 'ENOENT' });
});

test('同日重复保存只有一篇，两条独立运行日志，不重复计待翻译字段', async (t) => {
  const { root } = await fixture(t); await run(root);
  const second = await run(root, { now: fixed('2026-09-07T02:00:00Z') });
  assert.equal(second.status, 'no_updates');
  assert.deepEqual(second.stats, { added: 0, updated: 0, unchanged: 1, new_pending_fields: 0 });
  const saved = await read(root);
  assert.equal(saved.papers.length, 1); assert.equal(saved.runs.length, 2);
  assert.equal(saved.papers[0].source_records.length, 2);
});

test('次日补摘要更新原文状态，不移动日历日期，旧快照仍存在', async (t) => {
  const { root } = await fixture(t); await run(root);
  const previous = await read(root);
  const second = await run(root, { now: fixed('2026-09-08T01:00:00Z'),
    clients: clients([record()], [record('crossref', { abstract: 'Credit constraints affect firms.' })]) });
  assert.equal(second.stats.added, 0); assert.equal(second.stats.updated, 1);
  assert.equal(second.stats.new_pending_fields, 1);
  assert.equal(second.papers[0].first_seen_date, '2026-09-07');
  assert.equal(second.papers[0].abstract_translation_status, 'pending');
  const oldRows = await readLibraryRef(root, previous.manifest.papers['2026']);
  assert.equal(oldRows[0].abstract_original, '');
  assert.equal((await read(root)).papers[0].abstract_original, 'Credit constraints affect firms.');
});

test('跨年按首次发现年份归档；超过60天的历史不删除，未改年度复用旧文件', async (t) => {
  const { root } = await fixture(t);
  await run(root, { now: fixed('2025-12-31T01:00:00Z'), clients: clients([record('openalex', { publication_date: '2024-01-01' })], []) });
  const old = await read(root);
  await run(root, { now: fixed('2026-09-07T01:00:00Z'), clients: clients([
    record('openalex', { source_id: 'W2', doi: '10.1234/new', title: 'Another paper' })], []) });
  const saved = await read(root);
  assert.deepEqual(Object.keys(saved.manifest.papers), ['2025', '2026']);
  assert.equal(saved.papers.length, 2);
  assert.deepEqual(saved.manifest.papers['2025'], old.manifest.papers['2025']);
  assert.deepEqual(Object.keys(saved.manifest.runs), ['2025-12', '2026-09']);
});

test('单源失败保留可用论文，保存partial_failure，日志不包含远程正文或堆栈', async (t) => {
  const { root } = await fixture(t);
  const result = await run(root, { clients: clients([record()], [], { failed: ['crossref'] }) });
  assert.equal(result.status, 'partial_failure');
  const saved = await read(root);
  assert.equal(saved.papers.length, 1);
  assert.equal(saved.runs[0].status, 'partial_failure');
  assert.ok(!JSON.stringify(saved.runs).includes('should-not-log-secret-body'));
  assert.ok(!JSON.stringify(saved.runs).includes('private stack'));
});

test('双源均失败只追加失败日志，不重写或清空已有论文文件', async (t) => {
  const { root } = await fixture(t); await run(root);
  const old = await read(root);
  const failed = await run(root, { clients: clients([], [], { failed: ['openalex', 'crossref'] }) });
  assert.equal(failed.status, 'full_failure');
  const saved = await read(root);
  assert.deepEqual(saved.papers, old.papers);
  assert.deepEqual(saved.manifest.papers, old.manifest.papers);
  assert.equal(saved.runs.length, 2);
});

test('Front Matter不进论文库或待翻译计数，排除理由与原始页可查', async (t) => {
  const { root } = await fixture(t);
  const result = await run(root, { clients: clients([], [record('crossref', { title: 'Front Matter' })]) });
  assert.equal(result.status, 'no_updates'); assert.equal(result.stats.new_pending_fields, 0);
  const saved = await read(root);
  assert.equal(saved.papers.length, 0); assert.equal(saved.audit.excluded.length, 1);
  assert.equal(saved.runs[0].sources.find((s) => s.source === 'crossref').excluded_count, 1);
  assert.equal(saved.audit.excluded[0].classification.rule, 'exact_administrative_title');
});

test('DOI冲突和更正撤稿提示保留供审查，不自动删除或合并', async (t) => {
  const { root } = await fixture(t);
  await run(root, { clients: clients([record(), record('openalex', { source_id: 'W2', doi: '10.1234/notice', title: 'Retraction: An earlier paper' })],
    [record('crossref', { source_id: '10.1234/conflict', doi: '10.1234/conflict' })]) });
  const saved = await read(root);
  assert.equal(saved.papers.length, 3);
  assert.equal(saved.audit.notices.length, 1);
  assert.ok(saved.audit.duplicates.some((entry) => entry.type === 'doi_conflict'));
});

test('合并后的新数据校验失败时，整轮新论文不采用但失败日志可保存', async (t) => {
  const { root } = await fixture(t); await run(root);
  const previous = await read(root);
  const failed = await run(root, { collect: async (cfg, options) => {
    const result = await collectJournals(cfg, options);
    result.papers[0].source_text_hash.title = 'bad'; return result;
  } });
  assert.equal(failed.status, 'full_failure'); assert.equal(failed.run.error.code, 'VALIDATION_ERROR');
  assert.deepEqual((await read(root)).papers, previous.papers);
});

test('错误采集器试图删除旧论文会被拦截', async (t) => {
  const { root } = await fixture(t); await run(root);
  const failed = await run(root, { collect: async (cfg, options) => {
    const result = await collectJournals(cfg, options); result.papers = []; return result;
  } });
  assert.equal(failed.status, 'full_failure'); assert.equal((await read(root)).papers.length, 1);
});

test('历史文件损坏时停止联网和写正式库，不把损坏库当成空库', async (t) => {
  const { root } = await fixture(t); await run(root);
  const old = await read(root), pointer = await pointerText(root);
  await fs.writeFile(path.join(root, old.manifest.papers['2026'].path), '{broken');
  await assert.rejects(read(root), { code: 'CORRUPT_LIBRARY' });
  let calls = 0;
  await assert.rejects(run(root, { collect: async () => { calls++; } }), { code: 'CORRUPT_LIBRARY' });
  assert.equal(calls, 0); assert.equal(await pointerText(root), pointer);
  const attempts = await fs.readdir(path.join(root, 'attempts'));
  assert.equal(attempts.length, 2);
});

test('年度文件缺失被判损坏，当前指针缺失但仍有版本时禁止重新建空库', async (t) => {
  const { root } = await fixture(t); await run(root);
  const old = await read(root);
  await fs.unlink(path.join(root, old.manifest.papers['2026'].path));
  await assert.rejects(read(root), { code: 'CORRUPT_LIBRARY' });
  await fs.unlink(path.join(root, 'current.json'));
  await assert.rejects(read(root), { code: 'MISSING_POINTER' });
});

test('切换前模拟中断：旧指针和整套旧数据保持可用，诊断另存', async (t) => {
  const { root } = await fixture(t); await run(root);
  const old = await read(root), pointer = await pointerText(root);
  await assert.rejects(run(root, { now: fixed('2026-09-08T01:00:00Z'), beforePublish: async ({ manifest }) => {
    assert.equal(manifest.raw.length, 2);
    assert.deepEqual((await read(root)).papers, old.papers);
    throw new Error('simulated process interruption');
  } }), { code: 'STORAGE_ERROR' });
  assert.equal(await pointerText(root), pointer);
  assert.deepEqual((await read(root)).runs, old.runs);
  const attempts = await fs.readdir(path.join(root, 'attempts'));
  const failedId = attempts.find((id) => id !== old.manifest.run_id);
  const diagnostic = JSON.parse(await fs.readFile(path.join(root, 'attempts', failedId, 'failed.json'), 'utf8'));
  assert.equal(diagnostic.status, 'full_failure');
  // A later retry can proceed using the old committed version; staged leftovers are not adopted.
  assert.equal((await run(root)).status, 'no_updates');
});

test('同时更新两个年度时中断，不会只更新一半年度', async (t) => {
  const { root } = await fixture(t);
  await run(root, { now: fixed('2025-12-31T01:00:00Z') });
  const pointer = await pointerText(root);
  await assert.rejects(run(root, { clients: clients([
    record('openalex', { abstract: 'A new abstract.' }),
    record('openalex', { source_id: 'W2', doi: '10.1234/new', title: 'New study' })], []),
    beforePublish: async ({ manifest }) => {
      assert.equal(Object.keys(manifest.papers).length, 2); throw new Error('interrupt');
    } }));
  assert.equal(await pointerText(root), pointer);
  const saved = await read(root); assert.equal(saved.papers.length, 1);
  assert.equal(saved.papers[0].abstract_original, '');
});

test('新版本暂存文件被改坏时，磁盘回读校验拦截切换', async (t) => {
  const { root } = await fixture(t); await run(root);
  const pointer = await pointerText(root);
  await assert.rejects(run(root, { now: fixed('2026-09-08T01:00:00Z'), beforePublish: async ({ manifest }) => {
    await fs.writeFile(path.join(root, manifest.papers['2026'].path), '[]');
  } }), { code: 'CORRUPT_LIBRARY' });
  assert.equal(await pointerText(root), pointer); assert.equal((await read(root)).papers.length, 1);
});

test('指针临时文件无法写入时，绝不先删掉旧current.json', async (t) => {
  const { root } = await fixture(t); await run(root); const pointer = await pointerText(root);
  await assert.rejects(run(root, { beforePublish: async ({ manifest }) => {
    await fs.mkdir(path.join(root, `current-${manifest.run_id}.tmp`));
  } }), { code: 'STORAGE_ERROR' });
  assert.equal(await pointerText(root), pointer); assert.equal((await read(root)).papers.length, 1);
});

test('并发写锁拒绝第二位写入者，抛错后释放自己的锁', async (t) => {
  const { root } = await fixture(t);
  await withLibraryLock(root, async () => {
    await assert.rejects(run(root), { code: 'LIBRARY_LOCKED' });
  });
  await assert.rejects(withLibraryLock(root, async () => { throw new Error('test interruption'); }));
  await assert.rejects(fs.stat(path.join(root, 'writer.lock')), { code: 'ENOENT' });
  assert.equal((await run(root)).status, 'success');
});

test('补跑模式同日成功且覆盖范围才跳过，不再联网或新增正式日志', async (t) => {
  const { root } = await fixture(t); await run(root);
  const pointer = await pointerText(root), calls = [];
  const result = await run(root, { onlyIfNeeded: true, clients: clients([], [], { calls }) });
  assert.equal(result.status, 'skipped'); assert.equal(calls.length, 0);
  assert.equal(await pointerText(root), pointer); assert.equal((await read(root)).runs.length, 1);
  const previous = await read(root);
  assert.equal(alreadyCoveredToday(previous.runs, { runDate: '2026-09-07', journalKeys: ['AER', 'JAR'],
    fromDate: '2026-07-10', toDate: '2026-09-07' }), false);
  assert.equal(alreadyCoveredToday(previous.runs, { runDate: '2026-09-07', journalKeys: ['AER'],
    fromDate: '2025-01-01', toDate: '2026-09-07' }), false);
});

test('部分失败不触发补跑跳过；次日也必须再查', async (t) => {
  const { root } = await fixture(t);
  await run(root, { clients: clients([], [], { failed: ['crossref'] }) });
  const calls = [];
  assert.notEqual((await run(root, { onlyIfNeeded: true, clients: clients([], [], { calls }) })).status, 'skipped');
  assert.equal(calls.length, 2);
  assert.notEqual((await run(root, { onlyIfNeeded: true, now: fixed('2026-09-08T01:00:00Z') })).status, 'skipped');
});

test('实际双时段全19刊日程：上午完整成功后下午不再请求来源，次日滚动60天重新采集', async (t) => {
  const { root } = await fixture(t), morningCalls = [];
  const morning = await run(root, { journalKey: undefined, onlyIfNeeded: true,
    now: fixed('2026-09-10T00:17:00Z'), clients: clients([], [], { calls: morningCalls }) });
  assert.equal(morning.status, 'no_updates'); assert.equal(morningCalls.length, 38);
  assert.equal(morning.run.run_date, '2026-09-10');
  assert.equal(morning.run.from_date, '2026-07-13'); assert.equal(morning.run.to_date, '2026-09-10');
  const pointer = await pointerText(root), afternoonCalls = [];
  const afternoon = await run(root, { journalKey: undefined, onlyIfNeeded: true,
    now: fixed('2026-09-10T05:17:00Z'), clients: clients([], [], { calls: afternoonCalls }) });
  assert.equal(afternoon.status, 'skipped'); assert.equal(afternoonCalls.length, 0);
  assert.equal(await pointerText(root), pointer); assert.equal((await read(root)).runs.length, 1);
  const nextDayCalls = [];
  const nextDay = await run(root, { journalKey: undefined, onlyIfNeeded: true,
    now: fixed('2026-09-11T00:17:00Z'), clients: clients([], [], { calls: nextDayCalls }) });
  assert.equal(nextDay.status, 'no_updates'); assert.equal(nextDayCalls.length, 38);
  assert.equal(nextDay.run.run_date, '2026-09-11');
  assert.equal(nextDay.run.from_date, '2026-07-14'); assert.equal(nextDay.run.to_date, '2026-09-11');
  assert.equal((await read(root)).runs.length, 2);
});

test('只读查询空库不创建任何数据目录', async (t) => {
  const { root } = await fixture(t);
  assert.equal((await read(root)).papers.length, 0);
  await assert.rejects(fs.stat(root), { code: 'ENOENT' });
});

test('文件引用拒绝上级目录、绝对路径、反斜杠和Windows替代数据流', async (t) => {
  const { root } = await fixture(t);
  for (const relative of ['../outside.json', '/outside.json', 'C:/outside.json', 'a/../../outside', 'a\\outside', 'file.json:secret']) {
    await assert.rejects(libraryPath(root, relative));
  }
  await assert.rejects(readLibraryRef(root, { path: 'outside.json', sha256: 'a'.repeat(64) }));
});

test('成功日志必须具备完整双源证据；错误摘要不复述原始错误', async (t) => {
  const { root } = await fixture(t); const saved = await run(root);
  assert.throws(() => validateRuns([{ ...saved.run, sources: [] }]));
  assert.throws(() => validateRuns([{ ...saved.run, status: 'no_updates' }]));
  assert.ok(!JSON.stringify(safeRunError(new Error('secret-token-and-stack'))).includes('secret-token'));
});

test('第三阶段命令默认帮助，写库要明确save并指定期刊范围', () => {
  assert.deepEqual(parseLibraryArgs([]), { mode: 'help' });
  assert.deepEqual(parseLibraryArgs(['--status']), { mode: 'status' });
  assert.throws(() => parseLibraryArgs(['--collect', '--journal', 'AER']), /save/);
  assert.throws(() => parseLibraryArgs(['--collect', '--save']), /期刊/);
  assert.throws(() => parseLibraryArgs(['--status', '--save']), /只读/);
  assert.throws(() => parseLibraryArgs(['--collect', '--save', '--all', '--from', '2026-01-01', '--to', '2026-02-01', '--lookback-days', '60']), /同时/);
  assert.equal(parseLibraryArgs(['--collect', '--save', '--all']).lookbackDays, 60);
});

test('状态命令不会触发写库；部分失败的保存命令退出码为1', async () => {
  const logs = [];
  assert.equal(await runLibraryCommand(['--status'], { log: (line) => logs.push(line),
    read: async () => ({ papers: [], runs: [], pointer: null }), run: async () => { throw new Error('不得写库'); } }), 0);
  assert.equal(JSON.parse(logs[0]).initialized, false);
  assert.equal(await runLibraryCommand(['--collect', '--save', '--journal', 'AER'], { log: () => {},
    run: async () => ({ status: 'partial_failure', committed: true, papers: [] }) }), 1);
});

test('来源结构被破坏或元数据出处被篡改时不能通过正式校验', () => {
  const brokenSource = basePapers(); brokenSource[0].source_records[0].authors = 'not-an-array';
  assert.throws(() => validatePapers(brokenSource, config));
  const fakeDate = basePapers(); fakeDate[0].publication_date = '2026-09-01';
  assert.throws(() => validatePapers(fakeDate, config));
});

test('终止真实子进程后：旧库仍可读取，残留写锁阻止自动抢占', async (t) => {
  const { root } = await fixture(t); await run(root);
  const pointer = await pointerText(root);
  const runModule = new URL('../src/services/journalRun.js', import.meta.url).href;
  const configModule = new URL('../src/services/journals.js', import.meta.url).href;
  const script = `
    import { runJournalCollection } from ${JSON.stringify(runModule)};
    import { loadJournalConfig } from ${JSON.stringify(configModule)};
    const clients = Object.fromEntries(['openalex', 'crossref'].map(source => [source, async journal => ({
      source, journal_key: journal.key, ok: true, complete: true, records: [], raw_pages: [], rejected: [],
      raw_count: 0, duration_ms: 0, error: null
    })]));
    await runJournalCollection(await loadJournalConfig(), { root: process.argv[1], journalKey: 'AER', clients,
      beforePublish: async () => {
        process.stdout.write('STAGED');
        await new Promise(() => setInterval(() => {}, 1000));
      }
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not reach staging within 10 seconds')), 10000);
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('STAGED')) { clearTimeout(timer); resolve(); } });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', () => { if (!output.includes('STAGED')) { clearTimeout(timer); reject(new Error('child exited before staging')); } });
    });
    child.kill('SIGTERM'); await exited;
    assert.equal(await pointerText(root), pointer);
    assert.equal((await read(root)).papers.length, 1);
    assert.ok((await fs.stat(path.join(root, 'writer.lock'))).isFile());
    await assert.rejects(run(root), { code: 'LIBRARY_LOCKED' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});

test('只完成一本期刊不能跳过全19刊补跑，38份来源明细完整保存', async (t) => {
  const { root } = await fixture(t); await run(root);
  const calls = [];
  const result = await run(root, { journalKey: undefined, onlyIfNeeded: true, clients: clients([], [], { calls }) });
  assert.equal(result.status, 'no_updates'); assert.equal(calls.length, 38);
  const saved = await read(root);
  const log = saved.runs.find((entry) => entry.run_id === result.run_id);
  assert.equal(log.journal_keys.length, 19); assert.equal(log.sources.length, 38);
  assert.equal(saved.manifest.raw.length, 38); assert.equal(saved.papers.length, 1);
});
