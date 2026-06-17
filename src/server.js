import './services/env.js';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  polishDailyReportWithLLM,
  streamChatWithPaper,
  streamInsightWithLLM,
  streamSummaryWithLLM,
  summarizePaperWithLLM
} from './services/llm.js';
import { buildDailyDigest } from './services/recommender.js';
import { checkAuthorTracksForDate } from './services/authorTracker.js';
import {
  buildDailyRadar,
  buildDailyReportMarkdown,
  buildNotificationMessage,
} from './services/dailyRadar.js';
import { sendDesktopNotification } from './services/notifications.js';
import {
  getDailyReport,
  getDigests,
  getPaperAiRecord,
  getLLMSettings,
  getMarks,
  getMarksByDate,
  getRefreshState,
  getSubscriptions,
  saveDailyReport,
  saveMarksByDate,
  savePaperAiRecord,
  saveDigest,
  saveRefreshState,
  toggleMark,
  updateLLMSettings,
  updateSubscriptions
} from './services/storage.js';

const app = express();
const port = process.env.PORT || 3000;
const refreshCron = process.env.REFRESH_CRON || '10 8 * * *';
const refreshCatchupCron = process.env.REFRESH_CATCHUP_CRON || '0 13 * * *';
const refreshRetryMinutes = Math.max(1, Number(process.env.REFRESH_RETRY_MINUTES || 30));
const refreshRetryLimit = Math.max(0, Number(process.env.REFRESH_RETRY_LIMIT || 3));
const catchupLookbackDays = Math.max(1, Number(process.env.CATCHUP_LOOKBACK_DAYS || 7));
const catchupFailedLookbackDays = Math.max(
  catchupLookbackDays,
  Math.floor(Number(process.env.CATCHUP_FAILED_LOOKBACK_DAYS || 30)) || 30
);
const catchupMaxDates = Math.max(1, Number(process.env.CATCHUP_MAX_DATES || 3));
const catchupDelayMs = Math.max(0, Number(process.env.CATCHUP_DELAY_MS || 120000));
const refreshTimezone =
  process.env.REFRESH_TIMEZONE ||
  process.env.TZ ||
  Intl.DateTimeFormat().resolvedOptions().timeZone ||
  'Asia/Shanghai';
const refreshOnStartup = process.env.REFRESH_ON_STARTUP !== 'false';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');
const activeRefreshes = new Map();
const retryTimers = new Map();
let catchupQueueRunning = false;
let catchupQueuePromise = null;

app.use(cors());
app.use(express.json());
app.use(express.static(publicDir));

function dateKeyInTimezone(timeZone, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
  } catch {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}

function todayDateKey() {
  return dateKeyInTimezone(refreshTimezone);
}

function dateKeyOffset(days, baseDate = new Date()) {
  const shifted = new Date(baseDate.getTime());
  shifted.setDate(shifted.getDate() + days);
  return dateKeyInTimezone(refreshTimezone, shifted);
}

function getRecentDateKeys(days) {
  const keys = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    keys.push(dateKeyOffset(-offset));
  }
  return keys;
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function dateKeyInRecentWindow(dateKey, days) {
  const start = dateKeyOffset(-(days - 1));
  const end = todayDateKey();
  return isDateKey(dateKey) && dateKey >= start && dateKey <= end;
}

function classifyDigestRefresh(digest) {
  const taskCount = Number(digest?.taskCount || 0);
  const failedTasks = Number(digest?.failedTasks || 0);
  if (taskCount && failedTasks >= taskCount) return 'failed';
  if (failedTasks > 0) return 'partial';
  return 'success';
}

function getDigestRefreshStatus(digest) {
  return String(digest?.dailyRadar?.status || classifyDigestRefresh(digest)).toLowerCase();
}

function isWaitingForRetry(record) {
  const status = String(record?.status || '').toLowerCase();
  const retryAtMs = Date.parse(record?.nextRetryAt || '');
  return ['failed', 'partial', 'interrupted'].includes(status) &&
    Number.isFinite(retryAtMs) &&
    retryAtMs > Date.now();
}

