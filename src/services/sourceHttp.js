import { setTimeout as delay } from 'node:timers/promises';

export class SourceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

export function retryAfterMs(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return null;
  if (/^\d+(?:\.\d+)?$/.test(String(value).trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

// No environment or secret loading. Error messages never include remote bodies or URLs.
export async function requestSourceJson(url, {
  fetchImpl = globalThis.fetch, sleep = delay, maxAttempts = 3,
  timeoutMs = 30000, now = Date.now
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new SourceError('INVALID_OPTIONS', '请求次数应为1–3，超时必须为正数');
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let waitMs = 1000 * 2 ** (attempt - 1);
    let error;
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'business-paper-daily/0.1' }
      });
      if (response.ok) {
        try { return await response.json(); }
        catch (caught) {
          if (controller.signal.aborted) throw caught;
          throw new SourceError('INVALID_JSON', '数据源返回了无法解析的 JSON');
        }
      }
      const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
      waitMs = Math.max(waitMs, retryAfterMs(response.headers.get('retry-after'), now()) ?? 0);
      // Respect long Retry-After by stopping; do not retry earlier than requested.
      if (waitMs > 60000) {
        throw new SourceError('RETRY_LATER', '数据源要求稍后重试', { retry_after_ms: waitMs });
      }
      error = new SourceError('HTTP_ERROR', `数据源请求失败（HTTP ${response.status}）`, { retryable });
      await response.body?.cancel();
    } catch (caught) {
      error = caught instanceof SourceError
        ? caught
        : new SourceError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
          controller.signal.aborted ? '数据源请求超时' : '数据源网络请求失败', { retryable: true });
    } finally {
      clearTimeout(timer);
    }
    if (!error.retryable || attempt === maxAttempts) throw error;
    await sleep(waitMs);
  }
}
