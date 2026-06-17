function compactText(text, maxLength = 180) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}...`;
}

function formatReasons(reasons) {
  const list = Array.isArray(reasons) ? reasons.filter(Boolean) : [];
  return list.length ? list.slice(0, 4).join(' | ') : '综合相关性';
}

function paperToRadarItem(paper, rank) {
  return {
    rank,
    id: paper.id,
    title: paper.title,
    authors: Array.isArray(paper.authors) ? paper.authors.slice(0, 8) : [],
    score: Number(paper.score || 0),
    published: paper.published,
    url: paper.url,
    pdfUrl: paper.pdfUrl || '',
    reasons: Array.isArray(paper.reasons) ? paper.reasons : [],
    why: formatReasons(paper.reasons),
    abstractHint: compactText(paper.summary, 220)
  };
}

function summarizeStatus(digest) {
  const taskCount = Number(digest.taskCount || 0);
  const failedTasks = Number(digest.failedTasks || 0);
  if (taskCount && failedTasks >= taskCount) return 'failed';
  if (failedTasks > 0) return 'partial';
  return 'ready';
}

function summarizeAuthorUpdates(authorTracking) {
  const tracks = Array.isArray(authorTracking?.tracks) ? authorTracking.tracks : [];
  return tracks
    .filter((track) => track.hasUpdate)
    .slice(0, 6)
    .map((track) => {
      const newPaperCount = Number(track.newPaperCount || 0);
      const newScholarPublicationCount = Number(track.newScholarPublicationCount || 0);
      return {
        id: track.id,
        name: track.name,
        source: track.source || '',
        newPaperCount,
        newPapers: Array.isArray(track.newPapers) ? track.newPapers.slice(0, 8) : [],
        newScholarPublicationCount,
        newScholarPublications: Array.isArray(track.newScholarPublications)
          ? track.newScholarPublications.slice(0, 8)
          : [],
        totalNewCount: newPaperCount + newScholarPublicationCount
      };
    });
}

export function buildDailyRadar(digest, dateKey) {
  const papers = Array.isArray(digest?.papers) ? digest.papers : [];
  const status = summarizeStatus(digest || {});
  const topPapers = papers.slice(0, 3).map((paper, index) => paperToRadarItem(paper, index + 1));
  const watchList = papers.slice(3, 10).map((paper, index) => paperToRadarItem(paper, index + 4));
  const authorUpdates = summarizeAuthorUpdates(digest?.authorTracking);
  const failedTasks = Number(digest?.failedTasks || 0);
  const taskCount = Number(digest?.taskCount || 0);
  const totalCandidates = Number(digest?.totalCandidates || 0);

  let headline = `今日推荐 ${papers.length} 篇，候选 ${totalCandidates} 篇。`;
  if (status === 'failed') {
    headline = '今日抓取失败，当前没有可靠推荐结果。';
  } else if (status === 'partial' && !papers.length) {
    headline = digest?.notice || '今日抓取只有部分结果，当前没有可靠推荐结论。';
  } else if (!papers.length) {
    headline = digest?.notice || '今日暂时没有命中订阅条件的论文。';
  } else if (topPapers.length) {
    headline = `今日优先看 ${topPapers.length} 篇：${topPapers.map((paper) => paper.title).join(' / ')}`;
  }

  return {
    date: dateKey || digest?.forDate || null,
    generatedAt: digest?.generatedAt || null,
    status,
    headline,
    metrics: {
      recommended: papers.length,
      totalCandidates,
      taskCount,
      failedTasks,
      minScore: Number(digest?.minScore || 0),
      windowDays: Number(digest?.windowDays || 0)
    },
    topPapers,
    watchList,
    authorUpdates,
    notices: [digest?.notice].filter(Boolean)
  };
}

function markdownPaperLine(paper) {
  const authors = paper.authors.length ? paper.authors.join(', ') : 'Unknown authors';
  return [
    `### ${paper.rank}. ${paper.title}`,
    '',
    `- Score: ${paper.score}`,
    `- Authors: ${authors}`,
    `- Why: ${paper.why}`,
    `- Link: ${paper.url}`,
    paper.pdfUrl ? `- PDF: ${paper.pdfUrl}` : '',
    `- Abstract: ${paper.abstractHint}`
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildDailyReportMarkdown(digest, dateKey) {
  const radar = digest?.dailyRadar || buildDailyRadar(digest, dateKey);
  const lines = [
    `# PaperRadar Daily Report - ${radar.date}`,
    '',
    `Generated: ${radar.generatedAt || new Date().toISOString()}`,
    '',
    '## Status',
    '',
    `- Status: ${radar.status}`,
    `- Recommended: ${radar.metrics.recommended}`,
    `- Candidates: ${radar.metrics.totalCandidates}`,
    `- Query tasks: ${radar.metrics.taskCount}`,
    `- Failed tasks: ${radar.metrics.failedTasks}`,
    '',
    radar.headline
  ];

  const uniqueNotices = radar.notices.filter((notice) => notice && notice !== radar.headline);
  if (uniqueNotices.length) {
    lines.push('', '## Notices', '', ...uniqueNotices.map((notice) => `- ${notice}`));
  }

  if (radar.topPapers.length) {
    lines.push('', '## Top Picks', '', ...radar.topPapers.map(markdownPaperLine));
  }

  if (radar.watchList.length) {
    lines.push('', '## More To Scan', '', ...radar.watchList.map(markdownPaperLine));
  }

  if (radar.authorUpdates.length) {
    lines.push('', '## Author Updates', '');
    for (const item of radar.authorUpdates) {
      const parts = [];
      if (item.newPaperCount) parts.push(`${item.newPaperCount} arXiv paper(s)`);
      if (item.newScholarPublicationCount) {
        parts.push(`${item.newScholarPublicationCount} Scholar publication(s)`);
      }
      lines.push(`- ${item.name}: ${parts.join(', ') || 'updated'}`);
      for (const paper of item.newPapers) {
        lines.push(`  - [${paper.title}](${paper.url})`);
      }
      for (const publication of item.newScholarPublications || []) {
        const year = publication.year ? ` (${publication.year})` : '';
        lines.push(`  - [${publication.title}${year}](${publication.url || '#'})`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

export function buildNotificationMessage(digest) {
  const radar = digest?.dailyRadar || buildDailyRadar(digest, digest?.forDate);
  if (radar.status === 'failed') {
    return '今日论文抓取失败，请打开 PaperRadar 查看详情。';
  }
  if (radar.status === 'partial') {
    return '今日论文抓取只有部分结果，系统会自动重试。';
  }
  if (!radar.metrics.recommended) {
    return '今日暂时没有命中订阅条件的论文。';
  }
  const top = radar.topPapers[0]?.title || '';
  return top
    ? `今日推荐 ${radar.metrics.recommended} 篇。Top 1: ${compactText(top, 80)}`
    : `今日推荐 ${radar.metrics.recommended} 篇。`;
}
