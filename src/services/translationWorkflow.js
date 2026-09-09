import fs from 'node:fs/promises';
import path from 'node:path';
import { LibraryError, assertLibrary, stableJson } from './libraryValidation.js';
import { dateInShanghai } from './paperMerge.js';
import { DEFAULT_LIBRARY_ROOT, libraryPath, newRunId, readJournalLibrary, withLibraryLock,
  writeLibraryJson, publishLibrarySnapshot } from './journalLibrary.js';
import { createTranslationBatch, validateTranslationBatch, translationResponseTemplate } from './translationQueue.js';
import { applyTranslationResult } from './translationImport.js';

export async function readTranslationJson(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    assertLibrary(stat.isFile() && stat.size <= 20 * 1024 * 1024, '翻译JSON必须是文件且不超过20MB');
    const text = await handle.readFile('utf8');
    try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { throw new LibraryError('INVALID_TRANSLATION_JSON', '翻译文件不是有效JSON；未导入任何数据'); }
  } finally { await handle.close(); }
}

async function storedBatch(root, id) {
  assertLibrary(typeof id === 'string' && /^batch-[a-f0-9]{64}$/.test(id), '翻译批次ID格式无效');
  const batch = await readTranslationJson(await libraryPath(root, `translations/batches/${id}/request.json`));
  validateTranslationBatch(batch);
  assertLibrary(batch.batch_id === id, '导出清单与所在目录不一致');
  return batch;
}

export async function exportTranslationBatch(config, { root = DEFAULT_LIBRARY_ROOT, limit = 10, journalKey, now = () => new Date() } = {}) {
  const initial = await readJournalLibrary({ root, config });
  const options = { limit, journalKey, now: now(), sourceManifest: initial.pointer?.manifest || null };
  if (!createTranslationBatch(initial.papers, options).items.length) return { empty: true, batch: null, request_path: null, response_path: null };
  return withLibraryLock(root, async () => {
    const current = await readJournalLibrary({ root, config });
    const proposed = createTranslationBatch(current.papers, { ...options, sourceManifest: current.pointer?.manifest || null });
    if (!proposed.items.length) return { empty: true, batch: null, request_path: null, response_path: null };
    validateTranslationBatch(proposed);
    const prefix = `translations/batches/${proposed.batch_id}`;
    let batch = proposed, reused = false;
    try {
      batch = await storedBatch(root, proposed.batch_id);
      assertLibrary(stableJson(batch.items) === stableJson(proposed.items), '同批次的导出内容发生冲突');
      reused = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeLibraryJson(root, `${prefix}/request.json`, proposed);
    }
    try { await writeLibraryJson(root, `${prefix}/response.template.json`, translationResponseTemplate(batch)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; } // Never overwrite a user's edited response/template.
    return { empty: false, reused, batch, request_path: await libraryPath(root, `${prefix}/request.json`),
      response_path: await libraryPath(root, `${prefix}/response.template.json`) };
  });
}

export async function importTranslationFile(config, { root = DEFAULT_LIBRARY_ROOT, file, result,
  save = false, now = () => new Date(), beforePublish } = {}) {
  const response = result === undefined ? await readTranslationJson(path.resolve(file)) : structuredClone(result);
  const started = now(), startedAt = started.toISOString();
  const evaluate = async (previous) => {
    assertLibrary(previous.pointer, '请先建立真实论文库，再导入翻译');
    const batch = await storedBatch(root, response?.batch_id);
    return applyTranslationResult(previous.papers, batch, response, { config, importedAt: startedAt });
  };
  if (!save) return { ...await evaluate(await readJournalLibrary({ root, config })), committed: false, dry_run: true };
  return withLibraryLock(root, async () => {
    const runId = newRunId(started), prefix = `attempts/${runId}`;
    await writeLibraryJson(root, `${prefix}/started.json`, { schema_version: 1, operation: 'translation_import',
      run_id: runId, started_at: startedAt });
    try {
      const previous = await readJournalLibrary({ root, config });
      const applied = await evaluate(previous);
      if (!applied.report.stats.changed_papers) {
        await writeLibraryJson(root, `${prefix}/result.json`, applied.report);
        return { ...applied, committed: false, dry_run: false, run_id: runId };
      }
      const reportRef = await writeLibraryJson(root, `snapshots/${runId}/translation-report.json`, applied.report);
      const log = { schema_version: 1, run_id: runId, run_date: dateInShanghai(started), started_at: startedAt,
        finished_at: now().toISOString(), batch_id: response.batch_id, model: response.model.trim(), translated_at: response.translated_at,
        status: applied.status, stats: applied.report.stats, report: reportRef };
      await publishLibrarySnapshot({ root, config, previous, papers: applied.papers, translationImport: log,
        audit: previous.audit, raw: previous.manifest.raw, beforePublish });
      return { ...applied, committed: true, dry_run: false, run_id: runId, import_log: log };
    } catch (error) {
      try { await writeLibraryJson(root, `${prefix}/failed.json`, { operation: 'translation_import', status: 'full_failure',
        finished_at: now().toISOString(), code: error instanceof LibraryError ? error.code : 'IMPORT_STORAGE_ERROR',
        message: '翻译导入未能提交；未输出结果文件正文或错误堆栈' }); }
      catch { /* Do not touch current.json to compensate for a diagnostic write failure. */ }
      throw new LibraryError(error instanceof LibraryError ? error.code : 'IMPORT_STORAGE_ERROR', '译文未能提交，请检查格式、批次或存储状态；原版本未被替换');
    }
  });
}
