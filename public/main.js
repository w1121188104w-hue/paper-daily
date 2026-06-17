const keywordsEl = document.querySelector('#keywords');
const peopleEl = document.querySelector('#people');
const papersEl = document.querySelector('#papers');
const saveSubsBtn = document.querySelector('#saveSubsBtn');
const saveLlmBtn = document.querySelector('#saveLlmBtn');
const refreshBtn = document.querySelector('#refreshBtn');
const dateSelect = document.querySelector('#dateSelect');
const listEl = document.querySelector('#list');
const metaEl = document.querySelector('#meta');
const template = document.querySelector('#paperTemplate');

const llmBaseUrlEl = document.querySelector('#llmBaseUrl');
const llmApiKeyEl = document.querySelector('#llmApiKey');
const llmModelEl = document.querySelector('#llmModel');
const llmTemperatureEl = document.querySelector('#llmTemperature');
const llmMaxTokensEl = document.querySelector('#llmMaxTokens');
const llmPromptEl = document.querySelector('#llmPrompt');
const settingsToggleEl = document.querySelector('#settingsToggle');
const settingsPanelEl = document.querySelector('#settingsPanel');
const settingsCloseEl = document.querySelector('#settingsClose');

let currentDate = null;
let currentDigest = null;
let markedIds = new Set();

function localDateKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function linesToArray(text) {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

function arrayToLines(items) {
  return (items || []).join('\n');
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function sortedPapers(papers) {
  return [...papers].sort((a, b) => {
    const am = markedIds.has(a.id) ? 1 : 0;
    const bm = markedIds.has(b.id) ? 1 : 0;
    if (am !== bm) return bm - am;
    return (b.score || 0) - (a.score || 0);
  });
}

function renderPapers(digest) {
  currentDigest = digest;
  listEl.innerHTML = '';

  const markedCount = digest.papers.filter((paper) => markedIds.has(paper.id)).length;
  metaEl.textContent = `生成时间：${new Date(digest.generatedAt).toLocaleString()} | 候选数：${digest.totalCandidates} | 推荐数：${digest.papers.length} | Mark：${markedCount}`;

  for (const paper of sortedPapers(digest.papers)) {
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

    const pdfLink = node.querySelector('.pdf');
    if (paper.pdfUrl) {
      pdfLink.href = paper.pdfUrl;
    } else {
      pdfLink.removeAttribute('href');
      pdfLink.textContent = '无 PDF';
      pdfLink.style.opacity = '0.5';
      pdfLink.style.pointerEvents = 'none';
    }

    const markBtn = node.querySelector('.mark-btn');
    const syncMarkStyle = () => {
      const marked = markedIds.has(paper.id);
      card.classList.toggle('marked-first', marked);
      markBtn.textContent = marked ? '已 Mark' : 'Mark';
      markBtn.classList.toggle('marked', marked);
    };

    markBtn.addEventListener('click', async () => {
      if (!currentDate) return;
      markBtn.disabled = true;
      try {
        const result = await getJson(`/api/marks/${currentDate}/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paperId: paper.id })
        });
        markedIds = new Set(result.paperIds);
        renderPapers(currentDigest);
      } catch (error) {
        alert(error.message);
      } finally {
        markBtn.disabled = false;
      }
    });

    const llmBtn = node.querySelector('.llm-btn');
    const llmOutput = node.querySelector('.llm-output');
    llmBtn.addEventListener('click', async () => {
      if (!currentDate) return;
      llmBtn.disabled = true;
      llmBtn.textContent = '生成中...';
      try {
        const result = await getJson('/api/llm/summarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: currentDate, paperId: paper.id })
        });
        llmOutput.hidden = false;
        llmOutput.textContent = result.summary;
      } catch (error) {
        llmOutput.hidden = false;
        llmOutput.textContent = `LLM 总结失败：${error.message}`;
      } finally {
        llmBtn.disabled = false;
        llmBtn.textContent = 'LLM 总结';
      }
    });

    syncMarkStyle();
    listEl.appendChild(node);
  }
}

async function loadSubscriptions() {
  const subscriptions = await getJson('/api/subscriptions');
  keywordsEl.value = arrayToLines(subscriptions.keywords);
  peopleEl.value = arrayToLines(subscriptions.people);
  papersEl.value = arrayToLines(subscriptions.papers);
}

async function loadLLMSettings() {
  const settings = await getJson('/api/llm/settings');
  llmBaseUrlEl.value = settings.baseUrl || '';
  llmApiKeyEl.value = settings.apiKey || '';
  llmModelEl.value = settings.model || '';
  llmTemperatureEl.value = String(settings.temperature ?? 0.2);
  llmMaxTokensEl.value = String(settings.maxTokens ?? 700);
  llmPromptEl.value = settings.summaryPrompt || '';
}

async function loadDigest(date) {
  currentDate = date;
  const [digest, marks] = await Promise.all([
    getJson(`/api/digest/${date}`),
    getJson(`/api/marks/${date}`)
  ]);
  markedIds = new Set(marks.paperIds || []);
  renderPapers(digest);
}

async function loadDatesAndDigest(preferredDate = null) {
  const dates = await getJson('/api/digest/dates');
  dateSelect.innerHTML = '';

  if (!dates.length) {
    metaEl.textContent = '暂无推荐记录，请先点击“立即更新今日推荐”。';
    listEl.innerHTML = '';
    return;
  }

  dates.forEach((date) => {
    const option = document.createElement('option');
    option.value = date;
    option.textContent = date;
    dateSelect.appendChild(option);
  });

  const target = preferredDate && dates.includes(preferredDate) ? preferredDate : dates[0];
  dateSelect.value = target;
  await loadDigest(target);
}

saveSubsBtn.addEventListener('click', async () => {
  saveSubsBtn.disabled = true;
  try {
    await getJson('/api/subscriptions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: linesToArray(keywordsEl.value),
        people: linesToArray(peopleEl.value),
        papers: linesToArray(papersEl.value)
      })
    });
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

saveLlmBtn.addEventListener('click', async () => {
  saveLlmBtn.disabled = true;
  try {
    await getJson('/api/llm/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: llmBaseUrlEl.value.trim(),
        apiKey: llmApiKeyEl.value.trim(),
        model: llmModelEl.value.trim(),
        temperature: Number(llmTemperatureEl.value),
        maxTokens: Number(llmMaxTokensEl.value),
        summaryPrompt: llmPromptEl.value.trim()
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

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = '更新中...';
  try {
    const today = localDateKey();
    await getJson('/api/digest/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: today })
    });
    await loadDatesAndDigest(today);
  } catch (error) {
    alert(error.message);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = '立即更新今日推荐';
  }
});

dateSelect.addEventListener('change', async () => {
  try {
    await loadDigest(dateSelect.value);
  } catch (error) {
    alert(error.message);
  }
});

async function boot() {
  await Promise.all([loadSubscriptions(), loadLLMSettings()]);
  await loadDatesAndDigest();
}

settingsToggleEl.addEventListener('click', () => {
  settingsPanelEl.hidden = !settingsPanelEl.hidden;
});

settingsCloseEl.addEventListener('click', () => {
  settingsPanelEl.hidden = true;
});

boot().catch((error) => {
  metaEl.textContent = `初始化失败：${error.message}`;
});
