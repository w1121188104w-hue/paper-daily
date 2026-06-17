const DEFAULT_SCHOLAR_HOST = 'https://scholar.google.com/citations';
const scholarTimeoutMs = Math.max(8000, Number(process.env.SCHOLAR_TIMEOUT_MS || 25000));
const readerBaseUrl = String(process.env.JINA_READER_BASE_URL || 'https://r.jina.ai').replace(/\/$/, '');

function withTimeout(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout)
  };
}

function normalizeEngineList() {
  const configured = String(process.env.JINA_READER_ENGINE || 'browser').trim();
  return Array.from(new Set([configured, 'auto'].filter(Boolean)));
}

export function buildScholarProfileUrl(track) {
  const rawUrl = String(track?.scholarUrl || '').trim();
  const rawId = String(track?.scholarId || '').trim();
  const url = rawUrl
    ? new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`)
    : new URL(DEFAULT_SCHOLAR_HOST);

  if (rawId && !url.searchParams.get('user')) {
    url.searchParams.set('user', rawId);
  }
  url.searchParams.set('hl', 'en');
  url.searchParams.set('pagesize', '100');
  url.searchParams.set('view_op', 'list_works');
  url.searchParams.set('sortby', 'pubdate');
  return url.toString();
}

function buildReaderUrl(targetUrl) {
  return `${readerBaseUrl}/${targetUrl}`;
}

function isBlockedScholarMarkdown(markdown) {
  const text = String(markdown || '').toLowerCase();
  return (
    text.includes('target url returned error 403') ||
    text.includes("we're sorry") ||
    text.includes('automated queries') ||
    text.includes('unusual traffic')
  );
}

function isBlockedScholarHtml(html) {
  const text = String(html || '').toLowerCase();
  return (
    text.includes("we're sorry") ||
    text.includes('automated queries') ||
    text.includes('unusual traffic') ||
    text.includes('/sorry/')
  );
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
  };
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (named[lower]) return named[lower];
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function scholarHtmlToMarkdown(html, profileUrl) {
  const rows = String(html || '').match(/<tr class="gsc_a_tr"[\s\S]*?<\/tr>/gi) || [];
  const lines = [
    `Title: Google Scholar profile`,
    `URL Source: ${profileUrl}`,
    '',
    'Markdown Content:',
    '## Articles'
  ];
  for (const row of rows.slice(0, 100)) {
    const link = row.match(/<a\b(?=[^>]*class="gsc_a_at")[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const title = stripHtml(link[2]);
    const href = decodeHtmlEntities(link[1]);
    const gray = Array.from(row.matchAll(/<div class="gs_gray">([\s\S]*?)<\/div>/gi)).map((match) => stripHtml(match[1]));
    const year = stripHtml(row.match(/<span class="gsc_a_h gsc_a_hc gs_ibl">([\s\S]*?)<\/span>/i)?.[1] || '');
    const url = /^https?:\/\//i.test(href) ? href : new URL(href, profileUrl).toString();
    lines.push(
      '',
      `### ${title}`,
      `- Authors: ${gray[0] || ''}`,
      `- Venue: ${gray[1] || ''}`,
      `- Year: ${year}`,
      `- URL: ${url}`
    );
  }
  return lines.join('\n');
}

async function fetchWithEngine(targetUrl, engine) {
  const readerUrl = buildReaderUrl(targetUrl);
  const timer = withTimeout(scholarTimeoutMs);
  const headers = {
    Accept: 'text/markdown, text/plain;q=0.9',
    'User-Agent': 'paper-daily/1.0',
    'x-engine': engine,
    'x-timeout': String(Math.ceil(scholarTimeoutMs / 1000))
  };
  if (process.env.JINA_READER_NO_CACHE !== 'false') {
    headers['x-no-cache'] = 'true';
  }
  if (process.env.JINA_API_KEY) {
    headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  }

  try {
    const response = await fetch(readerUrl, {
      method: 'GET',
      signal: timer.signal,
      headers
    });
    const markdown = await response.text();
    if (!response.ok) {
      throw new Error(`Jina Reader failed: ${response.status} ${markdown.slice(0, 240)}`);
    }
    if (isBlockedScholarMarkdown(markdown)) {
      throw new Error('Google Scholar blocked the Jina Reader request.');
    }
    return { targetUrl, readerUrl, engine, markdown };
  } finally {
    timer.clear();
  }
}

