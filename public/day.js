import { getJson, loadAndBindSettingsForms, setupSettingsPanel } from './settings.js';

const params = new URLSearchParams(window.location.search);
const selectedDate = params.get('date');

const dayTitleEl = document.querySelector('#dayTitle');
const dayMetaEl = document.querySelector('#dayMeta');
const authorTrackMetaEl = document.querySelector('#authorTrackMeta');
const dayListEl = document.querySelector('#dayList');
const fetchDayBtn = document.querySelector('#fetchDayBtn');
const template = document.querySelector('#paperTemplate');
const dayRefreshBadgeEl = document.querySelector('#dayRefreshBadge');
const dayRadarHeadlineEl = document.querySelector('#dayRadarHeadline');
const dayTopPicksEl = document.querySelector('#dayTopPicks');
const dayAuthorUpdatesEl = document.querySelector('#dayAuthorUpdates');
const dayWatchListEl = document.querySelector('#dayWatchList');
const dayReportLinkEl = document.querySelector('#dayReportLink');
const dayProgressEl = document.querySelector('#dayProgress');
const dayProgressBarEl = document.querySelector('#dayProgressBar');
const dayProgressTextEl = document.querySelector('#dayProgressText');

const state = {
  digest: null,
  marks: new Set(),
  refresh: null,
  running: false,
  pollTimer: null
};

function setBadge(el, label, kind = '') {
  if (!el) return;
  el.textContent = label;
  el.className = `status-badge ${kind}`.trim();
}

function statusLabel(record, digest, running = false) {
  if (running || record?.status === 'running') return { label: '刷新中', kind: 'running' };
  if (record?.status === 'failed') return { label: '刷新失败', kind: 'failed' };
  if (record?.status === 'interrupted') return { label: '刷新中断', kind: 'failed' };
  if (record?.status === 'partial') return { label: '部分结果', kind: 'partial' };
  if (record?.status === 'success' || digest?.generatedAt) return { label: '已刷新', kind: 'ready' };
  return { label: '未刷新', kind: '' };
}

function paperHref(paper) {
  return `/paper.html?date=${encodeURIComponent(selectedDate)}&paperId=${encodeURIComponent(paper.id)}`;
}

