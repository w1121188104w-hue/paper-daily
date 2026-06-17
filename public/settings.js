export async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function linesToArray(text) {
  return String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function arrayToLines(items) {
  return (items || []).join('\n');
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function normalizeTrackSignature(track) {
  return [
    String(track.name || '').toLowerCase().trim(),
    String(track.scholarId || '').toLowerCase().trim(),
    String(track.scholarUrl || '').toLowerCase().trim(),
    String(track.orcid || '').toLowerCase().trim(),
    String(track.arxivAuthorQuery || '').toLowerCase().trim(),
    String(track.subscribedDate || '').trim()
  ].join('|');
}

function parseAuthorTrackLines(text, existingIdBySignature) {
  const lines = linesToArray(text);
  const tracks = [];
  for (const line of lines) {
    const parts = line.split('|').map((part) => part.trim()).filter(Boolean);
    if (!parts.length) continue;
    const track = {
      name: parts[0],
      scholarId: '',
      scholarUrl: '',
      orcid: '',
      arxivAuthorQuery: '',
      subscribedDate: ''
    };

    for (const meta of parts.slice(1)) {
      const [rawKey, ...rest] = meta.split('=');
      if (!rawKey || !rest.length) continue;
      const key = rawKey.trim().toLowerCase();
      const value = rest.join('=').trim();
      if (!value) continue;

      if (key === 'scholar' || key === 'scholarid' || key === 'gs') {
        if (/^https?:\/\//i.test(value)) {
          track.scholarUrl = value;
        } else {
          track.scholarId = value;
        }
      } else if (key === 'orcid') {
        track.orcid = value;
      } else if (key === 'query' || key === 'arxiv' || key === 'au') {
        track.arxivAuthorQuery = value;
      } else if (key === 'from' || key === 'date' || key === 'since') {
        track.subscribedDate = value;
      }
    }

    if (!track.name) continue;
    const signature = normalizeTrackSignature(track);
    const existingId = existingIdBySignature.get(signature);
    if (existingId) {
      track.id = existingId;
    }
    tracks.push(track);
  }
  return tracks;
}

function formatAuthorTracks(tracks) {
  return (tracks || [])
    .map((track) => {
      const parts = [track.name];
      if (track.subscribedDate && isDateKey(track.subscribedDate)) {
        parts.push(`from=${track.subscribedDate}`);
      }
      if (track.scholarId) {
        parts.push(`scholar=${track.scholarUrl || track.scholarId}`);
      } else if (track.scholarUrl) {
        parts.push(`scholar=${track.scholarUrl}`);
      }
      if (track.orcid) {
        parts.push(`orcid=${track.orcid}`);
      }
      if (track.arxivAuthorQuery) {
        parts.push(`query=${track.arxivAuthorQuery}`);
      }
      return parts.join(' | ');
    })
    .join('\n');
}

export function setupSettingsPanel() {
  const toggle = document.querySelector('#settingsToggle');
  const panel = document.querySelector('#settingsPanel');
  const close = document.querySelector('#settingsClose');

  if (!toggle || !panel || !close) return;

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
  });

  close.addEventListener('click', () => {
    panel.hidden = true;
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (panel.hidden) return;
    if (panel.contains(target) || toggle.contains(target)) return;
    panel.hidden = true;
  });
}