function digestNeedsCatchup(dateKey, digest, record, options = {}) {
  if (activeRefreshes.has(dateKey)) return false;
  const respectRetry = options.respectRetry !== false;
  const recordStatus = String(record?.status || '').toLowerCase();
  if (recordStatus === 'running') return false;
  if (respectRetry && isWaitingForRetry(record)) return false;
  if (['failed', 'partial', 'interrupted'].includes(recordStatus)) return true;
  if (!digest?.generatedAt) return true;
  const digestStatus = getDigestRefreshStatus(digest);
  return ['failed', 'partial'].includes(digestStatus);
}

function shouldRetryRefresh(status) {
  return ['failed', 'partial'].includes(status) && refreshRetryLimit > 0;
}

function shouldNotifyForReason(reason) {
  return ['cron', 'catchup', 'startup', 'retry'].includes(reason) ||
    process.env.NOTIFY_MANUAL_REFRESH === 'true';
}

async function updateRefreshRecord(dateKey, patch) {
  const state = await getRefreshState();
  if (!state.dates || typeof state.dates !== 'object') {
    state.dates = {};
  }
  const previous = state.dates[dateKey] || {};
  const next = {
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  state.dates[dateKey] = next;
  state.lastUpdatedAt = next.updatedAt;
  await saveRefreshState(state);
  return next;
}

function clearRetry(dateKey) {
  const timer = retryTimers.get(dateKey);
  if (timer) {
    clearTimeout(timer);
    retryTimers.delete(dateKey);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForActiveRefreshes() {
  const jobs = Array.from(activeRefreshes.values());
  if (!jobs.length) return;
  await Promise.allSettled(jobs);
}

async function scheduleRetry(dateKey, reason, attempt) {
  if (attempt >= refreshRetryLimit) {
    await updateRefreshRecord(dateKey, {
      nextRetryAt: null,
      retryNote: `已达到重试上限 ${refreshRetryLimit} 次`
    });
    return;
  }

  clearRetry(dateKey);
  const retryAt = new Date(Date.now() + refreshRetryMinutes * 60 * 1000);
  await updateRefreshRecord(dateKey, {
    nextRetryAt: retryAt.toISOString(),
    retryNote: `${refreshRetryMinutes} 分钟后自动重试`
  });
  const timer = setTimeout(() => {
    retryTimers.delete(dateKey);
    runRefreshForDate(dateKey, `retry:${reason}`).catch((error) => {
      console.error(`[refresh] retry failed for ${dateKey}`, error);
    });
  }, refreshRetryMinutes * 60 * 1000);
  retryTimers.set(dateKey, timer);
}

function normalizeProgress(progress) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(progress?.percent || 0))));
  return {
    stage: String(progress?.stage || 'refreshing'),
    current: Number(progress?.current || 0),
    total: Number(progress?.total || 0),
    percent,
    label: String(progress?.label || ''),
    message: String(progress?.message || '正在刷新'),
    updatedAt: new Date().toISOString()
  };
}

async function refreshDigestForDate(dateKey = todayDateKey(), options = {}) {
  const onProgress = typeof options.onProgress === 'function'
    ? options.onProgress
    : async () => {};
  await onProgress({
    stage: 'subscriptions',
    percent: 2,
    message: '正在读取订阅配置'
  });
  const subscriptions = await getSubscriptions();
  const digest = await buildDailyDigest(subscriptions, { dateKey, onProgress });
  await onProgress({
    stage: 'author-tracks',
    percent: 82,
    message: '正在检查作者追踪'
  });
  const authorTracking = await checkAuthorTracksForDate(dateKey);
  await onProgress({
    stage: 'report',
    percent: 90,
    message: '正在生成扫读摘要'
  });
  const finalDigest = { ...digest, authorTracking };
  finalDigest.dailyRadar = buildDailyRadar(finalDigest, dateKey);
  let saved = await saveDigest(dateKey, finalDigest);
  const reportResult = await buildAndSaveDailyReport(dateKey, saved, onProgress);
  saved = await saveDigest(dateKey, {
    ...saved,
    dailyReport: reportResult.meta
  });
  await onProgress({
    stage: 'done',
    percent: 100,
    message: '刷新完成'
  });
  return saved;
}