function renderRadarItem(paper) {
  const link = document.createElement('a');
  link.className = 'radar-item';
  link.href = paperHref(paper);
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

function renderCompactItem(paper) {
  const link = document.createElement('a');
  link.className = 'radar-compact-item';
  link.href = paperHref(paper);
  const rank = document.createElement('span');
  rank.textContent = `#${paper.rank}`;
  const title = document.createElement('strong');
  title.textContent = paper.title;
  const score = document.createElement('span');
  score.className = 'score';
  score.textContent = String(paper.score);
  link.append(rank, title, score);
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

function sortedPapers(papers) {
  return [...papers].sort((a, b) => {
    const am = state.marks.has(a.id) ? 1 : 0;
    const bm = state.marks.has(b.id) ? 1 : 0;
    if (am !== bm) return bm - am;
    return (b.score || 0) - (a.score || 0);
  });
}

function renderList() {
  dayListEl.innerHTML = '';
  if (authorTrackMetaEl) {
    const tracking = state.digest?.authorTracking;
    if (!tracking?.totalTracked) {
      authorTrackMetaEl.textContent = '';
    } else {
      const updated = Number(tracking.updatedAuthors || 0);
      const chips = (tracking.tracks || [])
        .filter((item) => item.hasUpdate)
        .slice(0, 4)
        .map((item) => `${item.name} +${
          Number(item.newPaperCount || 0) + Number(item.newScholarPublicationCount || 0)
        }`);
      const tail = chips.length ? ` 更新作者：${chips.join('；')}` : '';
      authorTrackMetaEl.textContent = `作者追踪：${updated}/${tracking.totalTracked} 位有更新。${tail}`;
    }
  }

  if (!state.digest || !state.digest.papers.length) {
    dayMetaEl.textContent = state.digest?.notice || '该日期暂无论文，点击“获取当日论文推荐”试试。';
    return;
  }

  const markedCount = state.digest.papers.filter((paper) => state.marks.has(paper.id)).length;
  const tail = state.digest.notice ? ` ${state.digest.notice}` : '';
  dayMetaEl.textContent = `推荐数：${state.digest.papers.length}，Mark：${markedCount}。点击论文进入阅读与AI解读页。${tail}`;

  for (const paper of sortedPapers(state.digest.papers)) {
    const node = template.content.cloneNode(true);
    const card = node.querySelector('.paper-card');
    node.querySelector('h3').textContent = paper.title;
    node.querySelector('.score').textContent = `推荐分 ${paper.score}`;
    node.querySelector('.authors').textContent = `作者：${paper.authors.join(', ') || '未知'}`;
    node.querySelector('.summary').textContent = paper.summary;
    node.querySelector('.reasons').textContent = `推荐理由：${(paper.reasons || []).join(' | ') || '综合相关性'}`;
    node.querySelector('.published').textContent = `发布时间：${new Date(paper.published).toLocaleDateString()}`;

    const absLink = node.querySelector('.abs');
    absLink.href = paper.url;
    absLink.addEventListener('click', (event) => event.stopPropagation());
    const pdfLink = node.querySelector('.pdf');
    if (paper.pdfUrl) {
      pdfLink.href = paper.pdfUrl;
      pdfLink.addEventListener('click', (event) => event.stopPropagation());
    } else {
      pdfLink.remove();
    }

    const marked = state.marks.has(paper.id);
    card.classList.toggle('marked-first', marked);
    card.classList.add('selectable');
    card.addEventListener('click', () => {
      window.location.href = `/paper.html?date=${encodeURIComponent(selectedDate)}&paperId=${encodeURIComponent(paper.id)}`;
    });

    dayListEl.appendChild(node);
  }
}

function renderDailyRadar() {
  const digest = state.digest;
  const radar = digest?.dailyRadar;
  const badge = statusLabel(state.refresh, digest, state.running);
  setBadge(dayRefreshBadgeEl, badge.label, badge.kind);
  renderProgress(
    dayProgressEl,
    dayProgressBarEl,
    dayProgressTextEl,
    state.refresh?.progress,
    state.running || state.refresh?.status === 'running'
  );
  if (dayReportLinkEl) {
    dayReportLinkEl.href = `/api/digest/report/${selectedDate}`;
    dayReportLinkEl.style.display = digest?.generatedAt ? '' : 'none';
  }
  if (!dayRadarHeadlineEl || !dayTopPicksEl || !dayWatchListEl) return;

  dayTopPicksEl.innerHTML = '';
  dayWatchListEl.innerHTML = '';
  renderAuthorUpdates(dayAuthorUpdatesEl, radar?.authorUpdates || []);

  if (!radar) {
    const nextRetry = state.refresh?.nextRetryAt
      ? ` 下次重试：${new Date(state.refresh.nextRetryAt).toLocaleString()}`
      : '';
    dayRadarHeadlineEl.textContent = state.running || state.refresh?.status === 'running'
      ? '正在后台准备这一天的推荐。'
      : `这一天还没有可用的扫读摘要。${nextRetry}`;
    return;
  }

  const failedTasks = radar.metrics.failedTasks
    ? `，失败任务 ${radar.metrics.failedTasks}/${radar.metrics.taskCount}`
    : '';
  const generatedAt = radar.generatedAt ? new Date(radar.generatedAt).toLocaleString() : '';
  dayRadarHeadlineEl.textContent =
    `${radar.headline} 候选 ${radar.metrics.totalCandidates} 篇${failedTasks}。${generatedAt ? `刷新时间：${generatedAt}` : ''}`;

  if (!radar.topPapers?.length) {
    const empty = document.createElement('p');
    empty.className = 'meta';
    empty.textContent = '暂无优先推荐。';
    dayTopPicksEl.appendChild(empty);
  } else {
    radar.topPapers.forEach((paper) => {
      dayTopPicksEl.appendChild(renderRadarItem(paper));
    });
  }

  (radar.watchList || []).slice(0, 7).forEach((paper) => {
    dayWatchListEl.appendChild(renderCompactItem(paper));
  });
}

function scheduleStatusPoll() {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  if (!state.running && state.refresh?.status !== 'running') return;
  state.pollTimer = setTimeout(() => {
    loadExistingDigestAndMarks().catch(() => {});
  }, 2000);
}

async function loadExistingDigestAndMarks() {
  if (!selectedDate) {
    dayMetaEl.textContent = '缺少日期参数。';
    return;
  }

  dayTitleEl.textContent = `${selectedDate} 论文详情`;
  const [digestResult, marks, refreshStatus] = await Promise.all([
    getJson(`/api/digest/${selectedDate}`).catch(() => ({ papers: [] })),
    getJson(`/api/marks/${selectedDate}`),
    getJson(`/api/digest/refresh-status?date=${encodeURIComponent(selectedDate)}`).catch(() => null)
  ]);
  state.digest = digestResult;
  state.marks = new Set(marks.paperIds || []);
  state.refresh = refreshStatus?.record || null;
  state.running = Boolean(refreshStatus?.runningDates?.includes(selectedDate));
  renderDailyRadar();
  renderList();
  scheduleStatusPoll();
}

fetchDayBtn.addEventListener('click', async () => {
  if (!selectedDate) return;
  fetchDayBtn.disabled = true;
  fetchDayBtn.textContent = '已启动';
  try {
    await getJson('/api/digest/refresh-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: selectedDate })
    });
    const refreshStatus = await getJson(`/api/digest/refresh-status?date=${encodeURIComponent(selectedDate)}`)
      .catch(() => null);
    state.refresh = refreshStatus?.record || { status: 'running' };
    state.running = true;
    renderDailyRadar();
    scheduleStatusPoll();
  } catch (error) {
    dayMetaEl.textContent = `拉取失败：${error.message}`;
  } finally {
    setTimeout(() => {
      fetchDayBtn.disabled = false;
      fetchDayBtn.textContent = '获取当日论文推荐';
    }, 900);
  }
});

async function boot() {
  setupSettingsPanel();
  await loadAndBindSettingsForms();
  await loadExistingDigestAndMarks();
}

boot().catch((error) => {
  dayMetaEl.textContent = `初始化失败：${error.message}`;
});
