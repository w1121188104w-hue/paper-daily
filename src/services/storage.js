import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const dataDir = path.resolve(process.cwd(), 'data');
const subscriptionsPath = path.join(dataDir, 'subscriptions.json');
const digestsPath = path.join(dataDir, 'digests.json');
const marksPath = path.join(dataDir, 'marks.json');
const llmSettingsPath = path.join(dataDir, 'llm-settings.json');
const authorTrackStatePath = path.join(dataDir, 'author-track-state.json');
const paperAiCachePath = path.join(dataDir, 'paper-ai-cache.json');
const refreshStatePath = path.join(dataDir, 'refresh-state.json');
const dailyReportsDir = path.join(dataDir, 'daily-reports');

const defaultSubscriptions = {
  queries: ['retrieval augmented generation embedding model'],
  windowDays: 1,
  minScore: 4,
  keywords: [],
  people: [],
  papers: [],
  authorTracks: [],
  insightInterests: []
};

const defaultLLMSettings = {
  baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
  apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
  model: process.env.LLM_MODEL || 'gpt-4o-mini',
  temperature: Number.isFinite(Number(process.env.LLM_TEMPERATURE))
    ? Number(process.env.LLM_TEMPERATURE)
    : 0.2,
  maxTokens: Number.isFinite(Number(process.env.LLM_MAX_TOKENS))
    ? Number(process.env.LLM_MAX_TOKENS)
    : 700,
  summaryPrompt:
    process.env.LLM_SUMMARY_PROMPT ||
    '你是科研助手。请根据给定论文信息输出：1) 100字摘要 2) 关键贡献(3条) 3) 方法亮点(3条) 4) 局限性(2条) 5) 可复现建议。'
};

async function ensureDataFile(filePath, defaultValue) {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), 'utf-8');
  }
}

