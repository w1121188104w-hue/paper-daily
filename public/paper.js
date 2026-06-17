import { getJson, loadAndBindSettingsForms, setupSettingsPanel } from './settings.js';

const params = new URLSearchParams(window.location.search);
const date = params.get('date');
const paperId = params.get('paperId');

const backToDayEl = document.querySelector('#backToDay');
const paperTitleEl = document.querySelector('#paperTitle');
const toggleMarkBtn = document.querySelector('#toggleMarkBtn');
const pdfFrameEl = document.querySelector('#pdfFrame');
const runLlmBtn = document.querySelector('#runLlmBtn');
const llmStatusEl = document.querySelector('#llmStatus');
const llmResultEl = document.querySelector('#llmResult');
const llmEmptyEl = document.querySelector('#llmEmpty');
const summaryTabBtn = document.querySelector('.tab-btn[data-tab="summary"]');
const runInsightBtn = document.querySelector('#runInsightBtn');
const insightStatusEl = document.querySelector('#insightStatus');
const insightResultEl = document.querySelector('#insightResult');
const insightEmptyEl = document.querySelector('#insightEmpty');
const insightTabBtn = document.querySelector('.tab-btn[data-tab="insight"]');
const paperAuthorsEl = document.querySelector('#paperAuthors');
const paperPublishedEl = document.querySelector('#paperPublished');
const paperReasonsEl = document.querySelector('#paperReasons');
const paperSummaryEl = document.querySelector('#paperSummary');
const chatMessagesEl = document.querySelector('#chatMessages');
const chatInputEl = document.querySelector('#chatInput');
const sendChatBtn = document.querySelector('#sendChatBtn');

function createPanelStreamState() {
  return {
    raw: '',
    isStreaming: false,
    renderQueued: false,
    pendingMathPass: false
  };
}

const state = {
  paper: null,
  marked: false,
  chatHistory: [],
  activeTab: 'summary',
  summaryStream: createPanelStreamState(),
  insightStream: createPanelStreamState()
};

function finishReasonToStatus(finishReason) {
  if (finishReason === 'stop' || !finishReason) return 'completed';
  return 'partial';
}

function formatSavedMeta(record) {
  if (!record?.updatedAt) return '已从本地加载';
  const timeLabel = new Date(record.updatedAt).toLocaleString();
  return record.status === 'partial'
    ? `已从本地加载，上次保存于 ${timeLabel}，内容可能未完整`
    : `已从本地加载，上次保存于 ${timeLabel}`;
}

function preserveMathDelimiters(markdown) {
  const placeholders = [];
  let text = String(markdown || '');
  const patterns = [/\\\[[\s\S]*?\\\]/g, /\\\([\s\S]*?\\\)/g];

  for (const pattern of patterns) {
    text = text.replace(pattern, (match) => {
      const token = `@@MATH_BLOCK_${placeholders.length}@@`;
      placeholders.push(match);
      return token;
    });
  }

  return { text, placeholders };
}

function restoreMathDelimiters(html, placeholders) {
  return String(html || '').replace(/@@MATH_BLOCK_(\d+)@@/g, (_match, index) => {
    return placeholders[Number(index)] || '';
  });
}

function normalizeMarkdownDensity(markdown) {
  return String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(^|\n)(#{1,6}[^\n]+)\n{2,}/g, '$1$2\n')
    .replace(/(^|\n)([-*+] [^\n]+)\n{2,}(?=[-*+] )/g, '$1$2\n')
    .replace(/(^|\n)(\d+\. [^\n]+)\n{2,}(?=\d+\. )/g, '$1$2\n')
    .trim();
}

function renderRichText(el, markdown, options = {}) {
  const markedLib = window.marked;
  const purifier = window.DOMPurify;
  const renderMath = window.renderMathInElement;
  const enableMath = options.enableMath !== false;
  const raw = normalizeMarkdownDensity(markdown);
  el.classList.remove('is-streaming');
  if (!markedLib || !purifier) {
    el.textContent = raw;
    return;
  }

  const { text, placeholders } = preserveMathDelimiters(raw);
  const html = restoreMathDelimiters(markedLib.parse(text, {
    breaks: true,
    gfm: true
  }), placeholders);
  el.innerHTML = purifier.sanitize(html);
  el.querySelectorAll('p:empty').forEach((p) => p.remove());

  if (enableMath && typeof renderMath === 'function') {
    try {
      renderMath(el, {
        throwOnError: false,
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true }
        ]
      });
    } catch (error) {
      console.warn('Math render skipped for current chunk:', error);
    }
  }
}

function renderStreamingText(el, text) {
  el.classList.add('is-streaming');
  el.textContent = String(text || '').replace(/\r\n?/g, '\n').trim();
}

