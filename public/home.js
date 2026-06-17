import { getJson, loadAndBindSettingsForms, setupSettingsPanel } from './settings.js';

const monthTitleEl = document.querySelector('#monthTitle');
const calendarGridEl = document.querySelector('#calendarGrid');
const calendarMetaEl = document.querySelector('#calendarMeta');
const todayRefreshBadgeEl = document.querySelector('#todayRefreshBadge');
const todayRadarMetaEl = document.querySelector('#todayRadarMeta');
const todayRadarTopEl = document.querySelector('#todayRadarTop');
const todayAuthorUpdatesEl = document.querySelector('#todayAuthorUpdates');
const todayDetailLinkEl = document.querySelector('#todayDetailLink');
const todayReportLinkEl = document.querySelector('#todayReportLink');
const refreshTodayBtn = document.querySelector('#refreshTodayBtn');
const todayProgressEl = document.querySelector('#todayProgress');
const todayProgressBarEl = document.querySelector('#todayProgressBar');
const todayProgressTextEl = document.querySelector('#todayProgressText');

const state = {
  viewDate: new Date(),
  todayKey: '',
  digestDates: new Set(),
  digestSummary: {},
  markSummary: {},
  todayDigest: null,
  todayRefresh: null,
  todayRunning: false,
  pollTimer: null
};

