import { extractPdfText } from './pdf.js';

const PDF_TEXT_CACHE_CHARS = 9000;
const SUMMARY_PDF_CONTEXT_CHARS = 6000;
const INSIGHT_PDF_CONTEXT_CHARS = 7000;
const CHAT_PDF_CONTEXT_CHARS = 7000;
const SUMMARY_MAX_TOKENS = 1800;
const INSIGHT_MAX_TOKENS = 1800;
const CHAT_MAX_TOKENS = 1200;
const DAILY_REPORT_MAX_TOKENS = 1200;
const SCHOLAR_EXTRACT_MAX_TOKENS = 2600;
const SCHOLAR_MARKDOWN_MAX_CHARS = 18000;
const llmTimeoutMs = Math.max(15000, Number(process.env.LLM_TIMEOUT_MS || 120000));

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/$/, '');
}

const pdfTextCache = new Map();

function buildPaperContextMessage(paper, pdfText) {
  return [
    `Title: ${paper.title}`,
    `Authors: ${paper.authors.join(', ')}`,
    `Published: ${paper.published}`,
    `Abstract URL: ${paper.url}`,
    `PDF URL: ${paper.pdfUrl || 'N/A'}`,
    `Abstract: ${paper.summary}`,
    `PDF Text Extract (truncated): ${pdfText || 'N/A'}`
  ].join('\n\n');
}

async function getPaperPdfText(paper, maxChars = PDF_TEXT_CACHE_CHARS) {
  const cacheKey = paper.id;
  if (pdfTextCache.has(cacheKey)) {
    return pdfTextCache.get(cacheKey).slice(0, maxChars);
  }
  const text = await extractPdfText(paper.pdfUrl, PDF_TEXT_CACHE_CHARS);
  pdfTextCache.set(cacheKey, text);
  return text.slice(0, maxChars);
}

async function chatCompletionFetch(endpoint, apiKey, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), llmTimeoutMs);
  try {
    return await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function sendWithThinkFallback(endpoint, apiKey, payload) {
  let response = await chatCompletionFetch(endpoint, apiKey, payload);
  if (response.ok) return response;

  let errorText = await response.text();
  const mentionsThinkingFlag = /enable_thinking/i.test(errorText);
  const removeThinkingFlagPattern =
    /unknown|unsupported|unrecognized|additional|invalid|unexpected|extra|illegal/i;

  if (
    response.status === 400 &&
    payload.enable_thinking === false &&
    mentionsThinkingFlag &&
    removeThinkingFlagPattern.test(errorText)
  ) {
    const { enable_thinking, ...restPayload } = payload;
    response = await chatCompletionFetch(endpoint, apiKey, restPayload);
    if (response.ok) return response;
    errorText = await response.text();
  }

  if (response.status === 400 && payload.enable_thinking !== false && mentionsThinkingFlag) {
    response = await chatCompletionFetch(endpoint, apiKey, { ...payload, enable_thinking: false });
    if (response.ok) return response;
    errorText = await response.text();
  }

  throw new Error(`LLM request failed: ${response.status} ${errorText.slice(0, 300)}`);
}

function resolveMaxTokens(settingsMaxTokens, limit) {
  const configured = Number(settingsMaxTokens);
  if (!Number.isFinite(configured) || configured <= 0) {
    return limit;
  }
  return Math.max(256, Math.min(Math.floor(configured), limit));
}

function basePayload(settings, messages, stream, options = {}) {
  return {
    model: settings.model,
    temperature: settings.temperature,
    max_tokens: resolveMaxTokens(settings.maxTokens, options.maxTokens || SUMMARY_MAX_TOKENS),
    stream,
    messages,
    enable_thinking: false
  };
}

function buildCombinedSystemPrompt(...parts) {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function toMessageContent(content) {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item.text === 'string') return item.text.trim();
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content || '').trim();
}

function normalizeMarkdownDensity(markdown) {
  return String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripJsonFence(text) {
  const value = String(text || '').trim();
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : value;
}

function parseJsonObjectFromText(text) {
  const raw = stripJsonFence(text);
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error('LLM returned non-JSON content.');
  }
}

function sanitizeConversationHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((item) => item && ['user', 'assistant'].includes(item.role))
    .map((item) => ({
      role: item.role,
      content: toMessageContent(item.content)
    }))
    .filter((item) => item.content);
}

function emitStatus(onEvent, message, stage) {
  onEvent?.({
    type: 'status',
    stage,
    message
  });
}

