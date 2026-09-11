import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { LibraryError, assertLibrary, isObject, isCount, isIsoTime, stableJson,
  validatePapers, validateRuns, validateHistoryPreserved, validateTranslationImports, validateTranslationOnlyChange } from './libraryValidation.js';
import { buildTranslationQueue } from './translationQueue.js';
import { emptyEnrichmentState, validateEnrichmentState, validateEnrichmentRuns, validateEnrichmentReport,
  validateEnrichmentOnlyChange } from './enrichmentValidation.js';

export const DEFAULT_LIBRARY_ROOT = fileURLToPath(new URL('../../data/journal-store/', import.meta.url));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`;
export function newRunId(now = new Date()) { return `${now.toISOString().replace(/[-:.]/g, '')}-${randomUUID()}`; }

// All manifest paths are generated locally; reject traversal, Windows alternate streams, and symlinks.
export async function libraryPath(root, relative) {
  assertLibrary(typeof relative === 'string' && relative && /^[A-Za-z0-9_./-]+$/.test(relative) &&
    !relative.split('/').some((part) => !part || part === '.' || part === '..'), '数据文件路径无效');
  const resolvedRoot = path.resolve(root), target = path.resolve(resolvedRoot, relative);
  const within = path.relative(resolvedRoot, target);
  assertLibrary(within && !within.startsWith('..') && !path.isAbsolute(within), '数据路径越出论文库');
  let current = resolvedRoot;
  for (const part of ['', ...relative.split('/')]) {
    if (part) current = path.join(current, part);
    try { assertLibrary(!(await fs.lstat(current)).isSymbolicLink(), '论文库路径不能使用符号链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

export async function writeLibraryJson(root, relative, value) {
  const file = await libraryPath(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const content = encode(value);
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  return { path: relative, sha256: sha256(content) };
}

async function optionalText(root, relative) {
  try { return await fs.readFile(await libraryPath(root, relative), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function parseJson(text) {
  try { return JSON.parse(text); }
  catch { throw new LibraryError('CORRUPT_LIBRARY', '论文库JSON无法读取；不会将损坏数据当成空库'); }
}
export async function readLibraryRef(root, ref) {
  assertLibrary(isObject(ref) && typeof ref.path === 'string' && /^snapshots\/[A-Za-z0-9-]{10,100}\//.test(ref.path) &&
    /^[a-f0-9]{64}$/.test(ref.sha256), '版本清单的文件引用无效');
  const content = await optionalText(root, ref.path);
  if (content === null || sha256(content) !== ref.sha256) {
    throw new LibraryError('CORRUPT_LIBRARY', '论文库文件缺失或校验值不符；保留旧版本，不继续写入');
  }
  return parseJson(content);
}

async function readManifest(root, manifestRef, config) {
  assertLibrary(manifestRef.path.endsWith('/manifest.json'), '版本清单路径无效');
  const manifest = await readLibraryRef(root, manifestRef);
  assertLibrary(manifest.schema_version === 1 && /^[A-Za-z0-9-]{10,100}$/.test(manifest.run_id) &&
    manifestRef.path === `snapshots/${manifest.run_id}/manifest.json` && isIsoTime(manifest.created_at) &&
    isObject(manifest.papers) && isObject(manifest.runs), '版本清单结构无效');
  const papers = [], runs = [], imports = [], enrichments = [];
  for (const [year, ref] of Object.entries(manifest.papers)) {
    assertLibrary(/^\d{4}$/.test(year) && ref.path?.endsWith(`/papers/${year}.json`) && isCount(ref.count), '年度论文引用无效');
    const rows = await readLibraryRef(root, ref);
    assertLibrary(Array.isArray(rows) && rows.length === ref.count && rows.every((row) => row.first_seen_date?.slice(0, 4) === year), '年度归档或计数不符');
    papers.push(...rows);
  }
  for (const [month, ref] of Object.entries(manifest.runs)) {
    assertLibrary(/^\d{4}-\d{2}$/.test(month) && ref.path?.endsWith(`/runs/${month}.json`) && isCount(ref.count), '月度日志引用无效');
    const rows = await readLibraryRef(root, ref);
    assertLibrary(Array.isArray(rows) && rows.length === ref.count && rows.every((row) => row.run_date?.slice(0, 7) === month), '日志归档或计数不符');
    runs.push(...rows);
  }
  if (manifest.translation_imports !== undefined) assertLibrary(isObject(manifest.translation_imports), '翻译日志引用无效');
  for (const [month, ref] of Object.entries(manifest.translation_imports || {})) {
    assertLibrary(/^\d{4}-\d{2}$/.test(month) && ref.path?.endsWith(`/translation_imports/${month}.json`) && isCount(ref.count), '翻译日志归档引用无效');
    const rows = await readLibraryRef(root, ref);
    assertLibrary(Array.isArray(rows) && rows.length === ref.count && rows.every((row) => row.run_date?.slice(0, 7) === month), '翻译日志归档或计数不符');
    imports.push(...rows);
  }
  if (manifest.enrichment_runs !== undefined) assertLibrary(isObject(manifest.enrichment_runs), '补全日志引用无效');
  for (const [month, ref] of Object.entries(manifest.enrichment_runs || {})) {
    assertLibrary(/^\d{4}-\d{2}$/.test(month) && ref.path?.endsWith(`/enrichment_runs/${month}.json`) && isCount(ref.count), '补全日志归档引用无效');
    const rows = await readLibraryRef(root, ref);
    assertLibrary(Array.isArray(rows) && rows.length === ref.count && rows.every(r => r.run_date?.slice(0,7) === month), '补全日志归档计数不符');
    enrichments.push(...rows);
  }
  validatePapers(papers, config); validateRuns(runs); validateTranslationImports(imports); validateEnrichmentRuns(enrichments);
  const enrichmentState = manifest.enrichment_state ? await readLibraryRef(root, manifest.enrichment_state) : emptyEnrichmentState();
  validateEnrichmentState(enrichmentState, papers);
  for (const log of enrichments) validateEnrichmentReport(await readLibraryRef(root, log.report), log);
  const operation = manifest.operation || 'collection';
  assertLibrary(['collection', 'translation_import', 'metadata_enrichment'].includes(operation), '版本操作类型无效');
  assertLibrary(({ collection: runs, translation_import: imports, metadata_enrichment: enrichments })[operation].some((entry) => entry.run_id === manifest.run_id), '版本缺少本轮日志');
  if (operation === 'translation_import') {
    const log = imports.find((entry) => entry.run_id === manifest.run_id);
    const report = await readLibraryRef(root, log.report);
    assertLibrary(report.batch_id === log.batch_id && report.status === log.status && stableJson(report.stats) === stableJson(log.stats), '翻译导入日志与报告不符');
  }
  const audit = await readLibraryRef(root, manifest.audit);
  assertLibrary(isObject(audit) && ['duplicates', 'excluded', 'notices'].every((key) => Array.isArray(audit[key])), '审计结构无效');
  assertLibrary(Array.isArray(manifest.raw), '版本缺少原始记录引用');
  for (const ref of manifest.raw) await readLibraryRef(root, ref);
  const queue = buildTranslationQueue(papers);
  if (manifest.translation_queue) assertLibrary(stableJson(await readLibraryRef(root, manifest.translation_queue)) === stableJson(queue), '待翻译队列与论文状态不一致');
  return { manifest, papers: papers.sort((a, b) => a.id.localeCompare(b.id)), runs, imports, enrichments, enrichmentState, queue, audit };
}

export async function readJournalLibrary({ root = DEFAULT_LIBRARY_ROOT, config }) {
  const pointerText = await optionalText(root, 'current.json');
  if (pointerText === null) {
    let entries = [];
    try { entries = await fs.readdir(await libraryPath(root, 'snapshots')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (entries.length) throw new LibraryError('MISSING_POINTER', '发现历史版本但缺少 current.json，请先人工检查恢复，不能当空库继续');
    return { manifest: null, pointer: null, pointerText: null, papers: [], runs: [], imports: [], enrichments: [], enrichmentState: emptyEnrichmentState(), queue: buildTranslationQueue([]), audit: null };
  }
  const pointer = parseJson(pointerText);
  assertLibrary(pointer.schema_version === 1 && isObject(pointer.manifest), '当前版本指针无效');
  return { ...await readManifest(root, pointer.manifest, config), pointer, pointerText };
}

export async function withLibraryLock(root, callback) {
  await fs.mkdir(root, { recursive: true });
  const lockPath = await libraryPath(root, 'writer.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new LibraryError('LIBRARY_LOCKED', '另一个采集任务正在写库，或上次中断留下锁；请先确认，不自动抢占');
    throw error;
  }
  const token = randomUUID();
  try {
    await lock.writeFile(encode({ token, pid: process.pid, started_at: new Date().toISOString() })); await lock.sync();
    return await callback();
  } finally {
    await lock.close();
    // Delete ONLY our own exact lock file. No stale-lock cleanup and no recursive production deletion.
    try {
      const saved = parseJson(await fs.readFile(lockPath, 'utf8'));
      if (saved.token === token) await fs.unlink(lockPath);
    } catch { /* A damaged/unremovable lock needs human inspection; do not hide a successful commit. */ }
  }
}

function groupBy(items, key) {
  const groups = {};
  for (const item of items) (groups[key(item)] ||= []).push(item);
  return groups;
}

/** Caller must hold writer.lock. Immutable files first, one pointer replacement last. */
export async function publishLibrarySnapshot({ root, config, previous, papers, run, translationImport, enrichment, enrichmentState, audit, raw = [], beforePublish }) {
  validatePapers(papers, config); validateHistoryPreserved(previous.papers, papers);
  assertLibrary([run, translationImport, enrichment].filter(Boolean).length === 1, '每个版本必须且只能有一种操作');
  const runs = run ? [...previous.runs, run] : previous.runs;
  const imports = translationImport ? [...(previous.imports || []), translationImport] : previous.imports || [];
  const enrichments = enrichment ? [...(previous.enrichments || []), enrichment] : previous.enrichments || [];
  validateEnrichmentRuns(enrichments);
  if (enrichment) {
    validateEnrichmentOnlyChange(previous.papers, papers);
    assertLibrary(enrichment.stats.added === papers.length - previous.papers.length, '补入数量与论文库不一致');
  }
  validateRuns(runs); validateTranslationImports(imports);
  if (run) assertLibrary(run.stats.added + run.stats.updated + run.stats.unchanged === papers.length &&
    run.stats.added === papers.length - previous.papers.length, '运行统计与论文总数不一致');
  if (translationImport) validateTranslationOnlyChange(previous.papers, papers);
  const operationLog = run || translationImport || enrichment;
  const prefix = `snapshots/${operationLog.run_id}`;
  const manifest = { schema_version: 1, run_id: operationLog.run_id, created_at: operationLog.finished_at,
    operation: run ? 'collection' : translationImport ? 'translation_import' : 'metadata_enrichment', parent: previous.pointer?.manifest || null,
    papers: {}, runs: {}, translation_imports: {}, audit: null, raw };
  for (const [kind, items, oldItems, key] of [
    ['papers', papers, previous.papers, (paper) => paper.first_seen_date.slice(0, 4)],
    ['runs', runs, previous.runs, (entry) => entry.run_date.slice(0, 7)],
    ['translation_imports', imports, previous.imports || [], (entry) => entry.run_date.slice(0, 7)],
    ['enrichment_runs', enrichments, previous.enrichments || [], (entry) => entry.run_date.slice(0, 7)]
  ]) {
    if (kind === 'enrichment_runs' && !items.length) continue;
    manifest[kind] ||= {};
    const oldGroups = groupBy(oldItems, key);
    for (const [bucket, rows] of Object.entries(groupBy(items, key))) {
      const order = (a, b) => (a.id || a.run_id).localeCompare(b.id || b.run_id);
      rows.sort(order); oldGroups[bucket]?.sort(order);
      if (stableJson(rows) === stableJson(oldGroups[bucket])) manifest[kind][bucket] = previous.manifest[kind][bucket];
      else manifest[kind][bucket] = { ...await writeLibraryJson(root, `${prefix}/${kind}/${bucket}.json`, rows), count: rows.length };
    }
  }
  if (enrichmentState !== undefined) {
    assertLibrary(Boolean(enrichment), '仅补全操作可更新重试状态');
    validateEnrichmentState(enrichmentState, papers);
    manifest.enrichment_state = await writeLibraryJson(root, `${prefix}/enrichment-state.json`, enrichmentState);
  } else if (previous.manifest?.enrichment_state) manifest.enrichment_state = previous.manifest.enrichment_state;
  manifest.audit = await writeLibraryJson(root, `${prefix}/audit.json`, audit);
  manifest.translation_queue = await writeLibraryJson(root, `${prefix}/translation-queue.json`, buildTranslationQueue(papers));
  const manifestRef = await writeLibraryJson(root, `${prefix}/manifest.json`, manifest);
  // Read from disk and revalidate the entire proposed formal library before exposing it.
  if (beforePublish) await beforePublish({ root, manifest, manifestRef });
  await readManifest(root, manifestRef, config);
  // Catch accidental edits by another process even when it disregards writer.lock.
  assertLibrary(await optionalText(root, 'current.json') === previous.pointerText, '当前版本被其他进程改变，请重新读取后再试');
  const pointer = { schema_version: 1, manifest: manifestRef };
  const tempName = `current-${operationLog.run_id}.tmp`;
  await writeLibraryJson(root, tempName, pointer);
  // Same-directory rename; never delete current.json first if Windows reports an error.
  await fs.rename(await libraryPath(root, tempName), await libraryPath(root, 'current.json'));
  return { manifest, pointer };
}
