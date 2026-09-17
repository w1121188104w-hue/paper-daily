import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LIBRARY_ROOT, libraryPath, readJournalLibrary, withLibraryLock, writeLibraryJson } from './journalLibrary.js';
import { assertLibrary, stableJson, isIsoTime } from './libraryValidation.js';
import { dateInShanghai } from './paperMerge.js';
import { createTranslationBatch, translationBatchId, translationEligibility, translationTaskId, validateTranslationBatch } from './translationQueue.js';
import { readTranslationJson, importTranslationFile } from './translationWorkflow.js';
import { DEEPSEEK_MODEL, PILOT_LIMITS, deepseekRequest, requireDeepSeekKey, planDeepSeekBatch, translateDeepSeekBatch } from './deepseekTranslation.js';

export const TRANSLATION_STATE_PATH = 'automation/translation-state.json';
export const AUTOMATION_LIMITS = Object.freeze({ batch: 10, backfill_requests: 1000, daily_requests: 500,
  backfill_minutes: 60, daily_minutes: 30, consecutive_failures: 3 });
const STATUS = ['reserved', 'succeeded', 'partial', 'failed', 'unused'];
const FIELDS = ['title', 'abstract'];
export const TRANSLATION_RETRY = Object.freeze({ max_attempts: 3, max_total_attempts: 9, cooldown_ms: 30 * 60000 });
export const TRANSLATION_REQUEST_PROFILE = 'numeric_placeholders_v2';
const REQUEST_PROFILES = new Set(['numeric_preservation_v1', TRANSLATION_REQUEST_PROFILE]);
const RETRYABLE_CODES = new Set(['MECHANICAL_CHECK_FAILED', 'INVALID_JSON', 'INVALID_TRANSLATION_SHAPE']);
const FIELD_ERRORS = new Set(['EMPTY_TRANSLATION', 'NON_BODY_TEXT', 'NOT_CHINESE', 'TOO_SHORT', 'MISSING_NUMBERS', 'NUMERIC_MARKER_MISMATCH']);
const HARD_PAUSE_CODES = new Set(['AUTH_ERROR', 'ACCESS_DENIED', 'INSUFFICIENT_BALANCE', 'UNEXPECTED_MODEL',
  'MODEL_CHANGED', 'SECRET_IN_RESPONSE', 'SECRET_IN_OUTPUT', 'REPEATED_INVALID_RESULTS', 'USAGE_MISSING']);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const code = (value) => value === null || (typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(value));

function retryAllowed(history, field, at, profile = null) {
  const last = history.at(-1);
  // A reviewed request improvement gets its own bounded recovery attempts;
  // historical reservations remain intact and successful/uncertain calls stay held.
  const sameProfile = history.filter(row => (row.item.request_profile || null) === profile);
  return Boolean(last && history.length < TRANSLATION_RETRY.max_total_attempts && sameProfile.length < TRANSLATION_RETRY.max_attempts &&
    last.entry.finished_at && ['failed', 'partial'].includes(last.item.status) &&
    !last.item.completed_fields.includes(field) && last.item.usage && RETRYABLE_CODES.has(last.item.code) &&
    Date.parse(at) - Date.parse(last.entry.finished_at) >= TRANSLATION_RETRY.cooldown_ms);
}

function taskHistory(state) {
  const history = new Map();
  for (const entry of state.reservations) for (const item of entry.items) if (item.status !== 'unused') {
    for (const task of item.tasks) history.set(task.task_id, [...(history.get(task.task_id) || []), { entry, item }]);
  }
  return history;
}

