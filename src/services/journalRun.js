import { collectJournals } from './collectJournals.js';
import { enabledJournals, findJournal } from './journals.js';
import { dateInShanghai } from './paperMerge.js';
import { validateWindow } from './sourceClient.js';
import { filterSourceRecords } from './paperClassification.js';
import { LibraryError, isDay, isIsoTime, validatePapers, validateHistoryPreserved } from './libraryValidation.js';
import { DEFAULT_LIBRARY_ROOT, newRunId, withLibraryLock, readJournalLibrary,
  writeLibraryJson, publishLibrarySnapshot } from './journalLibrary.js';

const ERROR_MESSAGES = {
  VALIDATION_ERROR: '正式数据校验失败，未采用新论文', CORRUPT_LIBRARY: '历史库文件缺失、损坏或校验不符',
  MISSING_POINTER: '发现历史版本但当前指针缺失', HTTP_ERROR: '数据源返回HTTP错误',
  TIMEOUT: '数据源请求超时', NETWORK_ERROR: '数据源网络请求失败', RETRY_LATER: '来源要求稍后重试',
  PAGE_LIMIT: '达到页数上限，结果不完整', REPEATED_PAGE: '来源重复返回同一页',
  MISSING_CURSOR: '缺少下一页信息', INVALID_RESPONSE: '来源结构不完整', INVALID_JSON: '来源JSON无法解析',
  INVALID_RECORDS: '部分来源记录未通过校验', CLIENT_ERROR: '来源客户端执行失败',
  LIBRARY_LOCKED: '论文库有写入锁；请先确认是否仍有采集任务运行，不要直接删除锁文件',
  INVALID_WINDOW: '回查日期或天数无效', INVALID_JOURNAL: '未匹配到已启用期刊',
  INVALID_JOURNAL_CONFIG: '本地期刊配置校验失败，请先运行期刊名单检查',
  STORAGE_ERROR: '数据未能提交；请检查存储状态和论文库attempts诊断目录',
  SOURCE_ERROR: '来源格式异常', EACCES: '文件访问权限不足', EPERM: '文件操作被系统拒绝', ENOSPC: '存储空间不足'
};
export function safeRunError(error) {
  const code = Object.hasOwn(ERROR_MESSAGES, error?.code || '') ? error.code : 'RUN_ERROR';
  return { code, message: ERROR_MESSAGES[code] || '运行未完成，请检查本地诊断文件；未输出远程正文或错误堆栈' };
}

export function collectionWindow({ now = new Date(), lookbackDays = 60, fromDate, toDate } = {}) {
  if (fromDate || toDate) {
    validateWindow({ fromDate, toDate }); return { fromDate, toDate };
  }
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 3660) {
    throw new LibraryError('INVALID_WINDOW', '回查天数应为1–3660的整数');
  }
  const end = dateInShanghai(now);
  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - lookbackDays + 1);
  return { fromDate: start.toISOString().slice(0, 10), toDate: end };
}

export function alreadyCoveredToday(runs, { runDate, journalKeys, fromDate, toDate }) {
  // Each requested journal needs BOTH successful sources within the SAME successful run.
  return journalKeys.every((key) => runs.some((run) => run.run_date === runDate &&
    ['success', 'no_updates'].includes(run.status) && run.from_date <= fromDate && run.to_date >= toDate &&
    ['openalex', 'crossref'].every((source) => run.sources.some((entry) => entry.journal_key === key &&
      entry.source === source && entry.ok && entry.complete))));
}

function summarizeSource(result) {
  const filtered = filterSourceRecords(result.records);
  return { source: result.source, journal_key: result.journal_key, ok: result.ok, complete: result.complete,
    raw_count: result.raw_count, accepted_count: filtered.accepted.length, excluded_count: filtered.excluded.length,
    rejected_count: result.rejected.length, pages: result.raw_pages.length, duration_ms: result.duration_ms,
    error: result.error ? safeRunError(result.error) : null };
}