export async function loadAndBindSettingsForms() {
  const queriesEl = document.querySelector('#queries');
  const authorTracksEl = document.querySelector('#authorTracks');
  const insightInterestsEl = document.querySelector('#insightInterests');
  const windowDaysEl = document.querySelector('#windowDays');
  const minScoreEl = document.querySelector('#minScore');
  const saveSubsBtn = document.querySelector('#saveSubsBtn');

  const llmBaseUrlEl = document.querySelector('#llmBaseUrl');
  const llmApiKeyEl = document.querySelector('#llmApiKey');
  const llmModelEl = document.querySelector('#llmModel');
  const llmTemperatureEl = document.querySelector('#llmTemperature');
  const llmMaxTokensEl = document.querySelector('#llmMaxTokens');
  const llmPromptEl = document.querySelector('#llmPrompt');
  const saveLlmBtn = document.querySelector('#saveLlmBtn');

  if (!queriesEl || !saveSubsBtn) return;

  const [subscriptions, llmSettings] = await Promise.all([
    getJson('/api/subscriptions'),
    getJson('/api/llm/settings')
  ]);

  const queryLines = subscriptions.queries?.length
    ? subscriptions.queries
    : subscriptions.keywords || [];
  queriesEl.value = arrayToLines(queryLines);
  const existingIdBySignature = new Map();
  (subscriptions.authorTracks || []).forEach((track) => {
    existingIdBySignature.set(normalizeTrackSignature(track), track.id);
  });
  if (authorTracksEl) {
    authorTracksEl.value = formatAuthorTracks(subscriptions.authorTracks || []);
  }
  if (insightInterestsEl) {
    insightInterestsEl.value = arrayToLines(subscriptions.insightInterests || []);
  }
  if (windowDaysEl) windowDaysEl.value = String(subscriptions.windowDays ?? 1);
  if (minScoreEl) minScoreEl.value = String(subscriptions.minScore ?? 4);

  if (llmBaseUrlEl) llmBaseUrlEl.value = llmSettings.baseUrl || '';
  if (llmApiKeyEl) llmApiKeyEl.value = llmSettings.apiKey || '';
  if (llmModelEl) llmModelEl.value = llmSettings.model || '';
  if (llmTemperatureEl) llmTemperatureEl.value = String(llmSettings.temperature ?? 0.2);
  if (llmMaxTokensEl) llmMaxTokensEl.value = String(llmSettings.maxTokens ?? 700);
  if (llmPromptEl) llmPromptEl.value = llmSettings.summaryPrompt || '';

  saveSubsBtn.addEventListener('click', async () => {
    saveSubsBtn.disabled = true;
    try {
      const saved = await getJson('/api/subscriptions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queries: linesToArray(queriesEl.value),
          authorTracks: parseAuthorTrackLines(authorTracksEl?.value || '', existingIdBySignature),
          insightInterests: linesToArray(insightInterestsEl?.value || ''),
          windowDays: Number(windowDaysEl?.value || 1),
          minScore: Number(minScoreEl?.value || 4)
        })
      });
      existingIdBySignature.clear();
      (saved.authorTracks || []).forEach((track) => {
        existingIdBySignature.set(normalizeTrackSignature(track), track.id);
      });
      if (authorTracksEl) {
        authorTracksEl.value = formatAuthorTracks(saved.authorTracks || []);
      }
      if (insightInterestsEl) {
        insightInterestsEl.value = arrayToLines(saved.insightInterests || []);
      }
      saveSubsBtn.textContent = '已保存';
    } catch (error) {
      alert(error.message);
    } finally {
      setTimeout(() => {
        saveSubsBtn.textContent = '保存订阅';
        saveSubsBtn.disabled = false;
      }, 900);
    }
  });

  if (saveLlmBtn) {
    saveLlmBtn.addEventListener('click', async () => {
      saveLlmBtn.disabled = true;
      try {
        await getJson('/api/llm/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: llmBaseUrlEl?.value.trim() || '',
            apiKey: llmApiKeyEl?.value.trim() || '',
            model: llmModelEl?.value.trim() || '',
            temperature: Number(llmTemperatureEl?.value),
            maxTokens: Number(llmMaxTokensEl?.value),
            summaryPrompt: llmPromptEl?.value.trim() || ''
          })
        });
        saveLlmBtn.textContent = '已保存';
      } catch (error) {
        alert(error.message);
      } finally {
        setTimeout(() => {
          saveLlmBtn.textContent = '保存 LLM 设置';
          saveLlmBtn.disabled = false;
        }, 900);
      }
    });
  }
}