async function buildAndSaveDailyReport(dateKey, digest, onProgress = async () => {}) {
  const fallback = buildDailyReportMarkdown(digest, dateKey);
  let content = fallback;
  const meta = {
    source: 'template',
    status: 'completed',
    updatedAt: new Date().toISOString(),
    error: ''
  };

  try {
    const settings = await getLLMSettings();
    if (settings.apiKey) {
      await onProgress({
        stage: 'ai-report',
        percent: 94,
        message: '正在用 AI 润色日报'
      });
      const polished = await polishDailyReportWithLLM(digest, settings);
      if (polished.content?.trim()) {
        content = polished.content.trim();
        meta.source = 'llm';
        meta.tokens = polished.tokens || null;
      }
    }
  } catch (error) {
    meta.status = 'fallback';
    meta.error = String(error?.message || error);
    console.warn('[daily-report] AI polish failed, fallback to template:', meta.error);
  }

  await saveDailyReport(dateKey, `${content}\n`);
  return { content, meta };
}

async function ensureDailyRadarForDigest(dateKey, digest) {
  if (!digest) return null;
  if (digest.dailyRadar) return digest;
  const next = {
    ...digest,
    dailyRadar: buildDailyRadar(digest, dateKey)
  };
  const saved = await saveDigest(dateKey, next);
  await saveDailyReport(dateKey, buildDailyReportMarkdown(saved, dateKey));
  return saved;
}

function isScholarOnlyTrack(track) {
  return Boolean(track?.scholarId || track?.scholarUrl) && !track?.arxivAuthorQuery;
}

function sameAuthorTrack(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  const aScholar = String(a.scholarId || a.scholarUrl || '').toLowerCase();
  const bScholar = String(b.scholarId || b.scholarUrl || '').toLowerCase();
  if (aScholar && bScholar && aScholar === bScholar) return true;
  return String(a.name || '').toLowerCase().trim() === String(b.name || '').toLowerCase().trim();
}

function sanitizeScholarOnlyAuthorTrack(track) {
  const scholarCount = Number(track.newScholarPublicationCount || 0);
  return {
    ...track,
    identityOnly: true,
    identityNote: track.identityNote ||
      'Google Scholar identity linked; arXiv name search disabled until query= is provided.',
    source: track.source || 'scholar',
    hasUpdate: scholarCount > 0,
    newPaperCount: 0,
    newPapers: [],
    latestPaper: null
  };
}

async function repairScholarOnlyAuthorTrackingHistory() {
  const subscriptions = await getSubscriptions();
  const scholarOnlyTracks = (subscriptions.authorTracks || []).filter(isScholarOnlyTrack);
  if (!scholarOnlyTracks.length) return { changed: 0 };

  const all = await getDigests();
  let changed = 0;
  for (const [dateKey, digest] of Object.entries(all)) {
    const tracks = Array.isArray(digest?.authorTracking?.tracks) ? digest.authorTracking.tracks : [];
    if (!tracks.length) continue;

    let digestChanged = false;
    const nextTracks = tracks.map((track) => {
      const shouldRepair = scholarOnlyTracks.some((subscribed) => sameAuthorTrack(track, subscribed)) ||
        isScholarOnlyTrack(track);
      const hasFalseArxivData =
        Number(track.newPaperCount || 0) > 0 ||
        (Array.isArray(track.newPapers) && track.newPapers.length > 0) ||
        Boolean(track.latestPaper);
      if (!shouldRepair || !hasFalseArxivData) return track;
      digestChanged = true;
      return sanitizeScholarOnlyAuthorTrack(track);
    });
    if (!digestChanged) continue;

    const nextDigest = {
      ...digest,
      authorTracking: {
        ...digest.authorTracking,
        updatedAuthors: nextTracks.filter((track) => track.hasUpdate).length,
        tracks: nextTracks
      }
    };
    nextDigest.dailyRadar = buildDailyRadar(nextDigest, dateKey);
    const saved = await saveDigest(dateKey, nextDigest);
    await saveDailyReport(dateKey, buildDailyReportMarkdown(saved, dateKey));
    changed += 1;
  }

  if (changed) {
    console.log(`[startup] repaired Scholar-only author tracking in ${changed} digest(s)`);
  }
  return { changed };
}