export async function runJournalCollection(config, { root = DEFAULT_LIBRARY_ROOT, now = () => new Date(),
  journalKey, lookbackDays = 60, fromDate, toDate, onlyIfNeeded = false, collect = collectJournals,
  beforePublish, onProgress, ...requestOptions } = {}) {
  const started = now(), startedAt = started.toISOString(), runDate = dateInShanghai(started);
  const window = collectionWindow({ now: started, lookbackDays, fromDate, toDate });
  const selected = journalKey ? [findJournal(config, journalKey)].filter((journal) => journal?.enabled) : enabledJournals(config);
  if (!selected.length) throw new LibraryError('INVALID_JOURNAL', '没有匹配的启用期刊');
  const journalKeys = selected.map((journal) => journal.key);
  return withLibraryLock(root, async () => {
    const runId = newRunId(started);
    const attemptPrefix = `attempts/${runId}`;
    await writeLibraryJson(root, `${attemptPrefix}/started.json`, { schema_version: 1, run_id: runId,
      started_at: startedAt, run_date: runDate, journal_keys: journalKeys,
      from_date: window.fromDate, to_date: window.toDate });
    try {
      const previous = await readJournalLibrary({ root, config });
      if (onlyIfNeeded && alreadyCoveredToday(previous.runs, { runDate, journalKeys, ...window })) {
        await writeLibraryJson(root, `${attemptPrefix}/skipped.json`, { reason: 'already_covered_today', finished_at: now().toISOString() });
        return { status: 'skipped', reason: 'already_covered_today', paper_count: previous.papers.length, committed: false, run_id: runId };
      }
      const raw = [], stagedResults = [];
      let result, error = null;
      try {
        result = await collect(config, { ...requestOptions, journalKey, ...window, existingPapers: previous.papers,
          checkedAt: startedAt, firstSeenDate: runDate, onSourceResult: async (sourceResult) => {
            if (!journalKeys.includes(sourceResult.journal_key) || !['openalex', 'crossref'].includes(sourceResult.source)) {
              throw new LibraryError('VALIDATION_ERROR', '来源身份无效');
            }
            raw.push(await writeLibraryJson(root, `snapshots/${runId}/raw/${sourceResult.journal_key}-${sourceResult.source}.json`,
              { source: sourceResult.source, journal_key: sourceResult.journal_key,
                pages: sourceResult.raw_pages, rejected: sourceResult.rejected }));
            stagedResults.push(sourceResult);
            if (onProgress) onProgress(summarizeSource(sourceResult));
          } });
        validatePapers(result.papers, config); validateHistoryPreserved(previous.papers, result.papers);
        if (result.source_results.length !== journalKeys.length * 2 || stagedResults.length !== result.source_results.length) {
          throw new LibraryError('VALIDATION_ERROR', '缺少双源结果或原始暂存数据');
        }
      } catch (caught) {
        error = safeRunError(caught);
        // Valid history stays intact; only a full_failure log is eligible for publication.
        result = { papers: previous.papers, status: 'full_failure', source_results: stagedResults,
          audit: [], excluded: [], notices: [], stats: { added: 0, updated: 0, unchanged: previous.papers.length, new_pending_fields: 0 } };
      }
      const finishedAt = now().toISOString();
      if (!isDay(runDate) || !isIsoTime(finishedAt)) throw new LibraryError('VALIDATION_ERROR', '系统时间无效');
      const run = { schema_version: 1, run_id: runId, run_date: runDate, started_at: startedAt, finished_at: finishedAt,
        from_date: window.fromDate, to_date: window.toDate, journal_keys: journalKeys, status: result.status,
        stats: result.stats, sources: result.source_results.map(summarizeSource), error,
        excluded_count: (result.excluded || []).length, notice_count: (result.notices || []).length,
        duplicate_audit_count: result.audit.length, audit_path: `snapshots/${runId}/audit.json` };
      const published = await publishLibrarySnapshot({ root, config, previous, papers: result.papers, run, raw,
        audit: { duplicates: result.audit, excluded: result.excluded || [], notices: result.notices || [] }, beforePublish });
      return { ...result, run, run_id: runId, committed: true, root, manifest: published.manifest };
    } catch (error) {
      try { await writeLibraryJson(root, `${attemptPrefix}/failed.json`, { status: 'full_failure',
        finished_at: now().toISOString(), error: safeRunError(error) }); }
      catch { /* Disk failure may prevent even diagnostic output; never replace current.json to compensate. */ }
      throw new LibraryError(error instanceof LibraryError ? error.code : 'STORAGE_ERROR',
        '运行未能提交；未切换到未校验的新数据。请检查论文库 attempts 诊断目录和存储状态。');
    }
  });
}