// Public operational metadata only: no source text, draft text, credentials or remote error messages.
export function validateTranslationState(state) {
  assertLibrary(exact(state, ['schema_version', 'paused', 'reservations']) && [1, 2].includes(state.schema_version) &&
    Array.isArray(state.reservations) && state.reservations.length <= 100000, '自动翻译状态格式无效');
  assertLibrary(state.paused === null || (exact(state.paused, ['code', 'at']) && code(state.paused.code) &&
    state.paused.code && isIsoTime(state.paused.at)), '自动翻译暂停状态无效');
  const ids = new Set(), attempted = new Map();
  for (const entry of state.reservations) {
    assertLibrary(exact(entry, ['id', 'batch_id', 'mode', 'created_at', 'finished_at', 'items']) &&
      /^[a-f0-9-]{36}$/.test(entry.id) && !ids.has(entry.id) && /^batch-[a-f0-9]{64}$/.test(entry.batch_id) &&
      ['daily', 'backfill'].includes(entry.mode) && isIsoTime(entry.created_at) &&
      (entry.finished_at === null || (isIsoTime(entry.finished_at) && Date.parse(entry.finished_at) >= Date.parse(entry.created_at))) &&
      Array.isArray(entry.items) && entry.items.length >= 1 && entry.items.length <= 10, '自动翻译预登记无效');
    ids.add(entry.id); const paperIds = new Set();
    for (const item of entry.items) {
      const optional = state.schema_version === 2 ? ['retry_of', 'field_errors', 'request_profile'].filter(key => Object.hasOwn(item, key)) : [];
      assertLibrary(exact(item, ['id', 'tasks', 'status', 'code', 'usage', 'completed_fields', ...optional]) && typeof item.id === 'string' &&
        item.id.length <= 512 && /^(doi:|fp:|openalex:|crossref:|publisher:|semanticscholar:|unknown:)/.test(item.id) && !/[\x00-\x1f\x7f]/.test(item.id) && !paperIds.has(item.id) && STATUS.includes(item.status) &&
        code(item.code) && Array.isArray(item.tasks) && item.tasks.length >= 1 && item.tasks.length <= 2 &&
        Array.isArray(item.completed_fields) && new Set(item.completed_fields).size === item.completed_fields.length, '自动翻译条目无效');
      paperIds.add(item.id); const fields = new Set(), retried = [];
      for (const key of optional.filter(key => key !== 'request_profile')) assertLibrary(item[key] && typeof item[key] === 'object' && !Array.isArray(item[key]), '重试诊断结构无效');
      if (Object.hasOwn(item, 'request_profile')) assertLibrary(REQUEST_PROFILES.has(item.request_profile), '未知翻译请求方案');
      for (const task of item.tasks) {
        assertLibrary(exact(task, ['field', 'source_hash', 'task_id']) && FIELDS.includes(task.field) && !fields.has(task.field) &&
          /^[a-f0-9]{64}$/.test(task.source_hash) && task.task_id === translationTaskId(item.id, task.field, task.source_hash), '自动翻译任务指纹无效');
        fields.add(task.field);
        const history = attempted.get(task.task_id) || [];
        if (history.length) {
          assertLibrary(state.schema_version === 2 && retryAllowed(history, task.field, entry.created_at, item.request_profile || null) &&
            item.retry_of?.[task.field] === history.at(-1).entry.id, '同一原文任务被重复登记或重试不安全');
          retried.push(task.field);
        }
        if (item.status !== 'unused') attempted.set(task.task_id, [...history, { entry, item }]);
      }
      assertLibrary(exact(item.retry_of || {}, retried), '重试必须准确关联上一笔失败登记');
      assertLibrary(Object.entries(item.field_errors || {}).every(([field, error]) =>
        fields.has(field) && !item.completed_fields.includes(field) && FIELD_ERRORS.has(error)) &&
        (entry.finished_at !== null || !Object.keys(item.field_errors || {}).length), '字段诊断只能保留已结算的固定错误代码');
      assertLibrary(item.completed_fields.every((field) => fields.has(field)), '已完成字段不属于本任务');
      assertLibrary(item.usage === null || (exact(item.usage, ['prompt_tokens', 'completion_tokens', 'total_tokens']) &&
        Object.values(item.usage).every((n) => count(n) && n <= 2000000) && item.usage.total_tokens === item.usage.prompt_tokens + item.usage.completion_tokens), '翻译用量无效');
      if (entry.finished_at === null) assertLibrary(item.status === 'reserved' && item.code === null && item.usage === null && !item.completed_fields.length, '未结算登记不能声称已完成');
      else assertLibrary(item.status !== 'reserved', '结算状态不完整');
      if (item.status === 'unused') assertLibrary(!item.completed_fields.length && item.usage === null && item.code === null, '未请求条目不能带有结果');
      if (item.status === 'succeeded') assertLibrary(item.completed_fields.length === item.tasks.length && item.usage, '成功任务缺少完成字段或用量');
      if (item.status === 'failed') assertLibrary(item.completed_fields.length === 0, '失败任务不能声称有已完成字段');
      if (item.status === 'partial') assertLibrary(item.completed_fields.length > 0 && item.completed_fields.length < item.tasks.length, '部分成功状态无效');
    }
  }
  return state;
}