function updateTabLabel(tabButton, idleLabel, streamingLabel, isStreaming) {
  if (!tabButton) return;
  tabButton.textContent = isStreaming ? streamingLabel : idleLabel;
}

function updateSummaryTabLabel() {
  updateTabLabel(summaryTabBtn, '论文AI解读', '论文AI解读（生成中）', state.summaryStream.isStreaming);
}

function updateInsightTabLabel() {
  updateTabLabel(insightTabBtn, '研究启发', '研究启发（生成中）', state.insightStream.isStreaming);
}

function queueStreamRender(streamState, panelName, resultEl, emptyEl, options = {}) {
  const forceMathPass = options.forceMathPass === true;
  streamState.pendingMathPass = streamState.pendingMathPass || forceMathPass;
  if (state.activeTab !== panelName || streamState.renderQueued) {
    return;
  }

  streamState.renderQueued = true;
  requestAnimationFrame(() => {
    streamState.renderQueued = false;
    if (state.activeTab !== panelName) return;
    resultEl.hidden = false;
    if (emptyEl) emptyEl.hidden = true;
    const enableMath = streamState.pendingMathPass || !streamState.isStreaming;
    streamState.pendingMathPass = false;
    if (streamState.isStreaming && !enableMath) {
      renderStreamingText(resultEl, streamState.raw);
      return;
    }
    renderRichText(resultEl, streamState.raw, { enableMath });
  });
}

function setupTabs() {
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
  const panels = Array.from(document.querySelectorAll('.tab-panel'));
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      state.activeTab = target;
      tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
      panels.forEach((panel) => panel.classList.toggle('hidden', panel.dataset.panel !== target));
      if (target === 'summary' && state.summaryStream.raw) {
        queueStreamRender(state.summaryStream, 'summary', llmResultEl, llmEmptyEl, {
          forceMathPass: !state.summaryStream.isStreaming
        });
      }
      if (target === 'insight' && state.insightStream.raw) {
        queueStreamRender(state.insightStream, 'insight', insightResultEl, insightEmptyEl, {
          forceMathPass: !state.insightStream.isStreaming
        });
      }
    });
  });
}

async function streamSsePost(url, payload, handlers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Request failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let sawDone = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const event of events) {
      const line = event
        .split('\n')
        .map((x) => x.trim())
        .find((x) => x.startsWith('data:'));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      const payloadData = JSON.parse(json);
      if (payloadData.error) {
        throw new Error(payloadData.error);
      }
      if (payloadData.type === 'delta' && payloadData.delta) {
        handlers.onDelta?.(payloadData.delta);
      }
      if (payloadData.type === 'status' && payloadData.message) {
        handlers.onStatus?.(payloadData);
      }
      if (payloadData.type === 'done' || payloadData.done) {
        sawDone = true;
        handlers.onDone?.(payloadData);
      }
    }
  }

  if (!sawDone) {
    handlers.onDone?.({ type: 'done', finishReason: null, terminated: false });
  }
}

function appendChatMessage(role, content) {
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.classList.add('markdown-body');
  renderRichText(div, content);
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  return div;
}

async function savePaperAiContent(kind, content, finishReason) {
  if (!date || !paperId || !content.trim()) return;
  await getJson('/api/paper/ai', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date,
      paperId,
      kind,
      content,
      finishReason,
      status: finishReasonToStatus(finishReason),
      updatedAt: new Date().toISOString()
    })
  });
}

function renderPaper() {
  const p = state.paper;
  if (!p) return;

  paperTitleEl.textContent = p.title;
  if (p.pdfUrl) {
    pdfFrameEl.src = `${p.pdfUrl}#view=FitH`;
  } else {
    pdfFrameEl.removeAttribute('src');
  }

  paperAuthorsEl.textContent = `作者：${p.authors.join(', ') || '未知'}`;
  paperPublishedEl.textContent = `发布时间：${new Date(p.published).toLocaleString()}`;
  paperReasonsEl.textContent = `推荐理由：${(p.reasons || []).join(' | ') || '综合相关性'}`;
  paperSummaryEl.textContent = p.summary;
  toggleMarkBtn.textContent = state.marked ? '取消 Mark' : 'Mark';
}