const compactStylePrompt = [
  '输出风格要求：',
  '1. 直接开始正文，不要写“好的/下面我来分析/我们来系统性分析”这类开场白。',
  '2. 内容要紧凑，优先使用短段落和短列表。',
  '3. 不要使用分割线（---）或大段留白。',
  '4. 相邻列表项之间不要插入空行。',
  '5. 一级或二级标题即可，不要层级过深。',
  '6. 每个要点尽量 1-2 句，避免重复解释同一件事。',
  '7. 如果需要写公式，行内公式用 $...$，块公式用 $$...$$。'
].join('\n');

function buildInsightPrompt(insightInterests) {
  const interestLines = (Array.isArray(insightInterests) ? insightInterests : [])
    .map((item, index) => `${index + 1}. ${String(item || '').trim()}`)
    .filter((item) => !item.endsWith('. '));

  return [
    '你是用户的科研搭档，要基于论文内容，为用户提炼真正有用的研究启发。',
    '用户当前最关心的方向：',
    interestLines.join('\n') || '1. 请围绕论文中最值得迁移的方法、实验和研究机会给出启发。',
    '',
    '输出要求：',
    '1. 使用中文 Markdown。',
    '2. 先写“为什么这篇论文和我的方向有关”。',
    '3. 再写“可直接迁移的想法 / 值得马上验证的实验 / 风险与边界 / 下一步行动”。',
    '4. 必须严格基于论文内容，不要编造论文里没有的结果。',
    '5. 尽量具体，少空话，优先给研究与工程决策有帮助的 insight。',
    '6. 如果需要写公式，行内公式用 $...$，块公式用 $$...$$。'
  ].join('\n');
}

export async function summarizePaperWithLLM(paper, settings) {
  if (!settings.apiKey) {
    throw new Error('LLM API key is empty. Please configure it in settings.');
  }

  const pdfText = await getPaperPdfText(paper, SUMMARY_PDF_CONTEXT_CHARS);
  const baseUrl = normalizeBaseUrl(settings.baseUrl || 'https://api.openai.com/v1');
  const endpoint = `${baseUrl}/chat/completions`;
  const paperContext = buildPaperContextMessage(paper, pdfText);
  const systemPrompt = buildCombinedSystemPrompt(settings.summaryPrompt, compactStylePrompt);
  const payload = basePayload(
    settings,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: paperContext }
    ],
    false,
    { maxTokens: SUMMARY_MAX_TOKENS }
  );
  const response = await sendWithThinkFallback(endpoint, settings.apiKey, payload);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const summary = data?.choices?.[0]?.message?.content;
  if (!summary) {
    throw new Error('LLM returned no summary content.');
  }

  return {
    summary,
    tokens: data?.usage || null,
    extractedPdfChars: pdfText.length
  };
}

function parseStreamChunk(chunkText) {
  const lines = chunkText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'));
  const deltas = [];
  let finishReason = null;
  let done = false;
  for (const line of lines) {
    const value = line.slice(5).trim();
    if (!value) continue;
    if (value === '[DONE]') {
      done = true;
      continue;
    }
    try {
      const parsed = JSON.parse(value);
      const delta = parsed?.choices?.[0]?.delta?.content;
      const currentFinishReason = parsed?.choices?.[0]?.finish_reason;
      if (delta) deltas.push(delta);
      if (currentFinishReason) finishReason = currentFinishReason;
    } catch {
      continue;
    }
  }
  return {
    delta: deltas.join(''),
    finishReason,
    done
  };
}

async function streamCompletion(response, onEvent) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let lastFinishReason = null;
  let sawDone = false;

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const parsed = parseStreamChunk(part);
      if (parsed.delta) {
        onEvent({ type: 'delta', delta: parsed.delta });
      }
      if (parsed.finishReason) {
        lastFinishReason = parsed.finishReason;
      }
      if (parsed.done) {
        sawDone = true;
      }
    }
  }

  onEvent({
    type: 'done',
    finishReason: lastFinishReason || (sawDone ? 'stop' : null),
    terminated: sawDone
  });
}