export async function readTranslationState(root = DEFAULT_LIBRARY_ROOT) {
  // A missing/corrupt ledger must NEVER silently become empty and cause repeat billing.
  return validateTranslationState(await readTranslationJson(await libraryPath(root, TRANSLATION_STATE_PATH)));
}

export async function writeTranslationState(root, state) {
  validateTranslationState(state);
  const file = await libraryPath(root, TRANSLATION_STATE_PATH);
  const temporary = await libraryPath(root, `automation/state-${randomUUID()}.tmp`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
}

export function automationQueue(library, state, now = new Date()) {
  validateTranslationState(state);
  assertLibrary(Number.isFinite(now.getTime()), '翻译队列时间无效');
  const attempted = taskHistory(state);
  const ready = translationEligibility(library.papers).ready.tasks;
  const retryable = ready.filter(task => retryAllowed(attempted.get(task.task_id) || [], task.field, now.toISOString(), TRANSLATION_REQUEST_PROFILE));
  const available = [...ready.filter((task) => !attempted.has(task.task_id)), ...retryable];
  const availableIds = new Set(available.map(task => task.task_id));
  return { available, held: ready.filter((task) => !availableIds.has(task.task_id)),
    available_papers: new Set(available.map((task) => task.paper_id)).size };
}

export function nextAutomationBatch(library, state, { limit = 10, now = new Date() } = {}) {
  assertLibrary(Number.isInteger(limit) && limit >= 1 && limit <= 10, '自动翻译每批最多10篇');
  const queue = automationQueue(library, state, now), ids = new Set(queue.available.map((task) => task.paper_id));
  const tasks = new Set(queue.available.map((task) => task.task_id));
  const batch = createTranslationBatch(library.papers.filter((paper) => ids.has(paper.id)),
    { limit, now, sourceManifest: library.pointer?.manifest || null });
  for (const item of batch.items) {
    item.requested_fields = item.requested_fields.filter((field) => tasks.has(item.task_ids[field]));
    item.task_ids = Object.fromEntries(item.requested_fields.map((field) => [field, item.task_ids[field]]));
    item.field_status = Object.fromEntries(item.requested_fields.map((field) => [field, item.field_status[field]]));
  }
  // A large batch can be reduced without truncating any paper's original text.
  while (batch.items.length > 1 && batch.items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(deepseekRequest(item))), 0) > PILOT_LIMITS.input_bytes_total)
    batch.items.pop();
  batch.batch_id = translationBatchId(batch.items);
  if (batch.items.length) planDeepSeekBatch(batch);
  return batch;
}

function dailyCount(state, day) {
  return state.reservations.filter((entry) => entry.mode === 'daily' && dateInShanghai(new Date(entry.created_at)) === day)
    .reduce((sum, entry) => sum + entry.items.filter((item) => item.status !== 'unused').length, 0);
}

