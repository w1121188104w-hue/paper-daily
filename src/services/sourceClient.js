import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { normalizeDate } from './paperModel.js';
import { requestSourceJson, SourceError } from './sourceHttp.js';

export function validateWindow({ fromDate, toDate }) {
  if (!fromDate || normalizeDate(fromDate) !== fromDate ||
      !toDate || normalizeDate(toDate) !== toDate || fromDate > toDate) {
    throw new SourceError('INVALID_WINDOW', '日期范围应为有效的 YYYY-MM-DD，开始日期不得晚于结束日期');
  }
}

// Keep raw pages in memory for the later persistence layer. Importing this module does no I/O.
export async function fetchPages(source, journal, options, adapter) {
  const { fromDate, toDate, pageSize = 100, maxPages = 1000,
    checkedAt = new Date().toISOString(), pageDelayMs = 1000, sleep = delay } = options;
  validateWindow({ fromDate, toDate });
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      !Number.isInteger(maxPages) || maxPages < 1 || !Number.isFinite(pageDelayMs) || pageDelayMs < 0) {
    throw new SourceError('INVALID_OPTIONS', '分页大小应为1–100，页数上限和等待间隔必须有效');
  }
  const start = Date.now();
  const result = { source, journal_key: journal.key, ok: false, complete: false,
    records: [], raw_pages: [], rejected: [], raw_count: 0, duration_ms: 0, error: null };
  let cursor = '*';
  const pageHashes = new Set();
  try {
    for (let page = 0; page < maxPages; page++) {
      const url = adapter.url(journal, { fromDate, toDate, pageSize, cursor });
      const payload = await requestSourceJson(url, options);
      result.raw_pages.push(payload);
      const { items, nextCursor, done } = adapter.page(payload, pageSize);
      const hash = createHash('sha256').update(JSON.stringify(items)).digest('hex');
      if (items.length && pageHashes.has(hash)) {
        throw new SourceError('REPEATED_PAGE', '数据源重复返回同一页，采集未完整完成');
      }
      pageHashes.add(hash);
      result.raw_count += items.length;
      for (const [index, item] of items.entries()) {
        try { result.records.push(adapter.normalize(item, journal, checkedAt)); }
        catch {
          result.rejected.push({ index: result.raw_count - items.length + index,
            code: 'INVALID_RECORD', message: '期刊标识或论文必需字段校验失败' });
        }
      }
      if (done) {
        result.complete = true;
        result.ok = result.rejected.length === 0;
        if (!result.ok) result.error = { code: 'INVALID_RECORDS', message: '部分记录校验失败，请查看 rejected' };
        break;
      }
      if (!nextCursor || typeof nextCursor !== 'string') {
        throw new SourceError('MISSING_CURSOR', '数据源缺少下一页游标，不能判定采集完整');
      }
      cursor = nextCursor;
      if (page === maxPages - 1) throw new SourceError('PAGE_LIMIT', '达到页数上限，结果不完整');
      await sleep(pageDelayMs);
    }
  } catch (error) {
    result.error = error instanceof SourceError
      ? { code: error.code, message: error.message, ...(error.retry_after_ms ? { retry_after_ms: error.retry_after_ms } : {}) }
      : { code: 'SOURCE_ERROR', message: '数据源返回格式不符合预期' };
  }
  result.duration_ms = Date.now() - start;
  return result;
}
