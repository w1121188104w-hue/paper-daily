import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { validatePapers, validateTranslationOnlyChange } from '../src/services/libraryValidation.js';
import { buildTranslationQueue, createTranslationBatch, validateTranslationBatch, translationResponseTemplate } from '../src/services/translationQueue.js';
import { applyTranslationResult, translationQualityError } from '../src/services/translationImport.js';
import { exportTranslationBatch, importTranslationFile, readTranslationJson } from '../src/services/translationWorkflow.js';
import { readJournalLibrary, readLibraryRef, withLibraryLock } from '../src/services/journalLibrary.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { parseTranslationArgs, runTranslationCommand } from '../scripts/translations.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER');
const seenAt = '2026-09-07T01:00:00.000Z', exportedAt = '2026-09-07T02:00:00.000Z';
const translatedAt = '2026-09-07T02:05:00.000Z', importedAt = '2026-09-07T02:06:00.000Z';
const fixed = (time) => () => new Date(time);
const EN_TITLE = 'Credit markets and firm investment';
const EN_ABSTRACT = 'We study firm investment using data from 2001 to 2020. Credit supply affects investment by 2.5 percent. The results remain robust across firms and regions.';
const ZH_TITLE = '信贷市场与企业投资';
const ZH_ABSTRACT = '我们利用2001至2020年的数据研究企业投资。信贷供给对投资的影响幅度为2.5%。结果在不同企业和地区中均保持稳健。';
function record(overrides = {}) {
  return normalizeSourceRecord({ source: 'crossref', source_id: '10.1234/one', doi: '10.1234/one',
    title: EN_TITLE, abstract: EN_ABSTRACT, authors: [{ name: 'Alice Smith', orcid: '' }],
    journal_key: 'AER', journal_name: journal.name, journal_category: journal.category, journal_category_zh: journal.category_zh,
    print_issn: journal.print_issn, electronic_issn: journal.electronic_issn, publication_date: '2026-08-01', last_checked_at: seenAt, ...overrides });
}
const base = (records = [record()]) => mergePapers(records, { firstSeenDate: '2026-09-07', checkedAt: seenAt }).papers;
const batchFor = (papers = base(), options = {}) => createTranslationBatch(papers, { now: new Date(exportedAt), ...options });
function responseFor(batch, patch = {}) {
  return { ...translationResponseTemplate(batch), model: 'test-translator', translated_at: translatedAt,
    items: batch.items.map((item) => ({ id: item.id, source_text_hash: { ...item.source_text_hash },
      ...Object.fromEntries(item.requested_fields.map((field) => [`${field}_zh`, field === 'title' ? ZH_TITLE : ZH_ABSTRACT])) })), ...patch };
}
const apply = (papers, batch, result, options = {}) => applyTranslationResult(papers, batch, result, { config, importedAt, ...options });
function clients(records = [record()]) {
  return Object.fromEntries(['openalex', 'crossref'].map((source) => [source, async (j, options) => {
    const rows = source === 'crossref' ? records.map((row) => ({ ...row, last_checked_at: options.checkedAt })) : [];
    return { source, journal_key: j.key, ok: true, complete: true, raw_count: rows.length, records: rows,
      raw_pages: [{ fixture: true, items: rows }], rejected: [], duration_ms: 0, error: null };
  }]));
}
async function fixture(t, records = [record()]) {
  const parent = path.resolve(os.tmpdir()), temp = await fs.mkdtemp(path.join(parent, 'paper-translation-test-'));
  t.after(async () => {
    const target = path.resolve(temp);
    assert.equal(path.dirname(target), parent); assert.ok(path.basename(target).startsWith('paper-translation-test-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const root = path.join(temp, 'library');
  if (records !== null) await runJournalCollection(config, { root, journalKey: 'AER', clients: clients(records), now: fixed(seenAt) });
  return { root, temp };
}
const read = (root) => readJournalLibrary({ root, config });
const exportBatch = (root, options = {}) => exportTranslationBatch(config, { root, now: fixed(exportedAt), ...options });
const importBatch = (root, result, options = {}) => importTranslationFile(config, { root, result, now: fixed(importedAt), ...options });
const pointer = (root) => fs.readFile(path.join(root, 'current.json'), 'utf8');

test('队列只含pending/failed/outdated字段，没有摘要或已完成字段不重复入队', () => {
  const papers = base(); const queue = buildTranslationQueue(papers);
  assert.equal(queue.field_count, 2); assert.equal(queue.paper_count, 1);
  papers[0].title_translation_status = 'done'; papers[0].title_zh = ZH_TITLE;
  assert.deepEqual(buildTranslationQueue(papers).tasks.map((task) => task.field), ['abstract']);
  const missing = base([record({ abstract: '' })]);
  assert.deepEqual(buildTranslationQueue(missing).tasks.map((task) => task.field), ['title']);
  for (const status of ['failed', 'outdated']) {
    papers[0].title_translation_status = status;
    assert.equal(buildTranslationQueue(papers).tasks.length, 2);
  }
});

test('任务ID按论文+字段+原文固定，重复采集不制造新任务，原文变化只换对应字段任务', () => {
  const papers = base(), first = buildTranslationQueue(papers);
  const repeated = mergePapers([record()], { existingPapers: papers, firstSeenDate: '2026-09-08', checkedAt: '2026-09-08T01:00:00Z' }).papers;
  assert.deepEqual(buildTranslationQueue(repeated), first);
  const updated = mergePapers([record({ abstract: 'New abstract.', last_checked_at: '2026-09-08T01:00:00Z' })],
    { existingPapers: papers, firstSeenDate: '2026-09-08', checkedAt: '2026-09-08T01:00:00Z' }).papers;
  const tasks = buildTranslationQueue(updated).tasks;
  assert.equal(tasks[0].task_id, first.tasks[0].task_id); assert.notEqual(tasks[1].task_id, first.tasks[1].task_id);
});

test('清单限制以论文数计算，排序稳定，包含完整英文和任务指纹', () => {
  const papers = base([record(), record({ doi: '10.1234/two', source_id: '10.1234/two' })]);
  const batch = batchFor(papers, { limit: 1 });
  assert.equal(batch.items.length, 1); assert.equal(batch.items[0].abstract_original, EN_ABSTRACT);
  assert.equal(batch.items[0].requested_fields.length, 2);
  assert.equal(batchFor([...papers].reverse(), { limit: 1 }).batch_id, batch.batch_id);
  assert.equal(batchFor(papers, { journalKey: 'JAR' }).items.length, 0);
  assert.throws(() => batchFor(papers, { limit: 0 }));
});

test('清单被手动改写原文或任务ID后不能继续导入', () => {
  const batch = batchFor(); batch.items[0].abstract_original += ' tampered';
  assert.throws(() => validateTranslationBatch(batch));
  const changedTask = batchFor(); changedTask.items[0].task_ids.title = 'fake';
  assert.throws(() => validateTranslationBatch(changedTask));
});

test('合格中文逐字段写入，保留英文、作者、首次发现日和输入对象', () => {
  const papers = base(), batch = batchFor(papers), result = responseFor(batch);
  const original = structuredClone({ papers, batch, result });
  const applied = apply(papers, batch, result);
  assert.equal(applied.status, 'success'); assert.equal(applied.report.stats.completed_fields, 2);
  assert.equal(applied.papers[0].title_zh, ZH_TITLE); assert.equal(applied.papers[0].abstract_zh, ZH_ABSTRACT);
  assert.equal(applied.papers[0].translation_model, 'test-translator');
  assert.equal(applied.papers[0].translation_provenance.title.source_text_hash, papers[0].source_text_hash.title);
  assert.equal(applied.papers[0].translated_at, translatedAt);
  assert.doesNotThrow(() => validateTranslationOnlyChange(papers, applied.papers));
  assert.deepEqual({ papers, batch, result }, original);
});

test('重复导入相同结果为no_changes，不更新翻译时间或重新排队', () => {
  const papers = base(), batch = batchFor(papers), result = responseFor(batch);
  const first = apply(papers, batch, result), second = apply(first.papers, batch, result);
  assert.equal(second.status, 'no_changes'); assert.equal(second.report.stats.unchanged_fields, 2);
  assert.deepEqual(second.papers, first.papers); assert.equal(buildTranslationQueue(second.papers).field_count, 0);
});

test('原文更新后旧摘要译文拒收，未变标题仍可采用', () => {
  const papers = base(), batch = batchFor(papers), result = responseFor(batch);
  const newer = mergePapers([record({ abstract: 'Changed abstract.', last_checked_at: '2026-09-08T01:00:00Z' })],
    { existingPapers: papers, firstSeenDate: '2026-09-08', checkedAt: '2026-09-08T01:00:00Z' }).papers;
  const applied = apply(newer, batch, result);
  assert.equal(applied.status, 'partial_failure');
  assert.equal(applied.papers[0].title_translation_status, 'done');
  assert.equal(applied.papers[0].abstract_translation_status, 'pending');
  assert.equal(applied.papers[0].abstract_zh, '');
  assert.ok(applied.report.fields.some((field) => field.code === 'STALE_SOURCE'));
});

test('已有done译文不被同批不同文本或失败标记覆盖', () => {
  const papers = base(), batch = batchFor(papers), result = responseFor(batch);
  const first = apply(papers, batch, result);
  result.items[0].title_zh = '另一份不同译文';
  delete result.items[0].abstract_zh; result.items[0].failed_fields = ['abstract'];
  const applied = apply(first.papers, batch, result);
  assert.deepEqual(applied.papers, first.papers);
  assert.equal(applied.report.stats.rejected_fields, 2);
});

test('某字段译文异常时只标记该字段failed，其余合格字段仍完成', () => {
  const papers = base(), batch = batchFor(papers), result = responseFor(batch);
  result.items[0].abstract_zh = '摘要';
  const applied = apply(papers, batch, result);
  assert.equal(applied.status, 'partial_failure'); assert.equal(applied.papers[0].title_translation_status, 'done');
  assert.equal(applied.papers[0].abstract_translation_status, 'failed');
  assert.equal(buildTranslationQueue(applied.papers).tasks[0].field, 'abstract');
});

test('failed/outdated可重试，失败时旧译文与出处不清空', () => {
  const papers = base(), batch = batchFor(papers), first = apply(papers, batch, responseFor(batch));
  const newer = mergePapers([record({ abstract: `${EN_ABSTRACT} We also examine sectors.`, last_checked_at: '2026-09-08T01:00:00Z' })],
    { existingPapers: first.papers, firstSeenDate: '2026-09-08', checkedAt: '2026-09-08T01:00:00Z' }).papers;
  const nextBatch = batchFor(newer), failure = responseFor(nextBatch);
  delete failure.items[0].abstract_zh; failure.items[0].failed_fields = ['abstract'];
  const failed = apply(newer, nextBatch, failure);
  assert.equal(failed.papers[0].abstract_translation_status, 'failed');
  assert.equal(failed.papers[0].abstract_zh, ZH_ABSTRACT);
  assert.deepEqual(failed.papers[0].translation_provenance.abstract, first.papers[0].translation_provenance.abstract);
  const retry = responseFor(nextBatch); retry.items[0].abstract_zh += '我们还考察了不同部门。';
  assert.equal(apply(failed.papers, nextBatch, retry).papers[0].abstract_translation_status, 'done');
});

test('清洗检查拒绝空值、提示语、过短文本、缺中文与遗漏数字；保留正文段落', () => {
  for (const [value, expected] of [['', 'EMPTY_TRANSLATION'], ['以下是中文翻译：内容', 'NON_BODY_TEXT'],
    ['```json\n中文\n```', 'NON_BODY_TEXT'], ['Credit markets', 'NOT_CHINESE'], ['摘要', 'TOO_SHORT'],
    [ZH_ABSTRACT.replace('2020', ''), 'MISSING_NUMBERS']]) {
    assert.equal(translationQualityError(EN_ABSTRACT, value, 'abstract'), expected);
  }
  assert.equal(translationQualityError(EN_ABSTRACT, ZH_ABSTRACT.replace('。信贷', '。\n\n信贷'), 'abstract'), null);
});

test('结果遗漏字段保持待处理；无摘要字段不能被凭空补写', () => {
  const papers = base([record({ abstract: '' })]), batch = batchFor(papers), result = responseFor(batch);
  result.items[0].abstract_zh = ZH_ABSTRACT;
  const applied = apply(papers, batch, result);
  assert.equal(applied.papers[0].abstract_translation_status, 'no_abstract');
  assert.ok(applied.report.fields.some((field) => field.code === 'NOT_REQUESTED'));
  const onlyTitle = responseFor(batchFor()); delete onlyTitle.items[0].abstract_zh;
  assert.equal(apply(base(), batchFor(), onlyTitle).papers[0].abstract_translation_status, 'pending');
});

test('重复论文行、未知论文和额外字段被拒绝，不影响其他论文', () => {
  const papers = base([record(), record({ doi: '10.1234/two', source_id: '10.1234/two' })]), batch = batchFor(papers);
  const result = responseFor(batch); result.items.push(structuredClone(result.items[0]));
  result.items.push({ id: 'unknown-private-id', source_text_hash: {}, title_zh: '不该导入' });
  const applied = apply(papers, batch, result);
  assert.equal(applied.report.stats.completed_fields, 2); assert.equal(applied.report.stats.rejected_rows, 3);
  assert.ok(!JSON.stringify(applied.report).includes('unknown-private-id'));
  const extra = responseFor(batch); extra.items[0].doi = '10.1234/evil';
  assert.equal(apply(papers, batch, extra).report.stats.rejected_rows, 1);
});

test('缺哈希、错哈希以及同时提交译文和失败标记均不改变对应字段', () => {
  for (const mutate of [(row) => { delete row.source_text_hash.title; },
    (row) => { row.source_text_hash.title = 'bad'; }, (row) => { row.failed_fields = ['title']; }]) {
    const papers = base(), batch = batchFor(papers), result = responseFor(batch); mutate(result.items[0]);
    const applied = apply(papers, batch, result);
    assert.equal(applied.papers[0].title_translation_status, 'pending');
    assert.equal(applied.papers[0].abstract_translation_status, 'done');
  }
});

test('错误批次、缺模型、未来时间及文件顶层多余字段阻止整份导入', () => {
  const papers = base(), batch = batchFor(papers);
  for (const patch of [{ batch_id: 'fake' }, { model: '' }, { model: '请填写实际模型' },
    { translated_at: '2099-01-01T00:00:00Z' }, { secret: 'not-allowed' }]) {
    assert.throws(() => apply(papers, batch, responseFor(batch, patch)));
  }
});

test('导入后的译文出处在后续采集中保留，未变原文不重新排队', () => {
  const papers = base(), batch = batchFor(papers), translated = apply(papers, batch, responseFor(batch)).papers;
  const next = mergePapers([record()], { existingPapers: translated, firstSeenDate: '2026-09-08', checkedAt: '2026-09-08T01:00:00Z' });
  assert.equal(next.stats.updated, 0); assert.equal(next.stats.new_pending_fields, 0);
  assert.deepEqual(next.papers[0].translation_provenance, translated[0].translation_provenance);
  assert.doesNotThrow(() => validatePapers(next.papers, config));
});

test('每次正式采集自动持久化队列，文件内容与状态一致', async (t) => {
  const { root } = await fixture(t), library = await read(root);
  assert.equal(library.queue.field_count, 2);
  assert.deepEqual(await readLibraryRef(root, library.manifest.translation_queue), library.queue);
});

test('导出可重复执行，不改正式指针、不覆盖用户编辑过的模板', async (t) => {
  const { root } = await fixture(t), previous = await pointer(root), first = await exportBatch(root);
  const request = await fs.readFile(first.request_path, 'utf8');
  await fs.writeFile(first.response_path, 'user draft');
  const again = await exportBatch(root);
  assert.equal(again.reused, true); assert.equal(await pointer(root), previous);
  assert.equal(await fs.readFile(again.request_path, 'utf8'), request);
  assert.equal(await fs.readFile(again.response_path, 'utf8'), 'user draft');
});

test('预检不写任何正式或尝试记录，保存后重读能加载中文和独立翻译日志', async (t) => {
  const { root } = await fixture(t), exported = await exportBatch(root), result = responseFor(exported.batch);
  const previous = await pointer(root), attempts = await fs.readdir(path.join(root, 'attempts'));
  const preview = await importBatch(root, result);
  assert.equal(preview.dry_run, true); assert.equal(preview.committed, false);
  assert.equal(await pointer(root), previous); assert.deepEqual(await fs.readdir(path.join(root, 'attempts')), attempts);
  const saved = await importBatch(root, result, { save: true });
  assert.equal(saved.committed, true);
  const library = await read(root);
  assert.equal(library.papers[0].title_zh, ZH_TITLE); assert.equal(library.queue.field_count, 0);
  assert.equal(library.runs.length, 1); assert.equal(library.imports.length, 1);
  assert.equal(library.manifest.operation, 'translation_import');
});

test('同一文件重复保存不追加正式翻译日志或版本', async (t) => {
  const { root } = await fixture(t), exported = await exportBatch(root), result = responseFor(exported.batch);
  await importBatch(root, result, { save: true }); const previous = await pointer(root);
  const second = await importBatch(root, result, { save: true });
  assert.equal(second.status, 'no_changes'); assert.equal(second.committed, false);
  assert.equal(await pointer(root), previous); assert.equal((await read(root)).imports.length, 1);
});

test('全部翻译失败可保存字段failed，但不改变采集成功日志或英文数据', async (t) => {
  const { root } = await fixture(t), exported = await exportBatch(root), result = responseFor(exported.batch);
  result.items[0].title_zh = ''; result.items[0].abstract_zh = '';
  const saved = await importBatch(root, result, { save: true });
  assert.equal(saved.status, 'full_failure'); assert.equal(saved.committed, true);
  const library = await read(root);
  assert.equal(library.runs[0].status, 'success'); assert.equal(library.queue.by_status.failed, 2);
  assert.equal(library.papers[0].title_original, EN_TITLE); assert.equal(library.imports[0].status, 'full_failure');
});

test('预检后原文又变化时，保存阶段重新核对，旧摘要不会落库', async (t) => {
  const { root } = await fixture(t), exported = await exportBatch(root), result = responseFor(exported.batch);
  assert.equal((await importBatch(root, result)).status, 'success');
  await runJournalCollection(config, { root, journalKey: 'AER', now: fixed('2026-09-08T01:00:00Z'),
    clients: clients([record({ abstract: 'A new abstract with new results.' })]) });
  const saved = await importBatch(root, result, { save: true, now: fixed('2026-09-08T02:00:00Z') });
  assert.equal(saved.status, 'partial_failure');
  const library = await read(root);
  assert.equal(library.papers[0].abstract_zh, ''); assert.equal(library.papers[0].abstract_translation_status, 'pending');
});

test('翻译导入切换前中断时旧队列、英文、日志和指针都保持可读', async (t) => {
  const { root } = await fixture(t), exported = await exportBatch(root), before = await read(root), oldPointer = await pointer(root);
  await assert.rejects(importBatch(root, responseFor(exported.batch), { save: true,
    beforePublish: async () => { throw new Error('simulated interruption'); } }), { code: 'IMPORT_STORAGE_ERROR' });
  assert.equal(await pointer(root), oldPointer);
  const after = await read(root);
  assert.deepEqual(after.papers, before.papers); assert.deepEqual(after.queue, before.queue); assert.equal(after.imports.length, 0);
});

test('导入和采集共用写入锁，不会互相覆盖', async (t) => {
  const { root } = await fixture(t), exported = await exportBatch(root);
  await withLibraryLock(root, async () => {
    await assert.rejects(importBatch(root, responseFor(exported.batch), { save: true }), { code: 'LIBRARY_LOCKED' });
  });
});

test('翻译导入后的再次采集仍能读取两种日志，采集状态不受翻译操作冒充', async (t) => {
  const { root } = await fixture(t), exported = await exportBatch(root);
  await importBatch(root, responseFor(exported.batch), { save: true });
  const result = await runJournalCollection(config, { root, journalKey: 'AER', clients: clients(), now: fixed('2026-09-08T01:00:00Z') });
  assert.equal(result.status, 'no_updates');
  const library = await read(root); assert.equal(library.runs.length, 2); assert.equal(library.imports.length, 1);
  assert.equal(library.papers[0].title_translation_status, 'done'); assert.equal(library.queue.field_count, 0);
});

test('空库导出不创建工作目录，已无待翻译字段也不写空批次', async (t) => {
  const empty = await fixture(t, null);
  assert.equal((await exportBatch(empty.root)).empty, true); await assert.rejects(fs.stat(empty.root), { code: 'ENOENT' });
  const { root } = await fixture(t), exported = await exportBatch(root);
  await importBatch(root, responseFor(exported.batch), { save: true });
  const before = await fs.readdir(path.join(root, 'translations', 'batches'));
  assert.equal((await exportBatch(root)).empty, true);
  assert.deepEqual(await fs.readdir(path.join(root, 'translations', 'batches')), before);
});

test('损坏队列文件或导出清单不被静默忽略', async (t) => {
  const { root } = await fixture(t), exported = await exportBatch(root), result = responseFor(exported.batch);
  const batch = JSON.parse(await fs.readFile(exported.request_path, 'utf8')); batch.items[0].title_original = 'tampered';
  await fs.writeFile(exported.request_path, JSON.stringify(batch));
  await assert.rejects(importBatch(root, result));
  const library = await read(root);
  await fs.writeFile(path.join(root, library.manifest.translation_queue.path), '{}');
  await assert.rejects(read(root), { code: 'CORRUPT_LIBRARY' });
});

test('JSON结果支持UTF-8 BOM，坏JSON报固定错误，不回显正文', async (t) => {
  const { temp } = await fixture(t, null), file = path.join(temp, 'response.json');
  await fs.writeFile(file, '\uFEFF{"ok":true}'); assert.deepEqual(await readTranslationJson(file), { ok: true });
  await fs.writeFile(file, '{private-error-text');
  await assert.rejects(readTranslationJson(file), (error) => error.code === 'INVALID_TRANSLATION_JSON' && !error.message.includes('private-error-text'));
});

test('译文导入专用保护不允许偷偷改英文、作者或来源', () => {
  const original = base(), changed = structuredClone(original); changed[0].title_original = 'Modified English';
  assert.throws(() => validateTranslationOnlyChange(original, changed));
});

test('命令默认帮助；导入默认预检，只有save启用写库', () => {
  assert.deepEqual(parseTranslationArgs([]), { mode: 'help' });
  assert.equal(parseTranslationArgs(['--import', 'result.json']).save, false);
  assert.equal(parseTranslationArgs(['--import', 'result.json', '--save']).save, true);
  assert.throws(() => parseTranslationArgs(['--queue', '--save']));
  assert.throws(() => parseTranslationArgs(['--export', '--save']));
  assert.throws(() => parseTranslationArgs(['--import', 'result.json', '--limit', '10']));
  assert.throws(() => parseTranslationArgs(['--export', '--limit', '101']));
});

test('CLI队列查看只读，部分失败预检退出码为1', async () => {
  assert.equal(await runTranslationCommand(['--queue'], { log: () => {},
    read: async () => ({ pointer: null, papers: [], queue: buildTranslationQueue([]) }),
    exportBatch: () => { throw new Error('should not export'); }, importFile: () => { throw new Error('should not import'); } }), 0);
  assert.equal(await runTranslationCommand(['--import', 'example.json'], { log: () => {}, importFile: async (_config, options) => {
    assert.equal(options.save, false); return { status: 'partial_failure', report: {}, committed: false, dry_run: true };
  } }), 1);
});

test('通过带空格中文路径读取实际结果JSON，预检后可保存', async (t) => {
  const { root, temp } = await fixture(t), exported = await exportBatch(root);
  const file = path.join(temp, '中文 翻译结果.json');
  await fs.writeFile(file, '\uFEFF' + JSON.stringify(responseFor(exported.batch)));
  const preview = await importTranslationFile(config, { root, file, now: fixed(importedAt) });
  assert.equal(preview.dry_run, true); assert.equal((await read(root)).queue.field_count, 2);
  await importTranslationFile(config, { root, file, save: true, now: fixed(importedAt) });
  assert.equal((await read(root)).queue.field_count, 0);
});

test('同批一篇合格一篇失败，合格中文仍保存且失败论文留在队列', async (t) => {
  const { root } = await fixture(t, [record(), record({ doi: '10.1234/two', source_id: '10.1234/two' })]);
  const exported = await exportBatch(root), result = responseFor(exported.batch);
  result.items[1].title_zh = ''; result.items[1].abstract_zh = '';
  const applied = await importBatch(root, result, { save: true });
  assert.equal(applied.status, 'partial_failure'); assert.equal(applied.report.stats.completed_fields, 2);
  const library = await read(root);
  assert.equal(library.queue.field_count, 2); assert.equal(library.queue.by_status.failed, 2);
  assert.equal(library.papers.find((paper) => paper.id === result.items[0].id).title_zh, ZH_TITLE);
});