function dateKeyFromParts(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function localDateKey(date = new Date()) {
  return dateKeyFromParts(date.getFullYear(), date.getMonth(), date.getDate());
}

function setBadge(el, label, kind = '') {
  if (!el) return;
  el.textContent = label;
  el.className = `status-badge ${kind}`.trim();
}

function statusLabel(record, running, digest) {
  if (running || record?.status === 'running') {
    return { label: '刷新中', kind: 'running' };
  }
  if (record?.status === 'failed') {
    return { label: '刷新失败', kind: 'failed' };
  }
  if (record?.status === 'interrupted') {
    return { label: '刷新中断', kind: 'failed' };
  }
  if (record?.status === 'partial') {
    return { label: '部分结果', kind: 'partial' };
  }
  if (record?.status === 'success' || digest?.generatedAt) {
    return { label: '已刷新', kind: 'ready' };
  }
  return { label: '未刷新', kind: '' };
}

function paperHref(paper, dateKey) {
  return `/paper.html?date=${encodeURIComponent(dateKey)}&paperId=${encodeURIComponent(paper.id)}`;
}

function renderRadarItem(paper, dateKey) {
  const link = document.createElement('a');
  link.className = 'radar-item';
  link.href = paperHref(paper, dateKey);
  const title = document.createElement('h3');
  title.textContent = `${paper.rank}. ${paper.title}`;
  const why = document.createElement('p');
  why.className = 'why';
  why.textContent = `推荐分 ${paper.score} · ${paper.why || '综合相关性'}`;
  const abstract = document.createElement('p');
  abstract.className = 'abstract-hint';
  abstract.textContent = paper.abstractHint || '';
  link.append(title, why, abstract);
  return link;
}

function renderAuthorUpdates(container, updates) {
  if (!container) return;
  container.innerHTML = '';
  const list = Array.isArray(updates) ? updates : [];
  if (!list.length) return;

  list.forEach((update) => {
    const block = document.createElement('div');
    block.className = 'author-update';
    const title = document.createElement('strong');
    const total = Number(update.totalNewCount || 0) ||
      Number(update.newPaperCount || 0) + Number(update.newScholarPublicationCount || 0);
    const parts = [
      update.newPaperCount ? `arXiv ${update.newPaperCount}` : '',
      update.newScholarPublicationCount ? `Scholar ${update.newScholarPublicationCount}` : ''
    ].filter(Boolean);
    title.textContent = `${update.name} 更新 ${total} 篇${parts.length ? `（${parts.join('，')}）` : ''}`;
    block.appendChild(title);

    (update.newPapers || []).forEach((paper) => {
      const link = document.createElement('a');
      link.href = paper.url || paper.id;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = paper.title;
      block.appendChild(link);
    });

    (update.newScholarPublications || []).forEach((paper) => {
      const link = document.createElement('a');
      link.href = paper.url || '#';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = paper.year ? `${paper.title} (${paper.year})` : paper.title;
      block.appendChild(link);
    });

    container.appendChild(block);
  });
}

function renderTodayRadar() {
  const digest = state.todayDigest;
  const radar = digest?.dailyRadar;
  const badge = statusLabel(state.todayRefresh, state.todayRunning, digest);
  setBadge(todayRefreshBadgeEl, badge.label, badge.kind);
  renderProgress(
    todayProgressEl,
    todayProgressBarEl,
    todayProgressTextEl,
    state.todayRefresh?.progress,
    state.todayRunning || state.todayRefresh?.status === 'running'
  );

  if (todayDetailLinkEl) {
    todayDetailLinkEl.href = `/day.html?date=${state.todayKey}`;
  }
  if (todayReportLinkEl) {
    todayReportLinkEl.href = `/api/digest/report/${state.todayKey}`;
    todayReportLinkEl.style.display = digest?.generatedAt ? '' : 'none';
  }

  if (!todayRadarTopEl || !todayRadarMetaEl) return;
  todayRadarTopEl.innerHTML = '';
  renderAuthorUpdates(todayAuthorUpdatesEl, radar?.authorUpdates || []);

  if (!radar) {
    const nextRetry = state.todayRefresh?.nextRetryAt
      ? ` 下次重试：${new Date(state.todayRefresh.nextRetryAt).toLocaleString()}`
      : '';
    todayRadarMetaEl.textContent = state.todayRunning
      ? '正在后台准备今日推荐。'
      : `今日推荐还没准备好。${nextRetry}`;
    return;
  }

  const generatedAt = radar.generatedAt ? new Date(radar.generatedAt).toLocaleString() : '';
  const failedTasks = radar.metrics.failedTasks
    ? `，失败任务 ${radar.metrics.failedTasks}/${radar.metrics.taskCount}`
    : '';
  todayRadarMetaEl.textContent =
    `${radar.headline} 候选 ${radar.metrics.totalCandidates} 篇${failedTasks}。${generatedAt ? `刷新时间：${generatedAt}` : ''}`;

  const topPapers = radar.topPapers || [];
  if (!topPapers.length) {
    const empty = document.createElement('p');
    empty.className = 'meta';
    empty.textContent = '暂无优先推荐。';
    todayRadarTopEl.appendChild(empty);
    return;
  }

  topPapers.forEach((paper) => {
    todayRadarTopEl.appendChild(renderRadarItem(paper, state.todayKey));
  });
}

function renderProgress(shellEl, barEl, textEl, progress, visible) {
  if (!shellEl || !barEl || !textEl) return;
  shellEl.hidden = !visible;
  if (!visible) return;
  const percent = Math.max(0, Math.min(100, Math.round(Number(progress?.percent || 0))));
  barEl.style.width = `${percent}%`;
  const message = progress?.message || '正在刷新';
  const count = progress?.total ? `（${progress.current || 0}/${progress.total}）` : '';
  textEl.textContent = `${message}${count} · ${percent}%`;
}

function calendarDayState(dateKey, isToday, isFuture, markCount) {
  if (isFuture) {
    return {
      className: 'future',
      note: isToday ? '今日 · 未到' : '未到',
      aria: '未到日期'
    };
  }

  const digest = state.digestSummary[dateKey] || null;
  const parts = [];
  if (isToday) parts.push('今日');
  if (markCount) parts.push(`Mark ${markCount}`);

  if (!digest) {
    parts.push('未刷新');
    return {
      className: 'not-refreshed',
      note: parts.join(' · '),
      aria: '未刷新推荐'
    };
  }

  if (digest.status === 'failed') {
    parts.push('刷新失败');
    return {
      className: 'failed',
      note: parts.join(' · '),
      aria: '刷新失败'
    };
  }

  if (digest.status === 'partial') {
    parts.push('部分结果');
    return {
      className: 'partial',
      note: parts.join(' · '),
      aria: '部分结果'
    };
  }

  const recommended = Number(digest.recommended || 0);
  parts.push(recommended > 0 ? `推荐 ${recommended}` : '无推荐');
  return {
    className: recommended > 0 ? 'has-recommendations' : 'no-recommendations',
    note: parts.join(' · '),
    aria: recommended > 0 ? `有 ${recommended} 篇推荐` : '已刷新但无推荐'
  };
}

async function loadTodayRadar() {
  await getJson('/api/digest/ensure-today', { method: 'POST' }).catch(() => null);
  const payload = await getJson('/api/digest/today');
  state.todayKey = payload.date || state.todayKey;
  state.todayDigest = payload.digest;
  state.todayRefresh = payload.refresh;
  state.todayRunning = Boolean(payload.running);
  renderTodayRadar();

  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.todayRunning || state.todayRefresh?.status === 'running') {
    state.pollTimer = setTimeout(() => {
      loadTodayRadar().catch(() => {});
    }, 2000);
  }
}

