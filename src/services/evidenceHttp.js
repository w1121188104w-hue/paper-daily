import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { retryAfterMs } from './sourceHttp.js';

export class EvidenceError extends Error {
  constructor(code, details = {}) { super(code); this.code = code; Object.assign(this, details); }
}
const fail = (condition, code) => { if (!condition) throw new EvidenceError(code); };
export const evidenceHash = (value) => createHash('sha256').update(value).digest('hex');
export const EVIDENCE_AGENT = 'paper-daily/0.2 (+https://github.com/w1121188104w-hue/paper-daily)';

export function checkedEvidenceUrl(value, hosts) {
  let url; try { url = new URL(value); } catch { throw new EvidenceError('UNSAFE_URL'); }
  fail(url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname), 'UNSAFE_URL');
  fail(!/[\x00-\x1f\x7f]/.test(value) && url.href.length <= 3000, 'UNSAFE_URL');
  return url;
}

// robots.txt policy for this application. Does not pretend to be a browser or another crawler.
export function robotsAllows(text, target, agent = 'paper-daily') {
  const groups = []; let group = null, rulesStarted = false;
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.replace(/#.*/, '').trim().match(/^([^:]+):\s*(.*)$/); if (!match) continue;
    const key = match[1].toLowerCase(), value = match[2].trim();
    if (key === 'user-agent') {
      if (!group || rulesStarted) { group = { agents: [], rules: [] }; groups.push(group); rulesStarted = false; }
      group.agents.push(value.toLowerCase());
    } else if (group && ['allow', 'disallow'].includes(key)) { group.rules.push({ allow: key === 'allow', value }); rulesStarted = true; }
  }
  const specific = groups.filter(g => g.agents.some(a => a !== '*' && agent.toLowerCase().includes(a)));
  const selected = specific.length ? specific : groups.filter(g => g.agents.includes('*'));
  const applicable = [];
  for (const rule of selected.flatMap(g => g.rules)) {
    if (!rule.value) continue;
    const end = rule.value.endsWith('$');
    const pattern = (end ? rule.value.slice(0, -1) : rule.value).split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    if (new RegExp(`^${pattern}${end ? '$' : ''}`).test(target)) applicable.push(rule);
  }
  applicable.sort((a, b) => b.value.replaceAll('*', '').length - a.value.replaceAll('*', '').length || Number(b.allow) - Number(a.allow));
  return !applicable.length || applicable[0].allow;
}

export function makeEvidenceHttp({ fetchImpl = fetch, sleep = delay, now = Date.now, timeoutMs = 20000,
  intervalMs = 1100, maxRequests = 1200, maxBytes = 2000000, respectRobots = true, onResponse = async () => {} } = {}) {
  const last = new Map(), robots = new Map(), robotsErrors = new Set(), blocked = new Map(); let requests = 0;
  async function request(value, hosts, { headers = {}, checkRobots = true, redirectLimit = 4 } = {}) {
    let url = checkedEvidenceUrl(value, hosts), initial = url.href;
    // Keys supplied to an API must never be sent to a redirected endpoint.
    const authenticated = Object.keys(headers).some(k => /authorization|api.?key/i.test(k));
    for (let hop = 0; hop <= redirectLimit; hop++) {
      if (blocked.has(url.origin)) throw new EvidenceError(blocked.get(url.origin));
      if (respectRobots && checkRobots) {
        fail(!robotsErrors.has(url.origin), 'ROBOTS_UNAVAILABLE');
        if (!robots.has(url.origin)) {
          let rules;
          try { rules = (await request(`${url.origin}/robots.txt`, hosts, { checkRobots: false, redirectLimit: 1 })).body; }
          catch (error) { if (error.code === 'EVIDENCE_STORAGE_ERROR') throw error;
            if (error.code === 'NOT_FOUND') rules = ''; else { robotsErrors.add(url.origin); throw new EvidenceError('ROBOTS_UNAVAILABLE'); } }
          fail(!/<(?:html|head|body)\b/i.test(rules), 'ROBOTS_UNAVAILABLE');
          robots.set(url.origin, rules);
        }
        fail(robotsAllows(robots.get(url.origin), url.pathname + url.search), 'ROBOTS_DISALLOWED');
      }
      fail(++requests <= maxRequests, 'REQUEST_LIMIT');
      const crawlDelay = Math.max(0, ...[...(robots.get(url.origin) || '').matchAll(/^crawl-delay:\s*([\d.]+)/gim)].map(m => Number(m[1]) * 1000));
      fail(crawlDelay <= 60000, 'CRAWL_DELAY_RESTRICTED');
      const wait = Math.max(intervalMs, crawlDelay) - (now() - (last.get(url.origin) ?? -Infinity)); if (wait > 0) await sleep(wait);
      last.set(url.origin, now());
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { 'User-Agent': EVIDENCE_AGENT, Accept: 'text/html,application/json,application/xml,text/xml;q=0.9,*/*;q=0.5', ...headers } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const next = response.headers.get('location'); await response.body?.cancel();
          fail(!authenticated && next && hop < redirectLimit, 'REDIRECT_RESTRICTED');
          try { url = checkedEvidenceUrl(new URL(next, url).href, hosts); }
          catch { throw new EvidenceError('REDIRECT_RESTRICTED'); }
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          const code = ({ 401: 'ACCESS_RESTRICTED', 403: 'ACCESS_RESTRICTED', 404: 'NOT_FOUND', 429: 'RATE_LIMITED' })[response.status] || 'HTTP_ERROR';
          // 429 applies to the host. 403 may be page-specific: a separate public RSS is still legitimate.
          if (response.status === 429) blocked.set(url.origin, code);
          throw new EvidenceError(code, { retry_after_ms: retryAfterMs(response.headers.get('retry-after'), now()) });
        }
        const reader = response.body?.getReader(); fail(reader, 'EMPTY_RESPONSE'); const chunks = []; let size = 0;
        try { for (;;) { const { done, value: chunk } = await reader.read(); if (done) break; size += chunk.byteLength;
          fail(size <= maxBytes, 'RESPONSE_TOO_LARGE'); chunks.push(chunk); } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const body = Buffer.concat(chunks).toString('utf8');
        fail(!/<title[^>]*>\s*(?:just a moment|access denied|robot check|verify you are human)/i.test(body), 'ACCESS_RESTRICTED');
        const result = { url: url.href, requested_url: initial, fetched_at: new Date(now()).toISOString(),
          content_type: response.headers.get('content-type') || '', body, sha256: evidenceHash(body) };
        try { await onResponse(result); } catch { throw new EvidenceError('EVIDENCE_STORAGE_ERROR'); } return result;
      } catch (error) {
        if (error instanceof EvidenceError) throw error;
        throw new EvidenceError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
      } finally { clearTimeout(timer); }
    }
    throw new EvidenceError('REDIRECT_RESTRICTED');
  }
  return { request, count: () => requests };
}