async function findCatchupDates() {
  const all = await getDigests();
  const refreshState = await getRefreshState();
  const recentDates = getRecentDateKeys(catchupLookbackDays)
    .filter((dateKey) => digestNeedsCatchup(dateKey, all[dateKey], refreshState.dates?.[dateKey]));
  const failedHistoryDates = Array.from(
    new Set([...Object.keys(refreshState.dates || {}), ...Object.keys(all || {})])
  )
    .filter((dateKey) => dateKeyInRecentWindow(dateKey, catchupFailedLookbackDays))
    .filter((dateKey) => {
      const record = refreshState.dates?.[dateKey];
      const digest = all[dateKey];
      const recordStatus = String(record?.status || '').toLowerCase();
      const digestStatus = digest?.generatedAt ? getDigestRefreshStatus(digest) : '';
      const staleByStatus =
        ['failed', 'partial', 'interrupted'].includes(recordStatus) ||
        ['failed', 'partial'].includes(digestStatus);
      return staleByStatus && digestNeedsCatchup(dateKey, digest, record);
    })
    .sort((a, b) => (a < b ? 1 : -1));

  const seen = new Set();
  const dates = [];
  for (const dateKey of [...recentDates, ...failedHistoryDates]) {
    if (seen.has(dateKey)) continue;
    seen.add(dateKey);
    dates.push(dateKey);
  }
  return dates.slice(0, catchupMaxDates);
}

async function dateStillNeedsCatchup(dateKey) {
  const all = await getDigests();
  const refreshState = await getRefreshState();
  return digestNeedsCatchup(dateKey, all[dateKey], refreshState.dates?.[dateKey]);
}

async function runCatchupQueue(reason = 'catchup') {
  if (catchupQueuePromise) {
    console.log(`[catchup] reuse running queue (${reason})`);
    return catchupQueuePromise;
  }

  const job = (async () => {
    catchupQueueRunning = true;
    try {
      const dates = await findCatchupDates();
      if (!dates.length) {
        console.log(
          `[catchup] no backlog within last ${catchupLookbackDays} day(s) or failed history ${catchupFailedLookbackDays} day(s)`
        );
        return { started: false, reason: 'empty', dates: [] };
      }

      console.log(`[catchup] queueing ${dates.length} day(s): ${dates.join(', ')}`);
      const results = [];
      for (let index = 0; index < dates.length; index += 1) {
        const dateKey = dates[index];
        await waitForActiveRefreshes();
        if (index > 0 && catchupDelayMs > 0) {
          await sleep(catchupDelayMs);
        }
        if (!(await dateStillNeedsCatchup(dateKey))) {
          results.push({ dateKey, skipped: true, reason: 'fresh-enough' });
          continue;
        }
        try {
          const digest = await runRefreshForDate(dateKey, reason);
          results.push({
            dateKey,
            paperCount: digest?.papers?.length || 0,
            generatedAt: digest?.generatedAt || null
          });
        } catch (error) {
          const message = String(error?.message || error);
          results.push({ dateKey, failed: true, error: message });
          console.warn(`[catchup] stopped after ${dateKey} failed: ${message}`);
          break;
        }
      }
      return { started: true, reason, dates, results };
    } finally {
      catchupQueueRunning = false;
      catchupQueuePromise = null;
    }
  })();

  catchupQueuePromise = job;
  return job;
}