async function loadPaperData() {
  if (!date || !paperId) {
    throw new Error('缺少 date 或 paperId');
  }

  backToDayEl.href = `/day.html?date=${date}`;

  const [paper, marks, savedAi] = await Promise.all([
    getJson(`/api/paper?date=${encodeURIComponent(date)}&paperId=${encodeURIComponent(paperId)}`),
    getJson(`/api/marks/${date}`),
    getJson(`/api/paper/ai?date=${encodeURIComponent(date)}&paperId=${encodeURIComponent(paperId)}`)
  ]);

  state.paper = paper;
  state.marked = (marks.paperIds || []).includes(paperId);
  renderPaper();
  if (chatMessagesEl && !chatMessagesEl.childElementCount) {
    appendChatMessage(
      'assistant',
      '你好，我可以基于当前论文回答问题。你可以问：核心贡献、方法细节、实验结果、局限性、复现建议。'
    );
  }

  if (savedAi.summary?.content) {
    state.summaryStream = createPanelStreamState();
    state.summaryStream.raw = savedAi.summary.content;
    llmResultEl.hidden = false;
    if (llmEmptyEl) llmEmptyEl.hidden = true;
    if (state.activeTab === 'summary') {
      renderRichText(llmResultEl, savedAi.summary.content, { enableMath: true });
    }
    if (llmStatusEl) {
      llmStatusEl.textContent = formatSavedMeta(savedAi.summary);
    }
  }

  if (savedAi.insight?.content) {
    state.insightStream = createPanelStreamState();
    state.insightStream.raw = savedAi.insight.content;
    insightResultEl.hidden = false;
    if (insightEmptyEl) insightEmptyEl.hidden = true;
    if (state.activeTab === 'insight') {
      renderRichText(insightResultEl, savedAi.insight.content, { enableMath: true });
    }
    if (insightStatusEl) {
      insightStatusEl.textContent = formatSavedMeta(savedAi.insight);
    }
  }
}