export async function streamSummaryWithLLM(paper, settings, onEvent) {
  if (!settings.apiKey) {
    throw new Error('LLM API key is empty. Please configure it in settings.');
  }
  emitStatus(onEvent, '正在抓取论文 PDF 并抽取正文，首次读取会稍慢一些...', 'extracting-pdf');
  const pdfText = await getPaperPdfText(paper, SUMMARY_PDF_CONTEXT_CHARS);
  const baseUrl = normalizeBaseUrl(settings.baseUrl || 'https://api.openai.com/v1');
  const endpoint = `${baseUrl}/chat/completions`;
  const paperContext = buildPaperContextMessage(paper, pdfText);
  const systemPrompt = buildCombinedSystemPrompt(settings.summaryPrompt, compactStylePrompt);
  const payload = basePayload(
    settings,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: paperContext }
    ],
    true,
    { maxTokens: SUMMARY_MAX_TOKENS }
  );

  emitStatus(onEvent, '论文正文已准备好，正在请求模型生成解读...', 'calling-model');
  const response = await sendWithThinkFallback(endpoint, settings.apiKey, payload);
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`LLM stream failed: ${response.status} ${text.slice(0, 300)}`);
  }

  await streamCompletion(response, onEvent);
}

export async function streamInsightWithLLM(paper, settings, insightInterests, onEvent) {
  if (!settings.apiKey) {
    throw new Error('LLM API key is empty. Please configure it in settings.');
  }
  if (!Array.isArray(insightInterests) || !insightInterests.length) {
    throw new Error('Insight interests are empty. Please configure them in settings.');
  }

  emitStatus(onEvent, '正在抓取论文 PDF 并整理与你关注方向相关的上下文...', 'extracting-pdf');
  const pdfText = await getPaperPdfText(paper, INSIGHT_PDF_CONTEXT_CHARS);
  const baseUrl = normalizeBaseUrl(settings.baseUrl || 'https://api.openai.com/v1');
  const endpoint = `${baseUrl}/chat/completions`;
  const paperContext = buildPaperContextMessage(paper, pdfText);
  const systemPrompt = buildCombinedSystemPrompt(buildInsightPrompt(insightInterests), compactStylePrompt);
  const payload = basePayload(
    settings,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: paperContext }
    ],
    true,
    { maxTokens: INSIGHT_MAX_TOKENS }
  );

  emitStatus(onEvent, '论文上下文已准备好，正在生成研究启发...', 'calling-model');
  const response = await sendWithThinkFallback(endpoint, settings.apiKey, payload);
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`LLM stream failed: ${response.status} ${text.slice(0, 300)}`);
  }

  await streamCompletion(response, onEvent);
}

export async function streamChatWithPaper(paper, settings, history, userMessage, onEvent) {
  if (!settings.apiKey) {
    throw new Error('LLM API key is empty. Please configure it in settings.');
  }
  emitStatus(onEvent, '正在准备论文上下文...', 'extracting-pdf');
  const pdfText = await getPaperPdfText(paper, CHAT_PDF_CONTEXT_CHARS);
  const baseUrl = normalizeBaseUrl(settings.baseUrl || 'https://api.openai.com/v1');
  const endpoint = `${baseUrl}/chat/completions`;
  const paperContext = buildPaperContextMessage(paper, pdfText);
  const sanitizedHistory = sanitizeConversationHistory(history);
  const systemPrompt = buildCombinedSystemPrompt(
    'You are a research assistant. Answer questions strictly grounded in the provided paper context.',
    paperContext
  );

  const messages = [
    {
      role: 'system',
      content: systemPrompt
    },
    ...sanitizedHistory,
    { role: 'user', content: userMessage }
  ];
  const payload = basePayload(settings, messages, true, { maxTokens: CHAT_MAX_TOKENS });

  emitStatus(onEvent, '论文上下文已准备好，正在生成回复...', 'calling-model');
  const response = await sendWithThinkFallback(endpoint, settings.apiKey, payload);
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`LLM stream failed: ${response.status} ${text.slice(0, 300)}`);
  }

  await streamCompletion(response, onEvent);
}

function buildDailyReportPayload(digest) {
  const radar = digest?.dailyRadar || {};
  return {
    date: digest?.forDate || radar.date || null,
    scopeLabel: '目标日期当天',
    generatedAt: digest?.generatedAt || null,
    status: radar.status || '',
    headline: radar.headline || '',
    metrics: radar.metrics || {},
    notices: Array.isArray(radar.notices) ? radar.notices.slice(0, 4) : [],
    topPapers: (Array.isArray(radar.topPapers) ? radar.topPapers : []).slice(0, 5).map((paper) => ({
      rank: paper.rank,
      title: paper.title,
      authors: paper.authors,
      score: paper.score,
      why: paper.why,
      abstractHint: paper.abstractHint,
      url: paper.url
    })),
    watchList: (Array.isArray(radar.watchList) ? radar.watchList : []).slice(0, 8).map((paper) => ({
      rank: paper.rank,
      title: paper.title,
      score: paper.score,
      why: paper.why,
      url: paper.url
    })),
    authorUpdates: (Array.isArray(radar.authorUpdates) ? radar.authorUpdates : []).slice(0, 6),
    taskResults: (Array.isArray(digest?.taskResults) ? digest.taskResults : []).map((task) => ({
      label: task.label,
      ok: task.ok,
      count: task.count,
      error: task.error || ''
    }))
  };
}