async function runRefreshForDate(dateKey = todayDateKey(), reason = 'manual') {
  if (activeRefreshes.has(dateKey)) {
    console.log(`[refresh] reuse running job for ${dateKey} (${reason})`);
    return activeRefreshes.get(dateKey);
  }

  const startedAt = Date.now();
  const job = (async () => {
    const previousState = await getRefreshState();
    const previousRecord = previousState.dates?.[dateKey] || {};
    const isRetry = String(reason).startsWith('retry');
    const attempt = isRetry ? Number(previousRecord.attempt || 0) + 1 : 1;
    await updateRefreshRecord(dateKey, {
      status: 'running',
      reason,
      attempt,
      lastStartedAt: new Date(startedAt).toISOString(),
      lastCompletedAt: null,
      durationMs: null,
      error: null,
      nextRetryAt: null,
      retryNote: '',
      progress: normalizeProgress({
        stage: 'queued',
        percent: 0,
        message: '刷新任务已启动'
      })
    });

    try {
      const digest = await refreshDigestForDate(dateKey, {
        onProgress: async (progress) => {
          await updateRefreshRecord(dateKey, {
            progress: normalizeProgress(progress)
          });
        }
      });
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const status = classifyDigestRefresh(digest);
      console.log(
        `[refresh] ${dateKey} completed in ${seconds}s (${reason}), status=${status}, papers=${digest.papers?.length || 0}`
      );
      await updateRefreshRecord(dateKey, {
        status,
        reason,
        attempt,
        lastCompletedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        paperCount: digest.papers?.length || 0,
        totalCandidates: digest.totalCandidates || 0,
        taskCount: digest.taskCount || 0,
        failedTasks: digest.failedTasks || 0,
        failedTaskDetails: digest.failedTaskDetails || [],
        notice: digest.notice || '',
        error: null,
        nextRetryAt: null,
        retryNote: '',
        progress: normalizeProgress({
          stage: 'done',
          percent: 100,
          message: '刷新完成'
        })
      });

      if (shouldRetryRefresh(status)) {
        await scheduleRetry(dateKey, reason, attempt);
      } else {
        clearRetry(dateKey);
      }

      if (shouldNotifyForReason(reason)) {
        const message = buildNotificationMessage(digest);
        sendDesktopNotification('PaperRadar 今日推荐已更新', message).catch(() => {});
      }

      return digest;
    } catch (error) {
      const message = String(error?.message || error);
      console.error(`[refresh] ${dateKey} failed (${reason})`, error);
      await updateRefreshRecord(dateKey, {
        status: 'failed',
        reason,
        attempt,
        lastCompletedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        error: message,
        nextRetryAt: null,
        progress: normalizeProgress({
          stage: 'failed',
          percent: 100,
          message: `刷新失败：${message}`
        })
      });
      await scheduleRetry(dateKey, reason, attempt);
      throw error;
    } finally {
      activeRefreshes.delete(dateKey);
    }
  })();

  activeRefreshes.set(dateKey, job);
  return job;
}

async function refreshTodayIfMissing() {
  if (!refreshOnStartup) return;

  const dateKey = todayDateKey();
  const result = await ensureDigestForDate(dateKey, 'startup');
  if (!result.started) {
    console.log(`[startup] digest for ${dateKey} already cached`);
  }
}

async function ensureDigestForDate(dateKey, reason = 'ensure') {
  if (activeRefreshes.has(dateKey)) {
    return { dateKey, started: false, reason: 'already-running' };
  }

  const all = await getDigests();
  const refreshState = await getRefreshState();
  const record = refreshState.dates?.[dateKey] || null;
  const digest = all[dateKey] || null;
  const needsRefresh = digestNeedsCatchup(dateKey, digest, record, { respectRetry: false });
  const waitingForRetry = isWaitingForRetry(record);

  if (!needsRefresh) {
    return { dateKey, started: false, reason: 'fresh-enough', record };
  }
  if (waitingForRetry && !['catchup', 'manual-background'].includes(reason)) {
    return { dateKey, started: false, reason: 'waiting-for-retry', record };
  }

  console.log(`[${reason}] refreshing ${dateKey}; needsRefresh=${needsRefresh}`);
  runRefreshForDate(dateKey, reason)
    .catch((error) => {
      console.error(`[${reason}] refresh failed`, error);
    });
  return { dateKey, started: true, reason, record };
}

async function markInterruptedRefreshesOnStartup() {
  const state = await getRefreshState();
  let changed = false;
  for (const [dateKey, record] of Object.entries(state.dates || {})) {
    if (record?.status !== 'running') continue;
    state.dates[dateKey] = {
      ...record,
      status: 'interrupted',
      lastCompletedAt: new Date().toISOString(),
      error: '服务重启时刷新任务中断',
      progress: normalizeProgress({
        stage: 'interrupted',
        percent: Number(record.progress?.percent || 0),
        message: '服务重启时刷新任务中断'
      }),
      updatedAt: new Date().toISOString()
    };
    changed = true;
  }
  if (changed) {
    state.lastUpdatedAt = new Date().toISOString();
    await saveRefreshState(state);
  }
}

async function getPaperFromDigest(date, paperId) {
  const all = await getDigests();
  const digest = all[date];
  if (!digest) {
    throw new Error('Digest not found for date.');
  }
  const paper = (digest.papers || []).find((item) => item.id === paperId);
  if (!paper) {
    throw new Error('Paper not found in selected date.');
  }
  return paper;
}

app.get('/api/subscriptions', async (_req, res) => {
  const data = await getSubscriptions();
  res.json(data);
});