toggleMarkBtn.addEventListener('click', async () => {
  if (!date || !paperId) return;
  toggleMarkBtn.disabled = true;
  try {
    const result = await getJson(`/api/marks/${date}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paperId })
    });
    state.marked = (result.paperIds || []).includes(paperId);
    renderPaper();
  } finally {
    toggleMarkBtn.disabled = false;
  }
});

runLlmBtn.addEventListener('click', async () => {
  if (!date || !paperId) return;
  runLlmBtn.disabled = true;
  runLlmBtn.textContent = '生成中...';
  state.summaryStream = createPanelStreamState();
  state.summaryStream.isStreaming = true;
  updateSummaryTabLabel();
  if (llmStatusEl) llmStatusEl.textContent = 'LLM 正在流式生成解读...';
  llmResultEl.hidden = false;
  if (llmEmptyEl) llmEmptyEl.hidden = true;
  renderRichText(llmResultEl, '');
  try {
    let finishReason = null;
    await streamSsePost('/api/llm/summarize/stream', { date, paperId }, {
      onStatus: (payloadData) => {
        if (llmStatusEl) llmStatusEl.textContent = payloadData.message;
      },
      onDelta: (delta) => {
        state.summaryStream.raw += delta;
        queueStreamRender(state.summaryStream, 'summary', llmResultEl, llmEmptyEl);
      },
      onDone: (payloadData) => {
        finishReason = payloadData.finishReason || null;
        finishReason = finishReason || (payloadData.terminated === false ? 'interrupted' : null);
      }
    });
    state.summaryStream.isStreaming = false;
    updateSummaryTabLabel();
    queueStreamRender(state.summaryStream, 'summary', llmResultEl, llmEmptyEl, {
      forceMathPass: true
    });
    if (llmStatusEl) {
      llmStatusEl.textContent = finishReason === 'length'
        ? '达到 max tokens，内容可能未生成完整；可提高 Max Tokens 后重试'
        : finishReason === 'interrupted'
          ? '流式连接提前结束，内容可能未生成完整；可重试'
          : '已完成，可继续重新生成';
    }
    await savePaperAiContent('summary', state.summaryStream.raw, finishReason);
  } catch (error) {
    const partialContent = state.summaryStream.raw;
    state.summaryStream.isStreaming = false;
    state.summaryStream.raw = `LLM 总结失败：${error.message}`;
    updateSummaryTabLabel();
    queueStreamRender(state.summaryStream, 'summary', llmResultEl, llmEmptyEl, {
      forceMathPass: true
    });
    if (llmStatusEl) llmStatusEl.textContent = '生成失败，请检查模型配置后重试';
    if (partialContent.trim()) {
      await savePaperAiContent('summary', partialContent, 'interrupted');
    }
  } finally {
    runLlmBtn.disabled = false;
    runLlmBtn.textContent = '生成 AI 解读';
  }
});

runInsightBtn?.addEventListener('click', async () => {
  if (!date || !paperId) return;
  runInsightBtn.disabled = true;
  runInsightBtn.textContent = '生成中...';
  state.insightStream = createPanelStreamState();
  state.insightStream.isStreaming = true;
  updateInsightTabLabel();
  if (insightStatusEl) insightStatusEl.textContent = '正在根据你的关注方向提炼研究启发...';
  insightResultEl.hidden = false;
  if (insightEmptyEl) insightEmptyEl.hidden = true;
  renderRichText(insightResultEl, '');
  try {
    let finishReason = null;
    await streamSsePost('/api/llm/insight/stream', { date, paperId }, {
      onStatus: (payloadData) => {
        if (insightStatusEl) insightStatusEl.textContent = payloadData.message;
      },
      onDelta: (delta) => {
        state.insightStream.raw += delta;
        queueStreamRender(state.insightStream, 'insight', insightResultEl, insightEmptyEl);
      },
      onDone: (payloadData) => {
        finishReason = payloadData.finishReason || null;
        finishReason = finishReason || (payloadData.terminated === false ? 'interrupted' : null);
      }
    });
    state.insightStream.isStreaming = false;
    updateInsightTabLabel();
    queueStreamRender(state.insightStream, 'insight', insightResultEl, insightEmptyEl, {
      forceMathPass: true
    });
    if (insightStatusEl) {
      insightStatusEl.textContent = finishReason === 'length'
        ? '达到 max tokens，内容可能未生成完整；可提高 Max Tokens 后重试'
        : finishReason === 'interrupted'
          ? '流式连接提前结束，内容可能未生成完整；可重试'
          : '已完成，可继续重新生成';
    }
    await savePaperAiContent('insight', state.insightStream.raw, finishReason);
  } catch (error) {
    const partialContent = state.insightStream.raw;
    state.insightStream.isStreaming = false;
    state.insightStream.raw = `研究启发生成失败：${error.message}`;
    updateInsightTabLabel();
    queueStreamRender(state.insightStream, 'insight', insightResultEl, insightEmptyEl, {
      forceMathPass: true
    });
    if (insightStatusEl) insightStatusEl.textContent = '生成失败，请先检查关注方向和模型配置';
    if (partialContent.trim()) {
      await savePaperAiContent('insight', partialContent, 'interrupted');
    }
  } finally {
    runInsightBtn.disabled = false;
    runInsightBtn.textContent = '生成研究启发';
  }
});

sendChatBtn.addEventListener('click', async () => {
  const message = chatInputEl.value.trim();
  if (!message || !date || !paperId) return;

  chatInputEl.value = '';
  appendChatMessage('user', message);
  const assistantEl = appendChatMessage('assistant', '');
  let assistantAcc = '';

  sendChatBtn.disabled = true;
  try {
    let finishReason = null;
    await streamSsePost('/api/llm/chat/stream', {
      date,
      paperId,
      message,
      history: state.chatHistory
    }, {
      onStatus: (payloadData) => {
        if (!assistantAcc) {
          renderStreamingText(assistantEl, payloadData.message);
        }
      },
      onDelta: (delta) => {
        assistantAcc += delta;
        renderStreamingText(assistantEl, assistantAcc);
      },
      onDone: (payloadData) => {
        finishReason = payloadData.finishReason || null;
        finishReason = finishReason || (payloadData.terminated === false ? 'interrupted' : null);
      }
    });

    renderRichText(assistantEl, assistantAcc, { enableMath: true });
    if (finishReason === 'length' || finishReason === 'interrupted') {
      renderRichText(
        assistantEl,
        finishReason === 'length'
          ? `${assistantAcc}\n\n> 提示：本次回复达到 max tokens，内容可能未完整。`
          : `${assistantAcc}\n\n> 提示：本次回复流式连接提前结束，内容可能未完整。`
      );
    }
    state.chatHistory.push({ role: 'user', content: message });
    state.chatHistory.push({
      role: 'assistant',
      content: finishReason === 'length'
        ? `${assistantAcc}\n\n[提示：本次回复达到 max tokens，内容可能未完整。]`
        : finishReason === 'interrupted'
          ? `${assistantAcc}\n\n[提示：本次回复流式连接提前结束，内容可能未完整。]`
          : assistantAcc
    });
  } catch (error) {
    renderRichText(assistantEl, `对话失败：${error.message}`);
  } finally {
    sendChatBtn.disabled = false;
  }
});

chatInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChatBtn.click();
  }
});

async function boot() {
  setupSettingsPanel();
  setupTabs();
  updateSummaryTabLabel();
  updateInsightTabLabel();
  await loadAndBindSettingsForms();
  await loadPaperData();
}

boot().catch((error) => {
  llmResultEl.hidden = false;
  if (llmEmptyEl) llmEmptyEl.hidden = true;
  renderRichText(llmResultEl, `初始化失败：${error.message}`);
});