async function fetchDirectScholarHtml(targetUrl) {
  const timer = withTimeout(scholarTimeoutMs);
  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: timer.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'
      }
    });
    const html = await response.text();
    if (!response.ok) {
      throw new Error(`Google Scholar fetch failed: ${response.status} ${html.slice(0, 240)}`);
    }
    if (isBlockedScholarHtml(html)) {
      throw new Error('Google Scholar blocked the direct profile request.');
    }
    return {
      targetUrl,
      readerUrl: targetUrl,
      engine: 'direct-html',
      markdown: scholarHtmlToMarkdown(html, targetUrl),
      html
    };
  } finally {
    timer.clear();
  }
}

export async function fetchScholarProfileMarkdown(track) {
  const targetUrl = buildScholarProfileUrl(track);
  const errors = [];
  for (const engine of normalizeEngineList()) {
    try {
      return await fetchWithEngine(targetUrl, engine);
    } catch (error) {
      errors.push(`${engine}: ${String(error?.message || error)}`);
    }
  }
  try {
    return await fetchDirectScholarHtml(targetUrl);
  } catch (error) {
    errors.push(`direct-html: ${String(error?.message || error)}`);
  }
  throw new Error(errors.join(' | ') || 'Scholar profile fetch failed.');
}

export function normalizePublicationTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function publicationKey(publication) {
  const title = normalizePublicationTitle(publication?.title);
  if (!title) return '';
  const year = String(publication?.year || '').match(/\b(18|19|20|21)\d{2}\b/)?.[0] || '';
  return year ? `${title}|${year}` : title;
}

function normalizePublication(raw, profileUrl) {
  const title = String(raw?.title || '').replace(/\s+/g, ' ').trim();
  if (!title || title.length < 4) return null;
  const yearText = String(raw?.year || '').match(/\b(18|19|20|21)\d{2}\b/)?.[0] || '';
  const url = String(raw?.url || '').trim();
  let resolvedUrl = url;
  if (url && !/^https?:\/\//i.test(url)) {
    try {
      resolvedUrl = new URL(url, profileUrl).toString();
    } catch {
      resolvedUrl = url;
    }
  }
  return {
    title,
    year: yearText ? Number(yearText) : null,
    authors: Array.isArray(raw?.authors)
      ? raw.authors.map((item) => String(item || '').trim()).filter(Boolean).join(', ')
      : String(raw?.authors || '').replace(/\s+/g, ' ').trim(),
    venue: String(raw?.venue || '').replace(/\s+/g, ' ').trim(),
    url: resolvedUrl
  };
}

export function normalizeScholarPublications(items, profileUrl) {
  const seen = new Set();
  const publications = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const publication = normalizePublication(raw, profileUrl);
    const key = publicationKey(publication);
    if (!publication || !key || seen.has(key)) continue;
    seen.add(key);
    publications.push(publication);
  }
  return publications.slice(0, 100);
}

export function extractScholarPublicationsFallback(markdown, profileUrl) {
  const lines = String(markdown || '').split('\n');
  const items = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith('### ')) {
      const title = line.replace(/^###\s+/, '').trim();
      const contextLines = lines.slice(index + 1, index + 5);
      const fields = Object.fromEntries(
        contextLines
          .map((item) => item.match(/^-\s*([^:]+):\s*(.*)$/))
          .filter(Boolean)
          .map((match) => [match[1].toLowerCase(), match[2].trim()])
      );
      if (title) {
        items.push({
          title,
          year: fields.year || '',
          authors: fields.authors || '',
          venue: fields.venue || '',
          url: fields.url || ''
        });
      }
      continue;
    }
    const link = line.match(/\[([^\]]{4,240})\]\(([^)]+)\)/);
    if (!link) continue;
    const title = link[1].replace(/\s+/g, ' ').trim();
    const href = link[2].trim();
    if (!/citation_for_view|view_citation|scholar\.google/i.test(href)) continue;
    if (/^(google scholar|home|articles|cited by|title|year)$/i.test(title)) continue;
    const context = lines.slice(index, index + 4).join(' ');
    const year = context.match(/\b(18|19|20|21)\d{2}\b/)?.[0] || '';
    items.push({ title, year, url: href });
  }
  return normalizeScholarPublications(items, profileUrl);
}
