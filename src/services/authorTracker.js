import { searchArxiv } from './arxiv.js';
import { extractScholarPublicationsWithLLM } from './llm.js';
import {
  extractScholarPublicationsFallback,
  fetchScholarProfileMarkdown,
  normalizeScholarPublications,
  publicationKey
} from './scholar.js';
import {
  getAuthorTrackState,
  getLLMSettings,
  getSubscriptions,
  saveAuthorTrackState
} from './storage.js';

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todayDateKey() {
  return toDateKey(new Date());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publishedMs(paper) {
  const ms = Date.parse(paper?.published || '');
  return Number.isFinite(ms) ? ms : 0;
}

function compactPaper(paper) {
  return {
    id: paper.id,
    title: paper.title,
    published: paper.published,
    url: paper.url
  };
}

function compactScholarPublication(publication) {
  return {
    title: publication.title,
    year: publication.year || null,
    authors: publication.authors || '',
    venue: publication.venue || '',
    url: publication.url || ''
  };
}

function computeLatestPoint(entries) {
  if (!entries.length) return null;

  const maxMs = Math.max(...entries.map(publishedMs));
  const latest = entries.find((paper) => publishedMs(paper) === maxMs) || entries[0];
  const idsAtMax = entries
    .filter((paper) => publishedMs(paper) === maxMs)
    .map((paper) => paper.id)
    .slice(0, 50);

  return {
    ms: maxMs,
    published: latest.published,
    ids: idsAtMax,
    paper: latest
  };
}

function normalizeTrackQuery(track) {
  const raw = String(track.arxivAuthorQuery || track.name || '').trim();
  return raw.replace(/^au:\s*/i, '').replace(/^author:\s*/i, '');
}

async function extractScholarPublications(markdown, track, settings, profileUrl) {
  if (settings.apiKey) {
    try {
      const extracted = await extractScholarPublicationsWithLLM(markdown, track, settings);
      const publications = normalizeScholarPublications(extracted.publications, profileUrl);
      if (publications.length) {
        return {
          publications,
          source: 'llm',
          tokens: extracted.tokens || null,
          error: ''
        };
      }
    } catch (error) {
      const fallbackPublications = extractScholarPublicationsFallback(markdown, profileUrl);
      return {
        publications: fallbackPublications,
        source: fallbackPublications.length ? 'fallback-after-llm-error' : 'llm-error',
        tokens: null,
        error: String(error?.message || error)
      };
    }
  }

  const fallbackPublications = extractScholarPublicationsFallback(markdown, profileUrl);
  return {
    publications: fallbackPublications,
    source: 'fallback',
    tokens: null,
    error: settings.apiKey ? '' : 'LLM API key is empty; used basic Scholar parser.'
  };
}

async function checkScholarTrack(track, previousState) {
  const prev = previousState && typeof previousState === 'object' ? previousState : {};
  let profile;
  let extracted = {
    publications: [],
    source: '',
    tokens: null,
    error: ''
  };

  try {
    profile = await fetchScholarProfileMarkdown(track);
    const settings = await getLLMSettings();
    extracted = await extractScholarPublications(profile.markdown, track, settings, profile.targetUrl);
  } catch (error) {
    return {
      profileUrl: profile?.targetUrl || track.scholarUrl || '',
      publicationCount: Number(prev.scholarPublicationCount || 0),
      latestPublications: Array.isArray(prev.scholarLatestPublications) ? prev.scholarLatestPublications : [],
      newPublications: [],
      source: 'error',
      baselineReady: Boolean(prev.scholarBaselineReady),
      initializedBaseline: false,
      tokens: null,
      error: String(error?.message || error),
      statePatch: {
        scholarLastCheckedAt: new Date().toISOString(),
        scholarError: String(error?.message || error)
      }
    };
  }

  const publications = extracted.publications;
  const keys = publications.map(publicationKey).filter(Boolean);
  const previousKeys = new Set(Array.isArray(prev.scholarKnownKeys) ? prev.scholarKnownKeys : []);
  const hadBaseline = Boolean(prev.scholarBaselineReady) && previousKeys.size > 0;
  if (!publications.length) {
    return {
      profileUrl: profile.targetUrl,
      publicationCount: Number(prev.scholarPublicationCount || 0),
      latestPublications: Array.isArray(prev.scholarLatestPublications) ? prev.scholarLatestPublications : [],
      newPublications: [],
      source: extracted.source || 'empty',
      baselineReady: Boolean(prev.scholarBaselineReady),
      initializedBaseline: false,
      tokens: extracted.tokens || null,
      error: extracted.error || 'No publications could be extracted from Scholar page.',
      statePatch: {
        scholarProfileUrl: profile.targetUrl,
        scholarLastCheckedAt: new Date().toISOString(),
        scholarLastExtractSource: extracted.source || 'empty',
        scholarLastTokens: extracted.tokens || null,
        scholarError: extracted.error || 'No publications could be extracted from Scholar page.'
      }
    };
  }
  const newPublications = hadBaseline
    ? publications.filter((publication) => !previousKeys.has(publicationKey(publication)))
    : [];

  const compactLatest = publications.slice(0, 12).map(compactScholarPublication);
  return {
    profileUrl: profile.targetUrl,
    publicationCount: publications.length,
    latestPublications: compactLatest,
    newPublications: newPublications.slice(0, 12).map(compactScholarPublication),
    source: extracted.source,
    baselineReady: true,
    initializedBaseline: !hadBaseline && publications.length > 0,
    tokens: extracted.tokens || null,
    error: extracted.error || '',
    statePatch: {
      scholarBaselineReady: true,
      scholarKnownKeys: keys,
      scholarPublicationCount: publications.length,
      scholarLatestPublications: compactLatest,
      scholarProfileUrl: profile.targetUrl,
      scholarLastCheckedAt: new Date().toISOString(),
      scholarLastExtractSource: extracted.source,
      scholarLastTokens: extracted.tokens || null,
      scholarError: extracted.error || ''
    }
  };
}

async function checkTrack(track, dateKey, previousState) {
  const prev = previousState && typeof previousState === 'object' ? previousState : {};
  const queryAuthor = normalizeTrackQuery(track);
  const hasScholarIdentity = Boolean(track.scholarId || track.scholarUrl);
  const shouldCheckArxiv = Boolean(track.arxivAuthorQuery || !hasScholarIdentity);
  let scholarResult = null;

  let dayBatch = { entries: [] };
  if (shouldCheckArxiv) {
    dayBatch = await searchArxiv({
      author: queryAuthor,
      maxResults: 50,
      dateFrom: dateKey,
      dateTo: dateKey
    });
  }
  const dayEntries = Array.isArray(dayBatch.entries) ? dayBatch.entries : [];
  const latestPoint = computeLatestPoint(dayEntries);

  let subscriptionDayHasUpdate = Boolean(prev.subscriptionDayHasUpdate);
  let subscriptionDayChecked = Boolean(prev.subscriptionDayChecked);
  if (!subscriptionDayChecked) {
    const subscriptionDayBatch = !shouldCheckArxiv
      ? { entries: [] }
      : (
        dateKey === track.subscribedDate
          ? dayBatch
          : await searchArxiv({
            author: queryAuthor,
            maxResults: 10,
            dateFrom: track.subscribedDate,
            dateTo: track.subscribedDate
          })
      );
    subscriptionDayHasUpdate = (subscriptionDayBatch.entries || []).length > 0;
    subscriptionDayChecked = true;
  }

  const latestPaper = shouldCheckArxiv && latestPoint?.paper
    ? compactPaper(latestPoint.paper)
    : shouldCheckArxiv
      ? prev.latestPaper || null
      : null;

  if (hasScholarIdentity) {
    scholarResult = await checkScholarTrack(track, prev);
  }

  const nextState = {
    lastCheckedDate: dateKey,
    lastSeenPublished: shouldCheckArxiv ? (latestPoint?.published || prev.lastSeenPublished || null) : null,
    lastSeenIdsAtPublished: shouldCheckArxiv ? (latestPoint?.ids || prev.lastSeenIdsAtPublished || []) : [],
    latestPaper,
    subscriptionDayChecked,
    subscriptionDayHasUpdate,
    ...(scholarResult?.statePatch || {})
  };

  const scholarNewCount = scholarResult?.newPublications?.length || 0;
  const hasUpdate = dayEntries.length > 0 || scholarNewCount > 0;

  return {
    status: {
      id: track.id,
      name: track.name,
      scholarId: track.scholarId || '',
      scholarUrl: track.scholarUrl || '',
      orcid: track.orcid || '',
      subscribedDate: track.subscribedDate,
      identityOnly: hasScholarIdentity && !track.arxivAuthorQuery,
      identityNote: hasScholarIdentity && !track.arxivAuthorQuery
        ? 'Google Scholar identity linked; arXiv name search disabled until query= is provided.'
        : '',
      source: hasScholarIdentity
        ? shouldCheckArxiv
          ? 'scholar+arxiv'
          : 'scholar'
        : 'arxiv',
      hasUpdate,
      newPaperCount: dayEntries.length,
      newPapers: dayEntries.slice(0, 8).map(compactPaper),
      latestPaper,
      scholarProfileUrl: scholarResult?.profileUrl || track.scholarUrl || '',
      scholarPublicationCount: scholarResult?.publicationCount || 0,
      scholarLatestPublications: scholarResult?.latestPublications || [],
      scholarBaselineReady: Boolean(scholarResult?.baselineReady),
      scholarInitializedBaseline: Boolean(scholarResult?.initializedBaseline),
      scholarExtractSource: scholarResult?.source || '',
      scholarError: scholarResult?.error || '',
      newScholarPublicationCount: scholarNewCount,
      newScholarPublications: scholarResult?.newPublications || [],
      subscriptionDayHasUpdate,
      checkedDate: dateKey
    },
    nextState
  };
}

export async function checkAuthorTracksForDate(inputDateKey) {
  const dateKey = isDateKey(inputDateKey) ? inputDateKey : todayDateKey();
  const subscriptions = await getSubscriptions();
  const tracks = (subscriptions.authorTracks || []).filter((track) => track.enabled !== false);
  const allState = await getAuthorTrackState();

  const results = [];
  for (const track of tracks) {
    const previousState = allState[track.id] || {};
    const canAdvanceState =
      !isDateKey(previousState.lastCheckedDate) || dateKey >= previousState.lastCheckedDate;
    try {
      const { status, nextState } = await checkTrack(track, dateKey, previousState);
      if (canAdvanceState) {
        allState[track.id] = nextState;
      }
      results.push(status);
    } catch (error) {
      const message = String(error?.message || error);
      results.push({
        id: track.id,
        name: track.name,
        scholarId: track.scholarId || '',
        scholarUrl: track.scholarUrl || '',
        orcid: track.orcid || '',
        subscribedDate: track.subscribedDate,
        hasUpdate: false,
        identityOnly: Boolean(track.scholarId || track.scholarUrl) && !track.arxivAuthorQuery,
        source: track.scholarId || track.scholarUrl ? 'scholar' : 'arxiv',
        newPaperCount: 0,
        newPapers: [],
        latestPaper: track.arxivAuthorQuery || !(track.scholarId || track.scholarUrl)
          ? previousState.latestPaper || null
          : null,
        scholarProfileUrl: previousState.scholarProfileUrl || track.scholarUrl || '',
        scholarPublicationCount: Number(previousState.scholarPublicationCount || 0),
        scholarLatestPublications: Array.isArray(previousState.scholarLatestPublications)
          ? previousState.scholarLatestPublications
          : [],
        scholarBaselineReady: Boolean(previousState.scholarBaselineReady),
        scholarInitializedBaseline: false,
        scholarExtractSource: 'error',
        scholarError: message,
        newScholarPublicationCount: 0,
        newScholarPublications: [],
        subscriptionDayHasUpdate: Boolean(previousState.subscriptionDayHasUpdate),
        checkedDate: dateKey,
        error: message
      });
      if (canAdvanceState) {
        allState[track.id] = {
          ...previousState,
          lastCheckedDate: dateKey,
          lastError: message
        };
      }
    }
    await sleep(220);
  }

  await saveAuthorTrackState(allState);
  return {
    checkedDate: dateKey,
    totalTracked: tracks.length,
    updatedAuthors: results.filter((item) => item.hasUpdate).length,
    tracks: results
  };
}