function renderCalendar() {
  const year = state.viewDate.getFullYear();
  const month = state.viewDate.getMonth();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leading = (first.getDay() + 6) % 7;

  monthTitleEl.textContent = `${year}年 ${month + 1}月`;
  calendarGridEl.innerHTML = '';

  ['一', '二', '三', '四', '五', '六', '日'].forEach((w) => {
    const label = document.createElement('div');
    label.className = 'weekday';
    label.textContent = w;
    calendarGridEl.appendChild(label);
  });

  for (let i = 0; i < leading; i += 1) {
    const empty = document.createElement('div');
    empty.className = 'day-cell empty';
    calendarGridEl.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = dateKeyFromParts(year, month, day);
    const hasDigest = state.digestDates.has(key);
    const markCount = state.markSummary[key] || 0;
    const isToday = key === state.todayKey;
    const isFuture = key > state.todayKey;
    const dayState = calendarDayState(key, isToday, isFuture, markCount);

    const btn = document.createElement('button');
    btn.className = [
      'day-cell',
      hasDigest ? 'has-digest' : '',
      dayState.className,
      isToday ? 'today' : ''
    ]
      .filter(Boolean)
      .join(' ');
    btn.type = 'button';
    if (isFuture) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
    }
    if (isToday) btn.setAttribute('aria-current', 'date');
    btn.setAttribute('title', `${key}：${dayState.aria}`);
    btn.innerHTML = `<span class="day-number">${day}</span><small class="day-note">${dayState.note}</small>`;
    if (!isFuture) {
      btn.addEventListener('click', () => {
        window.location.href = `/day.html?date=${key}`;
      });
    }
    calendarGridEl.appendChild(btn);
  }
}

async function loadCalendarData() {
  const [dates, digestSummary, markSummary] = await Promise.all([
    getJson('/api/digest/dates'),
    getJson('/api/digest/summary'),
    getJson('/api/marks/summary')
  ]);
  state.digestDates = new Set(dates);
  state.digestSummary = digestSummary || {};
  state.markSummary = markSummary;
}

document.querySelector('#prevMonth').addEventListener('click', () => {
  state.viewDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() - 1, 1);
  renderCalendar();
});

document.querySelector('#nextMonth').addEventListener('click', () => {
  state.viewDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() + 1, 1);
  renderCalendar();
});

refreshTodayBtn?.addEventListener('click', async () => {
  refreshTodayBtn.disabled = true;
  refreshTodayBtn.textContent = '刷新中';
  try {
    await getJson('/api/digest/refresh-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: state.todayKey || localDateKey() })
    });
    await loadTodayRadar();
  } catch (error) {
    todayRadarMetaEl.textContent = `刷新启动失败：${error.message}`;
  } finally {
    setTimeout(() => {
      refreshTodayBtn.disabled = false;
      refreshTodayBtn.textContent = '后台刷新';
    }, 900);
  }
});

async function boot() {
  state.todayKey = localDateKey();
  if (calendarMetaEl) {
    calendarMetaEl.textContent = `今日日期：${state.todayKey}，点击某个日期进入详情页`;
  }
  setupSettingsPanel();
  await loadAndBindSettingsForms();
  await Promise.all([
    loadCalendarData(),
    loadTodayRadar()
  ]);
  renderCalendar();
}

boot().catch((error) => {
  const meta = document.querySelector('#calendarMeta');
  if (meta) meta.textContent = `初始化失败：${error.message}`;
});
