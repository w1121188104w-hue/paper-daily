import { searchArxiv } from './arxiv.js';

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function resolveWindow(dateKey) {
  const anchor = dateKey ? new Date(`${dateKey}T12:00:00`) : new Date();
  const to = new Date(anchor);
  const from = new Date(anchor);
  return { dateFrom: toDateKey(from), dateTo: toDateKey(to) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function arxivRequestDelayMs() {
  return Math.max(3000, Number(process.env.ARXIV_REQUEST_DELAY_MS || 3500));
}

function taskBasePercent(doneTasks, totalTasks) {
  return Math.round((doneTasks / totalTasks) * 70);
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 2);
}

function computeOverlapScore(sourceText, query) {
  const source = new Set(tokenize(sourceText));
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (!queryTokens.length) return 0;
  const hitCount = queryTokens.filter((token) => source.has(token)).length;
  return hitCount / queryTokens.length;
}

function describeTask(spec) {
  if (Array.isArray(spec.keyword)) return `query:${spec.keyword.join(' OR ')}`;
  if (spec.keyword) return `query:${spec.keyword}`;
  if (spec.author) return `author:${spec.author}`;
  if (spec.paper) return `topic:${spec.paper}`;
  return 'unknown';
}

function scorePaper(paper, subscriptions, evidenceMap, anchorDate = new Date()) {
  let score = 0;
  const reasons = [];
  const title = paper.title || '';
  const summary = paper.summary || '';
  const text = `${title} ${summary}`;
  const titleTextLc = title.toLowerCase();
  const summaryTextLc = summary.toLowerCase();
  const titleLc = paper.title.toLowerCase();
  const authorsLc = paper.authors.map((author) => author.toLowerCase());
  const queryList = Array.isArray(subscriptions.queries) && subscriptions.queries.length
    ? subscriptions.queries
    : subscriptions.keywords;
  let lexicalHit = false;
  let authorTopicHit = false;

  for (const query of queryList) {
    const queryLc = query.toLowerCase();
    if (!queryLc) continue;
    const titlePhraseHit = titleTextLc.includes(queryLc);
    const summaryPhraseHit = summaryTextLc.includes(queryLc);
    const titleOverlap = computeOverlapScore(title, query);
    const summaryOverlap = computeOverlapScore(summary, query);

    if (titlePhraseHit || titleOverlap >= 0.45) {
      lexicalHit = true;
      score += titlePhraseHit ? 12 : Math.round(titleOverlap * 9);
      reasons.push(`标题命中:${query}`);
    }

    if (summaryPhraseHit || summaryOverlap >= 0.55) {
      lexicalHit = true;
      score += summaryPhraseHit ? 6 : Math.round(summaryOverlap * 5);
      reasons.push(`摘要命中:${query}`);
    }

    if (titleLc.includes(queryLc)) {
      score += 3;
    }
  }

  for (const person of subscriptions.people) {
    const personLc = person.toLowerCase();
    const exactAuthor = authorsLc.some((author) => author === personLc);
    const partialAuthor = authorsLc.some((author) => author.includes(personLc));
    if (exactAuthor || partialAuthor) {
      authorTopicHit = true;
      score += exactAuthor ? 14 : 9;
      reasons.push(`作者:${person}`);
    }
  }

  for (const followedPaper of subscriptions.papers) {
    const phraseHit = text.toLowerCase().includes(followedPaper.toLowerCase());
    const overlap = computeOverlapScore(text, followedPaper);
    if (phraseHit || overlap >= 0.45) {
      authorTopicHit = true;
      score += phraseHit ? 8 : Math.round(overlap * 6);
      reasons.push(`主题:${followedPaper}`);
    }
  }

  const queryHit = evidenceMap.get(paper.id) || 0;
  // Only reward multi-source recall when there is explicit lexical/author/topic evidence.
  if (queryHit > 0 && (lexicalHit || authorTopicHit)) {
    score += 2 + Math.min(queryHit, 6);
    reasons.push(`多源命中:${queryHit}`);
  }

  const days = Math.floor((anchorDate.getTime() - Date.parse(paper.published)) / 86400000);
  const freshnessBoost = days <= 1 ? 6 : days <= 3 ? 4 : days <= 7 ? 2 : 0;
  score += freshnessBoost;

  return {
    score,
    reasons: Array.from(new Set(reasons))
  };
}

export async function buildDailyDigest(subscriptions, options = {}) {
  const dateKey = options.dateKey;
  const onProgress = typeof options.onProgress === 'function'
    ? options.onProgress
    : async () => {};
  const windowDays = 1;
  const minScore = Math.max(0, Math.min(40, Number(subscriptions.minScore || 4)));
  const { dateFrom, dateTo } = resolveWindow(dateKey);
  const queryList = Array.isArray(subscriptions.queries) && subscriptions.queries.length
    ? subscriptions.queries
    : subscriptions.keywords;
  const normalizedQueries = Array.from(
    new Set((Array.isArray(queryList) ? queryList : []).map((query) => String(query || '').trim()).filter(Boolean))
  );
  const taskSpecs = [
    ...(normalizedQueries.length
      ? [{ keyword: normalizedQueries, maxResults: Math.min(120, Math.max(50, normalizedQueries.length * 35)), dateFrom, dateTo }]
      : []),
    ...subscriptions.people.map((author) => ({ author, maxResults: 20, dateFrom, dateTo })),
    ...subscriptions.papers.map((paper) => ({ paper, maxResults: 20, dateFrom, dateTo }))
  ];

  if (!taskSpecs.length) {
    await onProgress({
      stage: 'arxiv',
      current: 0,
      total: 0,
      percent: 100,
      message: '没有订阅查询需要执行'
    });
    return {
      generatedAt: new Date().toISOString(),
      forDate: dateKey || null,
      taskCount: 0,
      failedTasks: 0,
      totalCandidates: 0,
      papers: []
    };
  }

  const batches = [];
  let failedTasks = 0;
  const failedTaskDetails = [];
  const taskResults = [];
  // Serialize requests to reduce arXiv 429 rate limit hits.
  for (const spec of taskSpecs) {
    const label = describeTask(spec);
    const taskIndex = taskResults.length;
    await onProgress({
      stage: 'arxiv',
      current: taskIndex,
      total: taskSpecs.length,
      percent: taskBasePercent(taskIndex, taskSpecs.length),
      label,
      message: `正在查询 arXiv：${label}`
    });
    try {
      const batch = await searchArxiv({
        ...spec,
        onProgress: async (event) => {
          const attempt = Math.max(1, Number(event.attempt || 1));
          const maxAttempts = Math.max(1, Number(event.maxAttempts || 1));
          const attemptProgress = Math.min(0.9, (attempt - 1) / maxAttempts);
          const percent = Math.round(((taskIndex + attemptProgress) / taskSpecs.length) * 70);
          await onProgress({
            stage: 'arxiv',
            current: taskIndex,
            total: taskSpecs.length,
            percent,
            label,
            message: `${label}：${event.message || '正在请求 arXiv'}`
          });
        }
      });
      batches.push(batch);
      taskResults.push({
        label,
        ok: true,
        count: Array.isArray(batch.entries) ? batch.entries.length : 0,
        query: batch.query
      });
    } catch (error) {
      failedTasks += 1;
      const message = String(error?.message || error);
      failedTaskDetails.push({ label, error: message });
      taskResults.push({ label, ok: false, count: 0, error: message });
    }
    await onProgress({
      stage: 'arxiv',
      current: taskResults.length,
      total: taskSpecs.length,
      percent: taskBasePercent(taskResults.length, taskSpecs.length),
      label,
      message: `arXiv 查询进度：${taskResults.length}/${taskSpecs.length}`
    });
    if (taskResults.length < taskSpecs.length) {
      await sleep(arxivRequestDelayMs());
    }
  }

  await onProgress({
    stage: 'ranking',
    current: taskSpecs.length,
    total: taskSpecs.length,
    percent: 76,
    message: '正在合并候选并计算推荐分'
  });

  if (!batches.length) {
    return {
      generatedAt: new Date().toISOString(),
      forDate: dateKey || null,
      windowDays,
      minScore,
      taskCount: taskSpecs.length,
      failedTasks,
      failedTaskDetails,
      taskResults,
      totalCandidates: 0,
      papers: [],
      notice:
        '本次 arXiv 查询未完整成功，当前结果不可靠；系统会稍后自动重试。'
    };
  }

  const byId = new Map();
  const evidenceMap = new Map();
  for (const batch of batches) {
    for (const entry of batch.entries) {
      byId.set(entry.id, entry);
      evidenceMap.set(entry.id, (evidenceMap.get(entry.id) || 0) + 1);
    }
  }
  const merged = Array.from(byId.values());
  const scoreAnchor = dateKey ? new Date(`${dateKey}T23:59:59`) : new Date();

  const ranked = merged
    .map((paper) => {
      const { score, reasons } = scorePaper(paper, subscriptions, evidenceMap, scoreAnchor);
      return { ...paper, score, reasons };
    })
    .filter((paper) => paper.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, 60);

  return {
    generatedAt: new Date().toISOString(),
    forDate: dateKey || null,
    windowDays,
    minScore,
    taskCount: taskSpecs.length,
    failedTasks,
    failedTaskDetails,
    taskResults,
    totalCandidates: merged.length,
    papers: ranked,
    notice: failedTasks
      ? `本次有 ${failedTasks}/${taskSpecs.length} 条 arXiv 查询失败，当前结果为部分返回，系统会自动重试。`
      : ranked.length
        ? ''
        : `本日没有符合关注条件的论文发布（已检查当天，阈值 ${minScore} 分）。`
  };
}
