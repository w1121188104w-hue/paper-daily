import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: true,
  trimValues: true
});
const arxivTimeoutMs = Math.max(15000, Number(process.env.ARXIV_TIMEOUT_MS || 45000));
const arxivMaxAttempts = Math.max(1, Number(process.env.ARXIV_MAX_ATTEMPTS || 4));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function emitProgress(onProgress, payload) {
  if (typeof onProgress !== 'function') return;
  try {
    await onProgress(payload);
  } catch {
    // Progress reporting must not break the arXiv request itself.
  }
}

function compactDate(dateKey) {
  const compact = String(dateKey || '').replaceAll('-', '');
  return /^\d{8}$/.test(compact) ? compact : '';
}

function normalizeNaturalQuery(query) {
  const q = String(query || '').trim();
  if (!q) return 'all:*';
  // Keep advanced arXiv syntax as-is when user provides fields/boolean operators.
  if (/[a-z]+:|\"|\(|\)|\bAND\b|\bOR\b|\bNOT\b/i.test(q)) {
    return q;
  }
  return `all:"${q}"`;
}

function normalizeKeywordQuery(keyword) {
  if (Array.isArray(keyword)) {
    const parts = keyword
      .map((item) => normalizeNaturalQuery(item))
      .filter(Boolean)
      .map((item) => `(${item})`);
    if (!parts.length) return 'all:*';
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
  }
  return normalizeNaturalQuery(keyword);
}

function formatDateRange(dateFrom, dateTo) {
  const from = compactDate(dateFrom);
  const to = compactDate(dateTo);
  if (!from || !to) return '';
  return `submittedDate:[${from}0000 TO ${to}2359]`;
}

function buildQuery({ keyword, author, paper, dateFrom, dateTo }) {
  let base = '';
  if (paper) {
    base = `all:${paper}`;
  } else if (author) {
    base = `au:${author}`;
  } else {
    base = normalizeKeywordQuery(keyword);
  }
  const range = formatDateRange(dateFrom, dateTo);
  if (range) {
    return `(${base}) AND ${range}`;
  }
  return base;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeEntry(entry) {
  const authors = asArray(entry.author).map((item) => item.name).filter(Boolean);
  const categories = asArray(entry.category).map((item) => item.term).filter(Boolean);
  const links = asArray(entry.link);
  const pdfLink = links.find((l) => l.type === 'application/pdf')?.href ?? null;

  return {
    id: entry.id,
    title: String(entry.title ?? '').replace(/\s+/g, ' ').trim(),
    summary: String(entry.summary ?? '').replace(/\s+/g, ' ').trim(),
    published: entry.published,
    updated: entry.updated,
    authors,
    categories,
    url: entry.id,
    pdfUrl: pdfLink
  };
}

export async function searchArxiv({
  keyword,
  author,
  paper,
  maxResults = 15,
  dateFrom,
  dateTo,
  onProgress
}) {
  const query = buildQuery({ keyword, author, paper, dateFrom, dateTo });
  const fetchSize = Math.min(200, Math.max(50, Number(maxResults) || 50));
  const params = new URLSearchParams({
    search_query: query,
    sortBy: 'submittedDate',
    sortOrder: 'descending',
    start: '0',
    max_results: String(fetchSize)
  });

  const url = `https://export.arxiv.org/api/query?${params.toString()}`;
  let response;
  for (let attempt = 1; attempt <= arxivMaxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), arxivTimeoutMs);
    await emitProgress(onProgress, {
      type: 'attempt',
      attempt,
      maxAttempts: arxivMaxAttempts,
      query,
      message: `arXiv 第 ${attempt}/${arxivMaxAttempts} 次请求`
    });
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'paper-daily/1.0'
        }
      });
    } catch (error) {
      if (attempt === arxivMaxAttempts) {
        throw new Error(`arXiv API error: ${String(error?.message || error)}`);
      }
      const backoffMs = Math.min(30000, 2500 * 2 ** (attempt - 1));
      await emitProgress(onProgress, {
        type: 'retry',
        attempt,
        maxAttempts: arxivMaxAttempts,
        waitMs: backoffMs,
        error: String(error?.message || error),
        message: `arXiv 请求中断，${Math.round(backoffMs / 1000)} 秒后重试`
      });
      await sleep(backoffMs);
      continue;
    } finally {
      clearTimeout(timeout);
    }
    if (response.ok) break;

    if (response.status !== 429 || attempt === arxivMaxAttempts) {
      throw new Error(`arXiv API error: ${response.status}`);
    }

    const retryAfter = Number(response.headers.get('retry-after'));
    const backoffMs = Number.isFinite(retryAfter)
      ? retryAfter * 1000
      : Math.min(60000, 15000 * 2 ** (attempt - 1));
    await emitProgress(onProgress, {
      type: 'rate-limit',
      attempt,
      maxAttempts: arxivMaxAttempts,
      waitMs: backoffMs,
      message: `arXiv 限流，${Math.round(backoffMs / 1000)} 秒后重试`
    });
    await sleep(backoffMs);
  }

  const xml = await response.text();
  const parsed = parser.parse(xml);
  const entries = asArray(parsed?.feed?.entry)
    .map(normalizeEntry)
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, maxResults);

  return { query, entries };
}