app.put('/api/subscriptions', async (req, res) => {
  const data = await updateSubscriptions(req.body || {});
  res.json(data);
});

app.post('/api/digest/refresh', async (req, res) => {
  try {
    const dateKey = req.body?.date || todayDateKey();
    const digest = await runRefreshForDate(dateKey, 'api-refresh');
    res.json({ date: dateKey, digest });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post('/api/digest/refresh-background', async (req, res) => {
  try {
    const dateKey = req.body?.date || todayDateKey();
    if (activeRefreshes.has(dateKey)) {
      res.json({ date: dateKey, started: false, reason: 'already-running' });
      return;
    }
    runRefreshForDate(dateKey, 'manual-background').catch((error) => {
      console.error('[refresh] background refresh failed', error);
    });
    res.json({ date: dateKey, started: true });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get('/api/digest/refresh-status', async (req, res) => {
  const dateKey = String(req.query?.date || todayDateKey());
  const state = await getRefreshState();
  const all = await getDigests();
  const digest = all[dateKey] || null;
  const synthesizedRecord = digest?.generatedAt
    ? {
        status: classifyDigestRefresh(digest),
        lastCompletedAt: digest.generatedAt,
        paperCount: digest.papers?.length || 0,
        totalCandidates: digest.totalCandidates || 0,
        taskCount: digest.taskCount || 0,
        failedTasks: digest.failedTasks || 0,
        notice: digest.notice || '',
        progress: normalizeProgress({
          stage: 'done',
          percent: 100,
          message: '刷新完成'
        }),
        synthesized: true
      }
    : null;
  const history = Object.entries(state.dates || {})
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, 14)
    .map(([date, record]) => ({ date, ...record }));
  res.json({
    date: dateKey,
    today: todayDateKey(),
    runningDates: Array.from(activeRefreshes.keys()),
    catchupQueueRunning,
    schedule: refreshCron,
    catchupSchedule: refreshCatchupCron,
    timezone: refreshTimezone,
    refreshOnStartup,
    catchup: {
      lookbackDays: catchupLookbackDays,
      failedLookbackDays: catchupFailedLookbackDays,
      maxDates: catchupMaxDates,
      delayMs: catchupDelayMs
    },
    retry: {
      limit: refreshRetryLimit,
      minutes: refreshRetryMinutes
    },
    record: state.dates?.[dateKey] || synthesizedRecord,
    history
  });
});

app.post('/api/digest/ensure-today', async (_req, res) => {
  try {
    const result = await ensureDigestForDate(todayDateKey(), 'open-page');
    runCatchupQueue('open-page-catchup').catch((error) => {
      console.error('[catchup] open-page catchup failed', error);
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post('/api/digest/catchup', async (_req, res) => {
  try {
    const result = await runCatchupQueue('api-catchup');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get('/api/digest/today', async (_req, res) => {
  const dateKey = todayDateKey();
  const all = await getDigests();
  const state = await getRefreshState();
  const digest = await ensureDailyRadarForDigest(dateKey, all[dateKey] || null);
  res.json({
    date: dateKey,
    digest,
    refresh: state.dates?.[dateKey] || null,
    running: activeRefreshes.has(dateKey)
  });
});

app.get('/api/digest/dates', async (_req, res) => {
  const all = await getDigests();
  const dates = Object.keys(all).sort((a, b) => (a < b ? 1 : -1));
  res.json(dates);
});

app.get('/api/digest/summary', async (_req, res) => {
  const all = await getDigests();
  const summary = Object.fromEntries(
    Object.entries(all).map(([date, digest]) => {
      const radar = digest?.dailyRadar || buildDailyRadar(digest, date);
      const recommended = Array.isArray(digest?.papers) ? digest.papers.length : 0;
      const failedTasks = Number(digest?.failedTasks || radar.metrics?.failedTasks || 0);
      const taskCount = Number(digest?.taskCount || radar.metrics?.taskCount || 0);
      return [
        date,
        {
          status: radar.status || classifyDigestRefresh(digest),
          recommended,
          totalCandidates: Number(digest?.totalCandidates || radar.metrics?.totalCandidates || 0),
          failedTasks,
          taskCount,
          generatedAt: digest?.generatedAt || null,
          notice: digest?.notice || ''
        }
      ];
    })
  );
  res.json(summary);
});

app.get('/api/digest/:date', async (req, res) => {
  const date = req.params.date;
  const all = await getDigests();
  if (!all[date]) {
    res.status(404).json({ error: 'Digest not found for that date.' });
    return;
  }
  const digest = await ensureDailyRadarForDigest(date, all[date]);
  res.json(digest);
});

app.get('/api/digest/report/:date', async (req, res) => {
  const dateKey = req.params.date;
  const existing = await getDailyReport(dateKey);
  if (existing) {
    res.type('text/markdown').send(existing);
    return;
  }

  const all = await getDigests();
  if (all[dateKey]) {
    const digest = await ensureDailyRadarForDigest(dateKey, all[dateKey]);
    const markdown = buildDailyReportMarkdown(digest, dateKey);
    await saveDailyReport(dateKey, markdown);
    res.type('text/markdown').send(markdown);
    return;
  }

  res.status(404).type('text/plain').send('Daily report not found.');
});

app.get('/api/paper', async (req, res) => {
  try {
    const date = String(req.query.date || '');
    const paperId = String(req.query.paperId || '');
    if (!date || !paperId) {
      res.status(400).json({ error: 'date and paperId are required.' });
      return;
    }
    const paper = await getPaperFromDigest(date, paperId);
    res.json(paper);
  } catch (error) {
    res.status(404).json({ error: String(error.message || error) });
  }
});

app.get('/api/paper/ai', async (req, res) => {
  try {
    const date = String(req.query.date || '');
    const paperId = String(req.query.paperId || '');
    if (!date || !paperId) {
      res.status(400).json({ error: 'date and paperId are required.' });
      return;
    }
    const record = await getPaperAiRecord(date, paperId);
    res.json(record);
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.put('/api/paper/ai', async (req, res) => {
  try {
    const date = String(req.body?.date || '');
    const paperId = String(req.body?.paperId || '');
    const kind = String(req.body?.kind || '');
    if (!date || !paperId || !['summary', 'insight'].includes(kind)) {
      res.status(400).json({ error: 'date, paperId and valid kind are required.' });
      return;
    }
    const saved = await savePaperAiRecord(date, paperId, kind, {
      content: req.body?.content,
      status: req.body?.status,
      finishReason: req.body?.finishReason,
      updatedAt: req.body?.updatedAt
    });
    res.json(saved);
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post('/api/digest/fetch/:date', async (req, res) => {
  try {
    const dateKey = req.params.date;
    const digest = await runRefreshForDate(dateKey, 'api-fetch');
    res.json({ date: dateKey, digest });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get('/api/author-tracks/status', async (req, res) => {
  try {
    const dateKey = String(req.query?.date || todayDateKey());
    const all = await getDigests();
    const existing = all[dateKey]?.authorTracking;
    if (existing) {
      res.json(existing);
      return;
    }
    const status = await checkAuthorTracksForDate(dateKey);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post('/api/author-tracks/check', async (req, res) => {
  try {
    const dateKey = String(req.body?.date || todayDateKey());
    const status = await checkAuthorTracksForDate(dateKey);
    const all = await getDigests();
    if (all[dateKey]) {
      const nextDigest = {
        ...all[dateKey],
        authorTracking: status
      };
      nextDigest.dailyRadar = buildDailyRadar(nextDigest, dateKey);
      await saveDigest(dateKey, nextDigest);
    }
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get('/api/marks/summary', async (_req, res) => {
  const marks = await getMarks();
  const summary = Object.fromEntries(
    Object.entries(marks).map(([date, ids]) => [date, Array.isArray(ids) ? ids.length : 0])
  );
  res.json(summary);
});

app.get('/api/marks/:date', async (req, res) => {
  const paperIds = await getMarksByDate(req.params.date);
  res.json({ paperIds });
});

app.put('/api/marks/:date', async (req, res) => {
  const paperIds = await saveMarksByDate(req.params.date, req.body?.paperIds || []);
  res.json({ paperIds });
});

app.post('/api/marks/:date/toggle', async (req, res) => {
  const paperId = req.body?.paperId;
  if (!paperId) {
    res.status(400).json({ error: 'paperId is required.' });
    return;
  }
  const result = await toggleMark(req.params.date, paperId);
  res.json(result);
});

app.get('/api/llm/settings', async (_req, res) => {
  const settings = await getLLMSettings();
  res.json(settings);
});

app.put('/api/llm/settings', async (req, res) => {
  const settings = await updateLLMSettings(req.body || {});
  res.json(settings);
});

app.post('/api/llm/summarize', async (req, res) => {
  try {
    const date = req.body?.date;
    const paperId = req.body?.paperId;
    if (!date || !paperId) {
      res.status(400).json({ error: 'date and paperId are required.' });
      return;
    }
    const paper = await getPaperFromDigest(date, paperId);
    const settings = await getLLMSettings();
    const summary = await summarizePaperWithLLM(paper, settings);
    res.json({ paperId, date, ...summary });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post('/api/llm/summarize/stream', async (req, res) => {
  try {
    const date = req.body?.date;
    const paperId = req.body?.paperId;
    if (!date || !paperId) {
      res.status(400).json({ error: 'date and paperId are required.' });
      return;
    }
    const paper = await getPaperFromDigest(date, paperId);
    const settings = await getLLMSettings();

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    await streamSummaryWithLLM(paper, settings, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: String(error.message || error) })}\n\n`);
    res.end();
  }
});

app.post('/api/llm/chat/stream', async (req, res) => {
  try {
    const date = req.body?.date;
    const paperId = req.body?.paperId;
    const message = String(req.body?.message || '');
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    if (!date || !paperId || !message) {
      res.status(400).json({ error: 'date, paperId and message are required.' });
      return;
    }

    const paper = await getPaperFromDigest(date, paperId);
    const settings = await getLLMSettings();
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    await streamChatWithPaper(paper, settings, history, message, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: String(error.message || error) })}\n\n`);
    res.end();
  }
});

app.post('/api/llm/insight/stream', async (req, res) => {
  try {
    const date = req.body?.date;
    const paperId = req.body?.paperId;
    if (!date || !paperId) {
      res.status(400).json({ error: 'date and paperId are required.' });
      return;
    }

    const paper = await getPaperFromDigest(date, paperId);
    const settings = await getLLMSettings();
    const subscriptions = await getSubscriptions();
    const insightInterests = Array.isArray(subscriptions.insightInterests)
      ? subscriptions.insightInterests
      : [];
    if (!insightInterests.length) {
      res.status(400).json({ error: '请先在设置中填写研究启发关注方向。' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    await streamInsightWithLLM(paper, settings, insightInterests, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: String(error.message || error) })}\n\n`);
    res.end();
  }
});

function scheduleDailyRefresh() {
  if (!cron.validate(refreshCron)) {
    console.warn(`[cron] invalid REFRESH_CRON "${refreshCron}", daily refresh disabled`);
  } else {
    cron.schedule(
      refreshCron,
      async () => {
        try {
          await runRefreshForDate(todayDateKey(), 'cron');
        } catch (error) {
          console.error('[cron] refresh failed', error);
        }
      },
      { timezone: refreshTimezone }
    );
    console.log(`[cron] daily digest scheduled: ${refreshCron} (${refreshTimezone})`);
  }

  if (!cron.validate(refreshCatchupCron)) {
    console.warn(`[cron] invalid REFRESH_CATCHUP_CRON "${refreshCatchupCron}", catchup disabled`);
    return;
  }

  cron.schedule(
    refreshCatchupCron,
    async () => {
      try {
        await runCatchupQueue('cron-catchup');
      } catch (error) {
        console.error('[cron] catchup failed', error);
      }
    },
    { timezone: refreshTimezone }
  );
  console.log(`[cron] catchup scheduled: ${refreshCatchupCron} (${refreshTimezone})`);
}

if (process.argv.includes('--refresh-once')) {
  runRefreshForDate(todayDateKey(), 'refresh-once')
    .then(() => {
      console.log('Digest refreshed once.');
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
} else {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
  markInterruptedRefreshesOnStartup()
    .then(() => repairScholarOnlyAuthorTrackingHistory())
    .then(() => {
      scheduleDailyRefresh();
      return refreshTodayIfMissing();
    })
    .then(() => {
      if (!refreshOnStartup) return null;
      return runCatchupQueue('startup-catchup').catch((error) => {
        console.error('[startup] catchup queue failed', error);
      });
    })
    .catch((error) => {
      console.error('[startup] refresh check failed', error);
    });
}