async function keepBatch(root, proposed) {
  const relative = `translations/batches/${proposed.batch_id}/request.json`;
  try {
    const existing = await readTranslationJson(await libraryPath(root, relative)); validateTranslationBatch(existing);
    assertLibrary(stableJson(existing.items) === stableJson(proposed.items), '本机同批次的原文清单冲突'); return existing;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeLibraryJson(root, relative, proposed); return proposed;
}

export function automationSummary(library, state, now = new Date()) {
  const queue = automationQueue(library, state, now), items = state.reservations.flatMap((entry) => entry.items);
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const item of items) if (item.usage) for (const key of Object.keys(usage)) usage[key] += item.usage[key];
  return { available_papers: queue.available_papers, available_fields: queue.available.length,
    held_fields: queue.held.length, reserved_requests: items.filter((item) => item.status === 'reserved').length,
    attempted_requests: items.filter((item) => !['reserved', 'unused'].includes(item.status)).length,
    completed_fields: items.reduce((sum, item) => sum + item.completed_fields.length, 0),
    failed_requests: items.filter((item) => ['partial', 'failed'].includes(item.status)).length,
    unknown_usage_requests: items.filter((item) => item.status !== 'unused' && item.usage === null).length,
    usage, estimated_cny_known_usage: (usage.prompt_tokens * 2 + usage.completion_tokens * 8) / 1000000,
    paused: state.paused, review_mode: 'automatic_mechanical_checks_only' };
}

/** Commit reservations remotely BEFORE paid calls, then commit accepted raw translations and receipts together.
 * A killed runner leaves reservations that prevent repeat billing on a new runner. No semantic editing occurs here. */