export async function polishDailyReportWithLLM(digest, settings) {
  if (!settings.apiKey) {
    throw new Error('LLM API key is empty. Please configure it in settings.');
  }

  const baseUrl = normalizeBaseUrl(settings.baseUrl || 'https://api.openai.com/v1');
  const endpoint = `${baseUrl}/chat/completions`;
  const reportPayload = buildDailyReportPayload(digest);
  const systemPrompt = buildCombinedSystemPrompt(
    [
      '你是用户的科研日报编辑。请根据给定的 paper-daily JSON 生成一份中文 Markdown 日报。',
      '要求：',
      '1. 不要编造 JSON 中没有的信息。',
      '2. 检查范围必须按 JSON 的 scopeLabel 表述；不要把目标日期当天写成“过去 1 天”。',
      '3. 如果 status 是 partial 或 failed，必须先说明“当前结果不完整/不可靠”，不要下结论说今日没有符合条件的论文。',
      '4. 如果有推荐论文，先给“今日结论”，再给“优先看”，再给“作者更新”，最后给“扫读建议”。',
      '5. 每篇论文只写 1-2 句为什么值得看，不要写长摘要。',
      '6. 避免重复同一句 notice；不要输出空章节。',
      '7. 保持紧凑，适合用户每天快速扫读。'
    ].join('\n'),
    compactStylePrompt
  );
  const payload = basePayload(
    settings,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(reportPayload, null, 2) }
    ],
    false,
    { maxTokens: DAILY_REPORT_MAX_TOKENS }
  );

  const response = await sendWithThinkFallback(endpoint, settings.apiKey, payload);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM returned no daily report content.');
  }

  return {
    content: normalizeMarkdownDensity(content),
    tokens: data?.usage || null
  };
}

export async function extractScholarPublicationsWithLLM(markdown, track, settings) {
  if (!settings.apiKey) {
    throw new Error('LLM API key is empty. Please configure it in settings.');
  }

  const baseUrl = normalizeBaseUrl(settings.baseUrl || 'https://api.openai.com/v1');
  const endpoint = `${baseUrl}/chat/completions`;
  const clippedMarkdown = String(markdown || '').slice(0, SCHOLAR_MARKDOWN_MAX_CHARS);
  const systemPrompt = [
    'You extract publication metadata from a Google Scholar profile page rendered as Markdown.',
    'Return STRICT JSON only. No markdown fence, no commentary.',
    'Schema: {"publications":[{"title":"string","year":2026,"authors":"string","venue":"string","url":"string"}]}',
    'Rules:',
    '1. Only include publications visibly listed on the page.',
    '2. Do not invent missing fields; use empty string or null when unavailable.',
    '3. Prefer entries from the Articles/Publications table, sorted as they appear.',
    '4. Ignore navigation links, metrics, citations-only rows, and unrelated page chrome.',
    '5. Deduplicate identical titles and cap at 100 publications.'
  ].join('\n');
  const userPrompt = [
    `Tracked author name: ${track?.name || ''}`,
    `Scholar ID: ${track?.scholarId || ''}`,
    `Scholar URL: ${track?.scholarUrl || ''}`,
    '',
    'Google Scholar Markdown:',
    clippedMarkdown
  ].join('\n');
  const payload = basePayload(
    {
      ...settings,
      temperature: 0,
      maxTokens: Math.max(settings.maxTokens || 0, SCHOLAR_EXTRACT_MAX_TOKENS)
    },
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    false,
    { maxTokens: SCHOLAR_EXTRACT_MAX_TOKENS }
  );

  const response = await sendWithThinkFallback(endpoint, settings.apiKey, payload);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM returned no Scholar extraction content.');
  }
  const parsed = parseJsonObjectFromText(content);
  return {
    publications: Array.isArray(parsed?.publications) ? parsed.publications : [],
    tokens: data?.usage || null
  };
}