async function readJson(filePath, defaultValue) {
  await ensureDataFile(filePath, defaultValue);
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function todayDateKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeScholar(value) {
  const raw = String(value || '').trim();
  if (!raw) return { scholarId: '', scholarUrl: '' };
  try {
    const parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    if (/scholar\.google\./i.test(parsed.hostname)) {
      const user = parsed.searchParams.get('user') || '';
      return {
        scholarId: user || raw,
        scholarUrl: raw.startsWith('http') ? raw : `https://${raw}`
      };
    }
  } catch {
    // Keep non-URL values as raw Scholar IDs.
  }
  return {
    scholarId: raw,
    scholarUrl: ''
  };
}

function normalizeAuthorTrack(item, fallbackDateKey) {
  const source = item && typeof item === 'object' ? item : {};
  const name = String(source.name || '').trim();
  if (!name) return null;

  const scholar = normalizeScholar(source.scholarUrl || source.scholarId);
  const scholarId = scholar.scholarId;
  const scholarUrl = scholar.scholarUrl;
  const orcid = String(source.orcid || '').trim();
  const arxivAuthorQuery = String(source.arxivAuthorQuery || '').trim();
  const subscribedDate = isDateKey(source.subscribedDate) ? source.subscribedDate : fallbackDateKey;
  const enabled = source.enabled !== false;

  const stableKey = [name, scholarId, scholarUrl, orcid, arxivAuthorQuery, subscribedDate]
    .map((value) => value.toLowerCase())
    .join('|');
  const fallbackId = `${slugify(name) || 'author'}-${createHash('sha1').update(stableKey).digest('hex').slice(0, 10)}`;
  const id = String(source.id || fallbackId).trim() || fallbackId;

  return {
    id,
    name,
    scholarId,
    scholarUrl,
    orcid,
    arxivAuthorQuery,
    subscribedDate,
    enabled
  };
}

function normalizeAuthorTracks(items, fallbackDateKey) {
  const list = Array.isArray(items) ? items : [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const normalized = normalizeAuthorTrack(item, fallbackDateKey);
    if (!normalized) continue;
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    result.push(normalized);
  }
  return result;
}

function normalizeStringList(items) {
  return Array.from(
    new Set(
      (Array.isArray(items) ? items : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    )
  );
}

export async function getSubscriptions() {
  const raw = await readJson(subscriptionsPath, defaultSubscriptions);
  const fallbackDateKey = todayDateKey();
  const authorTracks = normalizeAuthorTracks(raw?.authorTracks, fallbackDateKey);
  return {
    ...defaultSubscriptions,
    ...(raw || {}),
    queries: Array.isArray(raw?.queries)
      ? raw.queries
      : Array.isArray(raw?.keywords)
        ? raw.keywords
        : defaultSubscriptions.queries,
    authorTracks,
    insightInterests: normalizeStringList(raw?.insightInterests)
  };
}

export async function updateSubscriptions(next) {
  const current = await getSubscriptions();
  const fallbackDateKey = todayDateKey();
  const merged = {
    queries: Array.isArray(next.queries) ? next.queries : current.queries,
    windowDays: Number.isFinite(Number(next.windowDays)) ? Number(next.windowDays) : current.windowDays,
    minScore: Number.isFinite(Number(next.minScore)) ? Number(next.minScore) : current.minScore,
    keywords: Array.isArray(next.keywords) ? next.keywords : current.keywords,
    people: Array.isArray(next.people) ? next.people : current.people,
    papers: Array.isArray(next.papers) ? next.papers : current.papers,
    authorTracks: normalizeAuthorTracks(
      Array.isArray(next.authorTracks) ? next.authorTracks : current.authorTracks,
      fallbackDateKey
    ),
    insightInterests: normalizeStringList(
      Array.isArray(next.insightInterests) ? next.insightInterests : current.insightInterests
    )
  };
  merged.windowDays = Math.max(1, Math.min(30, Math.floor(merged.windowDays)));
  merged.minScore = Math.max(0, Math.min(40, Math.floor(merged.minScore)));
  if (!merged.queries.length && merged.keywords.length) {
    merged.queries = [...merged.keywords];
  }
  await writeJson(subscriptionsPath, merged);
  return merged;
}

export async function getDigests() {
  return readJson(digestsPath, {});
}

export async function saveDigest(dateKey, digest) {
  const all = await getDigests();
  all[dateKey] = digest;
  await writeJson(digestsPath, all);
  return all[dateKey];
}

export async function getRefreshState() {
  return readJson(refreshStatePath, { dates: {} });
}

export async function saveRefreshState(next) {
  const state = next && typeof next === 'object' ? next : { dates: {} };
  if (!state.dates || typeof state.dates !== 'object') {
    state.dates = {};
  }
  await writeJson(refreshStatePath, state);
  return state;
}

export async function saveDailyReport(dateKey, markdown) {
  await fs.mkdir(dailyReportsDir, { recursive: true });
  const filePath = path.join(dailyReportsDir, `${dateKey}.md`);
  await fs.writeFile(filePath, String(markdown || ''), 'utf-8');
  return filePath;
}

export async function getDailyReport(dateKey) {
  const filePath = path.join(dailyReportsDir, `${dateKey}.md`);
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

export async function getMarks() {
  return readJson(marksPath, {});
}

export async function getMarksByDate(dateKey) {
  const all = await getMarks();
  return Array.isArray(all[dateKey]) ? all[dateKey] : [];
}

export async function saveMarksByDate(dateKey, paperIds) {
  const all = await getMarks();
  all[dateKey] = Array.from(new Set(Array.isArray(paperIds) ? paperIds : []));
  await writeJson(marksPath, all);
  return all[dateKey];
}

export async function toggleMark(dateKey, paperId) {
  const all = await getMarks();
  const current = new Set(Array.isArray(all[dateKey]) ? all[dateKey] : []);
  if (current.has(paperId)) {
    current.delete(paperId);
  } else {
    current.add(paperId);
  }
  all[dateKey] = Array.from(current);
  await writeJson(marksPath, all);
  return { paperIds: all[dateKey], marked: current.has(paperId) };
}

export async function getLLMSettings() {
  const saved = await readJson(llmSettingsPath, defaultLLMSettings);
  return {
    ...defaultLLMSettings,
    ...saved,
    baseUrl: process.env.LLM_BASE_URL || saved.baseUrl || defaultLLMSettings.baseUrl,
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || saved.apiKey || '',
    model: process.env.LLM_MODEL || saved.model || defaultLLMSettings.model
  };
}

export async function updateLLMSettings(next) {
  const merged = {
    ...defaultLLMSettings,
    ...(next || {})
  };
  merged.temperature = Number.isFinite(Number(merged.temperature)) ? Number(merged.temperature) : 0.2;
  merged.maxTokens = Number.isFinite(Number(merged.maxTokens)) ? Number(merged.maxTokens) : 700;
  await writeJson(llmSettingsPath, merged);
  return merged;
}

export async function getAuthorTrackState() {
  return readJson(authorTrackStatePath, {});
}

export async function saveAuthorTrackState(next) {
  await writeJson(authorTrackStatePath, next || {});
  return next || {};
}

export async function getPaperAiCache() {
  return readJson(paperAiCachePath, {});
}

export async function getPaperAiRecord(dateKey, paperId) {
  const all = await getPaperAiCache();
  const dateBucket = all?.[dateKey];
  const record = dateBucket?.[paperId];
  return {
    summary: record?.summary || null,
    insight: record?.insight || null
  };
}

export async function savePaperAiRecord(dateKey, paperId, kind, payload) {
  const all = await getPaperAiCache();
  if (!all[dateKey]) all[dateKey] = {};
  if (!all[dateKey][paperId]) all[dateKey][paperId] = {};

  all[dateKey][paperId][kind] = {
    content: String(payload?.content || ''),
    updatedAt: payload?.updatedAt || new Date().toISOString(),
    status: String(payload?.status || 'completed'),
    finishReason: payload?.finishReason || null
  };

  await writeJson(paperAiCachePath, all);
  return all[dateKey][paperId][kind];
}