export async function runTranslationAutomation(config, { root = DEFAULT_LIBRARY_ROOT, mode = 'daily', apiKey,
  publishCheckpoint, fetchImpl = fetch, now = () => new Date(), log = () => {} } = {}) {
  assertLibrary(['daily', 'backfill'].includes(mode) && typeof publishCheckpoint === 'function', '自动翻译需要明确模式及持久保存步骤');
  let library = await readJournalLibrary({ root, config }), state = await readTranslationState(root);
  const initial = automationSummary(library, state, now());
  if (state.paused || !initial.available_papers) return { ...initial, requested_this_run: 0, stop_reason: state.paused ? 'PAUSED' : 'NO_UNATTEMPTED_TASKS' };
  requireDeepSeekKey(apiKey);
  assertLibrary(!JSON.stringify(state).includes(apiKey), '状态文件不能包含密钥');
  const started = now(), cap = mode === 'backfill' ? AUTOMATION_LIMITS.backfill_requests : AUTOMATION_LIMITS.daily_requests;
  const minutes = mode === 'backfill' ? AUTOMATION_LIMITS.backfill_minutes : AUTOMATION_LIMITS.daily_minutes;
  let requested = 0, failureStreak = 0, stopReason = 'QUEUE_FINISHED';
  while (requested < cap) {
    if (now() - started >= minutes * 60000) { stopReason = 'TIME_LIMIT'; break; }
    library = await readJournalLibrary({ root, config }); state = await readTranslationState(root);
    if (state.paused) { stopReason = 'PAUSED'; break; }
    const remaining = mode === 'daily' ? Math.min(cap - requested, cap - dailyCount(state, dateInShanghai(now()))) : cap - requested;
    if (remaining <= 0) { stopReason = 'REQUEST_LIMIT'; break; }
    const proposed = nextAutomationBatch(library, state, { limit: Math.min(10, remaining), now: now() });
    if (!proposed.items.length) break;
    assertLibrary(!JSON.stringify(proposed).includes(apiKey), '原文清单不能包含密钥');
    const batch = await keepBatch(root, proposed), reservedAt = now().toISOString();
    const history = taskHistory(state);
    const reservation = { id: randomUUID(), batch_id: batch.batch_id, mode, created_at: reservedAt, finished_at: null,
      items: batch.items.map((item) => ({ id: item.id, tasks: item.requested_fields.map((field) =>
        ({ field, source_hash: item.source_text_hash[field], task_id: item.task_ids[field] })),
      retry_of: Object.fromEntries(item.requested_fields.filter(field => history.has(item.task_ids[field]))
        .map(field => [field, history.get(item.task_ids[field]).at(-1).entry.id])),
      field_errors: {}, request_profile: TRANSLATION_REQUEST_PROFILE, status: 'reserved', code: null, usage: null, completed_fields: [] })) };
    await withLibraryLock(root, async () => {
      assertLibrary(stableJson(await readTranslationState(root)) === stableJson(state), '翻译状态被并发修改');
      const current = await readJournalLibrary({ root, config });
      assertLibrary(current.pointerText === library.pointerText, '登记前正式论文版本已改变');
      state.schema_version = 2;
      state.reservations.push(reservation); await writeTranslationState(root, state);
    });
    // If push fails or is ambiguous, throw now and NEVER issue a paid request.
    await publishCheckpoint({ phase: 'reserve', reservation_id: reservation.id });
    const reservedState = stableJson(state);
    const output = await translateDeepSeekBatch(batch, { apiKey, fetchImpl, now, strictModel: true,
      failureStreak, stopAfterFailures: AUTOMATION_LIMITS.consecutive_failures });
    failureStreak = output.report.failure_streak; requested += output.report.attempted_requests;
    const responseRows = new Map(output.result.items.map((item) => [item.id, item]));
    const reportRows = new Map(output.report.rows.map((item) => [item.id, item]));
    // Explicit failures mark status only; no failed model text is ever imported or published.
    const result = { schema_version: 1, batch_id: batch.batch_id,
      model: output.result.model || `${DEEPSEEK_MODEL} (request; no accepted text)`,
      translated_at: output.result.translated_at || now().toISOString(), items: [] };
    for (const item of batch.items) {
      if (!reportRows.has(item.id)) continue;
      const row = structuredClone(responseRows.get(item.id) || { id: item.id, source_text_hash: {} });
      const failed = item.requested_fields.filter((field) => !Object.hasOwn(row, `${field}_zh`));
      if (failed.length) row.failed_fields = failed;
      for (const field of failed) row.source_text_hash[field] = item.source_text_hash[field];
      result.items.push(row);
    }
    const preview = await importTranslationFile(config, { root, result, now });
    assertLibrary(preview.report.stats.rejected_fields === 0 && preview.report.stats.rejected_rows === 0, '原文已变化或译文导入身份不匹配');
    const saved = await importTranslationFile(config, { root, result, save: true, now });
    assertLibrary(saved.report.stats.rejected_fields === 0 && saved.report.stats.rejected_rows === 0, '保存过程中原文或译文身份发生变化');
    const accepted = new Map(batch.items.map((item) => [item.id, saved.report.fields.filter((field) =>
      field.id === item.id && ['completed', 'unchanged'].includes(field.action)).map((field) => field.field)]));
    for (const item of reservation.items) {
      const report = reportRows.get(item.id);
      if (!report) { item.status = 'unused'; continue; }
      item.completed_fields = accepted.get(item.id); item.usage = report.usage;
      item.status = item.completed_fields.length === item.tasks.length ? 'succeeded' : item.completed_fields.length ? 'partial' : 'failed';
      item.code = report.code || (item.status === 'succeeded' ? null : 'MECHANICAL_CHECK_FAILED');
      item.field_errors = Object.fromEntries(Object.entries(report.fields).filter(([field, error]) =>
        !item.completed_fields.includes(field) && FIELD_ERRORS.has(error)));
    }
    reservation.finished_at = now().toISOString();
    const stoppedCode = output.report.status === 'stopped' ? output.report.stop_reason || output.report.rows.at(-1)?.code || 'TRANSLATION_STOPPED' : null;
    if (HARD_PAUSE_CODES.has(stoppedCode)) state.paused = { code: stoppedCode, at: now().toISOString() };
    await withLibraryLock(root, async () => {
      assertLibrary(stableJson(await readTranslationState(root)) === reservedState, '结算前自动翻译状态已被修改');
      await writeTranslationState(root, state);
    });
    await publishCheckpoint({ phase: 'settle', reservation_id: reservation.id });
    log({ requested_this_run: requested, completed_fields_this_batch: saved.report.stats.completed_fields,
      failed_fields_this_batch: saved.report.stats.failed_fields, paused: state.paused });
    if (stoppedCode) { stopReason = stoppedCode; break; }
  }
  if (requested >= cap) stopReason = 'REQUEST_LIMIT';
  return { ...automationSummary(await readJournalLibrary({ root, config }), await readTranslationState(root), now()),
    requested_this_run: requested, stop_reason: stopReason };
}
