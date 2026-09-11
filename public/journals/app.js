import { RUN_LABELS, TRANSLATION_LABELS, DOCUMENT_LABELS, CLASSIFICATION_REASONS, documentKind, normalizeDocumentFilter,
  beijingDay, validDay, validMonth, shiftMonth, monthCells,
  filterPapers, countsByDay, selectedJournalKeys, coverageForDay, paperTitle, doiHref, pageHref,
  sourceLabel, publicationDateText, ABSTRACT_LABELS, abstractSourceHref } from './viewModel.js';

const $ = (id) => document.getElementById(id);
const node = (tag, text = '', className = '') => {
  const element = document.createElement(tag); element.textContent = text;
  if (className) element.className = className;
  return element;
};
const button = (label, action, className = 'secondary') => {
  const element = node('button', label, className); element.type = 'button';
  element.addEventListener('click', action); return element;
};
const params = new URLSearchParams(location.search), isDayPage = document.body.dataset.page === 'day';
const isStaticPage = document.body.dataset.delivery === 'static';
let today = beijingDay();
const selectedDate = isDayPage ? params.get('date') : '';
const state = { data: null, page: 1, month: validMonth(params.get('month')) ? params.get('month') : today.slice(0, 7),
  filters: { journal: params.get('journal') || '', category: params.get('category') || '',
    kind: normalizeDocumentFilter(params.get('kind')), q: (params.get('q') || '').slice(0, 500) } };
const timeText = (value) => value ? `${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai',
  dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(new Date(value))}（北京时间）` : '暂无';

function syncUrl() {
  const extra = isDayPage ? { date: selectedDate || '' } : { month: state.month };
  history.replaceState(null, '', pageHref(isDayPage ? 'day.html' : 'index.html', state.filters, extra));
  if (isDayPage) $('backToCalendar').href = pageHref('index.html', state.filters,
    { month: validDay(selectedDate) ? selectedDate.slice(0, 7) : today.slice(0, 7) });
}

function renderStatus() {
  const data = state.data, latest = data.runs[0];
  $('statusBadge').textContent = latest ? RUN_LABELS[latest.status] : '尚未采集';
  $('statusBadge').className = `status-badge ${latest?.status === 'full_failure' ? 'failed' :
    latest?.status === 'partial_failure' ? 'partial' : latest ? 'ready' : ''}`;
  $('statusText').textContent = latest ? `最近已保存的采集：${timeText(latest.finished_at)}。范围：${latest.journal_keys.join('、')}（${latest.journal_keys.length}/${data.journals.length}刊）；回查发表日期 ${latest.from_date} 至 ${latest.to_date}。本轮新增 ${latest.stats.added} 条、更新 ${latest.stats.updated} 条文献记录。` :
    '尚未建立真实采集记录。页面中的空白不代表这些期刊没有论文；浏览页面不会启动采集。';
  const counts = data.papers.reduce((all, paper) => { const kind = documentKind(paper); all[kind] = (all[kind] || 0) + 1; return all; }, {});
  const kinds = Object.entries(DOCUMENT_LABELS).filter(([key]) => key !== 'all' && counts[key])
    .map(([key, label]) => `${label} ${counts[key]} 条`).join('；');
  const eligibility = data.translation_eligibility;
  $('libraryMeta').textContent = `库中共 ${data.papers.length} 条文献记录${kinds ? `：${kinds}` : ''}。历史待翻译总计 ${data.pending.paper_count} 条、${data.pending.field_count} 个字段。${eligibility ? `默认可导出研究候选 ${eligibility.ready.paper_count} 条、${eligibility.ready.field_count} 个字段；其他 ${eligibility.held.paper_count} 条暂缓。` : ''}${data.snapshot_at ? ` 数据版本保存于 ${timeText(data.snapshot_at)}，翻译保存时间不等于采集时间。` : ''}`;
  const warning = data.attempt_warning;
  $('attemptWarning').hidden = !warning;
  if (warning) {
    $('attemptWarning').textContent = ({
      uncommitted_failure: '注意：另有一次较新的采集未能保存，上面的状态仅属于较早的已保存记录。请先检查本地运行情况。',
      unconfirmed: '注意：另有一次采集尚无已保存的结果，可能仍在运行或曾经中断；不能将上面的记录视为最新采集成功。',
      unavailable: '注意：暂时无法核实是否有未保存的采集尝试，上方仅显示已通过校验的历史记录。'
    })[warning.status];
    $('statusBadge').textContent = '最新尝试需核查'; $('statusBadge').className = 'status-badge partial';
  }
  const enrichment = data.enrichment;
  if ($('enrichmentStatus')) {
    $('enrichmentStatus').textContent = enrichment?.latest ? `最近补全：${timeText(enrichment.latest.finished_at)}；本轮补入 ${enrichment.latest.stats.added} 篇，找到真实摘要 ${enrichment.latest.stats.abstracts_filled} 篇。库中仍有 ${enrichment.missing_abstracts} 条缺摘要，将按间隔重试。` : '官网核对与摘要补全尚未运行。';
    const items = (enrichment?.journals || []).sort((a,b) => a.journal_key.localeCompare(b.journal_key)).map(j => node('p',
      `${j.journal_key}：${j.coverage === 'restricted' ? `访问受限／未核实；官网清单观察 未知 条，无法判断60天内覆盖和漏收情况，原库 ${j.existing_total_count} 条，本次未补入` :
        `部分核对；官网清单观察 ${j.official_observed_count} 条，60天内确认 ${j.official_in_window_count} 条，原库 ${j.existing_total_count} 条，确认漏收 ${j.missing_count} 条，补入 ${j.added_count} 条，待核实 ${j.pending_count} 条`}。核对 ${j.from_date} 至 ${j.to_date}，完成于 ${timeText(j.checked_at)}。`, 'meta'));
    $('enrichmentJournals').replaceChildren(...items);
  }
}

function renderFilters({ syncQuery = true } = {}) {
  const journals = state.data.journals, categories = [...new Map(journals.map((item) => [item.category, item.category_zh]))];
  if (!categories.some(([key]) => key === state.filters.category)) state.filters.category = '';
  if (!journals.some((item) => item.key === state.filters.journal && (!state.filters.category || item.category === state.filters.category))) state.filters.journal = '';
  const option = (value, label) => { const element = node('option', label); element.value = value; return element; };
  $('category').replaceChildren(option('', '全部分类'), ...categories.map(([key, label]) => option(key, label)));
  $('journal').replaceChildren(option('', state.filters.category ? '本分类全部期刊' : `全部${journals.length}刊`),
    ...journals.filter((item) => !state.filters.category || item.category === state.filters.category).map((item) => option(item.key, `${item.key} · ${item.name}`)));
  $('category').value = state.filters.category; $('journal').value = state.filters.journal;
  state.filters.kind = normalizeDocumentFilter(state.filters.kind);
  $('kind').replaceChildren(...Object.entries(DOCUMENT_LABELS).map(([key, label]) => option(key, label)));
  $('kind').value = state.filters.kind;
  if (syncQuery) $('query').value = state.filters.q;
  $('quickFilters').replaceChildren(...['', 'AER', 'JAR', 'JAE', 'CAR'].map((key) => {
    const item = button(key || '全部19刊', () => {
      clearTimeout(searchTimer); state.filters.q = $('query').value.trim();
      state.filters.journal = key; state.filters.category = ''; state.page = 1; renderFilters(); render();
    });
    item.setAttribute('aria-pressed', String(state.filters.journal === key && (!state.filters.category || Boolean(key))));
    return item;
  }));
}

function renderCalendar(papers) {
  const counts = countsByDay(papers), keys = selectedJournalKeys(state.data.journals, state.filters);
  $('monthTitle').textContent = `${state.month.slice(0, 4)}年 ${Number(state.month.slice(5))}月`;
  $('calendarMeta').textContent = `今天 ${today}（北京）；${DOCUMENT_LABELS[state.filters.kind]}，本月匹配 ${papers.filter((paper) => paper.first_seen_date.startsWith(state.month)).length} 条。点击日期查看。`;
  const cells = ['一', '二', '三', '四', '五', '六', '日'].map((label) => node('div', label, 'weekday'));
  for (const date of monthCells(state.month)) {
    if (!date) { const blank = node('div', '', 'day-cell empty'); blank.setAttribute('aria-hidden', 'true'); cells.push(blank); continue; }
    const coverage = coverageForDay(state.data.runs, date, keys), count = counts[date] || 0;
    const link = node('a', '', `day-cell ${count ? 'has-recommendations' : ''} ${date === today ? 'today' : ''} ${date > today ? 'future' : ''}`);
    link.href = pageHref('day.html', state.filters, { date });
    link.setAttribute('aria-label', `${date}${date === today ? ' 今天' : ''}，${count}条匹配记录，${date > today ? '未来日期' : coverage.label}`);
    if (date === today) link.setAttribute('aria-current', 'date');
    link.append(node('span', String(Number(date.slice(8))), 'day-number'),
      node('span', `${date === today ? '今日 · ' : ''}${count}条`, 'day-note day-count'),
      node('span', date > today ? '未到日期' : coverage.label, 'day-status'));
    cells.push(link);
  }
  $('calendarGrid').replaceChildren(...cells);
}

function oldTranslation(field, paper) {
  if (!paper[`${field}_zh`] || paper[`${field}_translation_status`] === 'done') return null;
  const details = node('details'); details.append(node('summary', `查看旧中文${field === 'title' ? '标题' : '摘要'}（不作为当前译文）`),
    node('p', paper[`${field}_zh`], 'summary')); return details;
}
function renderPaper(paper) {
  const card = node('article', '', 'paper-card');
  const tags = node('div', '', 'paper-tags');
  const kind = documentKind(paper);
  tags.append(node('span', `${paper.journal_key} · ${paper.journal_category_zh}`, 'status-badge'),
    node('span', DOCUMENT_LABELS[kind], `status-badge document-kind ${kind}`),
    ...paper.sources.map((source) => node('span', sourceLabel(source), 'status-badge')));
  card.append(tags, node('h3', paperTitle(paper)));
  const classification = node('details', '', 'classification-detail');
  classification.append(node('summary', '为什么这样分类？'), node('p',
    CLASSIFICATION_REASONS[paper.classification?.rule] || '缺少可核实的分类依据，需人工核查。', 'meta'));
  card.append(classification);
  if (kind === 'possible_retraction' || kind === 'possible_correction') card.append(node('p',
    '这条记录是疑似通知，不是普通研究论文。请核对通知正文及它所指的原论文；系统不会自动删除或合并原论文。', 'notice'));
  if (paper.title_translation_status === 'done') {
    const english = node('p', paper.title_original, 'english-title'); english.lang = 'en'; card.append(english);
  }
  card.append(node('p', `标题：${TRANSLATION_LABELS[paper.title_translation_status]} · 摘要：${TRANSLATION_LABELS[paper.abstract_translation_status]}`, 'meta'));
  const oldTitle = oldTranslation('title', paper); if (oldTitle) card.append(oldTitle);
  const names = paper.authors.map((author) => author.name);
  if (names.length > 4) {
    const details = node('details', '', 'paper-authors');
    details.append(node('summary', `作者：${names.slice(0, 4).join('；')} 等${names.length}位（展开全部）`), node('p', names.join('；'))); card.append(details);
  } else card.append(node('p', `作者：${names.join('；') || '来源未提供作者'}`, 'paper-authors'));
  if (paper.author_variants?.length > 1) {
    const details = node('details', '', 'author-variants');
    details.append(node('summary', '来源作者写法不同（展开对照）'),
      node('p', '以下保留各来源的署名及顺序。差异可能只是拼写，也可能需要核对；不据此自动合并作者。', 'meta'));
    for (const variant of paper.author_variants) details.append(node('p',
      `${variant.sources.map(sourceLabel).join(' / ')}：${variant.names.join('；')}`, 'meta'));
    card.append(details);
  }
  card.append(node('p', paper.journal_name, 'meta'));
  const abstractState = node('p', `原始摘要：${ABSTRACT_LABELS[paper.abstract_status] || (paper.abstract_original ? '已有摘要' : '待补全')}${paper.abstract_next_retry_at ? `；下次尝试不早于 ${timeText(paper.abstract_next_retry_at)}` : ''}`, 'meta');
  const sourceUrl = abstractSourceHref(paper.abstract_source_url);
  if (sourceUrl && paper.abstract_original) {
    const link = node('a', ` · 查看 ${sourceLabel(paper.abstract_source)} 来源`, 'ghost-link'); link.href = sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; abstractState.append(link);
  }
  card.append(abstractState);
  if (paper.abstract_original) {
    const translated = paper.abstract_translation_status === 'done' && Boolean(paper.abstract_zh);
    const abstract = node('p', translated ? paper.abstract_zh : paper.abstract_original, 'summary');
    abstract.lang = translated ? 'zh-CN' : 'en';
    if (translated) {
      const controls = node('div', '', 'abstract-switch'); controls.setAttribute('aria-label', '摘要语言');
      const setLanguage = (zh) => {
        abstract.textContent = zh ? paper.abstract_zh : paper.abstract_original; abstract.lang = zh ? 'zh-CN' : 'en';
        chinese.setAttribute('aria-pressed', String(zh)); english.setAttribute('aria-pressed', String(!zh));
      };
      const chinese = button('中文摘要', () => setLanguage(true));
      const english = button('English abstract', () => setLanguage(false));
      controls.append(chinese, english); setLanguage(true); card.append(controls);
    } else card.append(node('p', '英文摘要', 'meta'));
    card.append(abstract);
  } else card.append(node('p', '来源未提供摘要。暂不补写或推测论文内容。', 'empty-state'));
  const oldAbstract = oldTranslation('abstract', paper); if (oldAbstract) card.append(oldAbstract);
  const date = (field) => publicationDateText(paper[field], paper.date_sources?.[field]);
  card.append(node('p', `首次发现：${paper.first_seen_date}（北京） · 在线发表：${date('published_online_date')} · 纸刊发表：${date('published_print_date')}`, 'meta'));
  if (paper.publication_date) card.append(node('p', `来源通用发表日期：${date('publication_date')}（不等同于在线发表日期）`, 'meta'));
  const bibliographic = [paper.volume ? `卷 ${paper.volume}` : '', paper.issue ? `期 ${paper.issue}` : '', paper.pages ? `页 ${paper.pages}` : ''].filter(Boolean);
  if (bibliographic.length) card.append(node('p', bibliographic.join(' · '), 'meta'));
  const actions = node('div', '', 'paper-actions'), href = doiHref(paper.doi);
  if (href) {
    const link = node('a', `DOI：${paper.doi}`, 'ghost-link'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link);
  } else actions.append(node('span', '来源未提供可用 DOI', 'meta'));
  if (!isDayPage) {
    const link = node('a', '查看发现当日', 'ghost-link'); link.href = pageHref('day.html', state.filters, { date: paper.first_seen_date }); actions.append(link);
  }
  card.append(actions); return card;
}

function renderList(papers) {
  const pageSize = 20, pageCount = Math.max(1, Math.ceil(papers.length / pageSize));
  state.page = Math.min(state.page, pageCount);
  $('listMeta').textContent = `找到 ${papers.length} 条${isDayPage ? '本日' : '全部日期的'}匹配记录（${DOCUMENT_LABELS[state.filters.kind]}）${papers.length ? `；第 ${state.page}/${pageCount} 页，每页最多 ${pageSize} 条` : ''}。`;
  $('paperList').replaceChildren(...papers.slice((state.page - 1) * pageSize, state.page * pageSize).map(renderPaper));
  if (!papers.length) $('paperList').append(node('p', !state.data.initialized ? (isStaticPage ? '尚无已发布的论文，请等待维护者完成首次采集。' : '尚未建立真实论文库。完成一次手动采集并保存后，在这里重新读取即可。') :
    '当前条件下没有记录。可切换文献类型、重置筛选或查看其他日期；没有匹配结果不表示当天已成功采集。', 'empty-state'));
  $('pagination').replaceChildren();
  if (pageCount > 1) {
    const move = (delta) => {
      state.page += delta; renderList(papers);
      const title = $('listTitle'); title.setAttribute('tabindex', '-1');
      title.focus({ preventScroll: true }); title.scrollIntoView({ block: 'start' });
    };
    const previous = button('上一页', () => move(-1)), next = button('下一页', () => move(1));
    previous.disabled = state.page === 1; next.disabled = state.page === pageCount;
    $('pagination').append(previous, node('span', `${state.page} / ${pageCount}`), next);
  }
}

function render() {
  if (!state.data) return;
  today = beijingDay();
  syncUrl();
  if (isDayPage && !validDay(selectedDate)) {
    $('dayTitle').textContent = '日期无效'; $('dayCoverage').textContent = '请从日历点击有效日期进入。';
    $('paperList').replaceChildren(); $('listMeta').textContent = '没有展示其他日期的论文。'; return;
  }
  const papers = filterPapers(state.data.papers, { ...state.filters, date: isDayPage ? selectedDate : '' });
  if (isDayPage) {
    $('dayTitle').textContent = `${selectedDate} 论文详情`;
    const coverage = coverageForDay(state.data.runs, selectedDate, selectedJournalKeys(state.data.journals, state.filters));
    $('dayCoverage').textContent = `已保存记录显示：${selectedDate > today ? '未来日期' : coverage.label}；所选期刊 ${coverage.complete}/${coverage.total} 刊双源完成。采集状态不受搜索关键词或文献类型影响，数据源收录仍可能有延迟。`;
    document.title = `${selectedDate} 论文详情 · 经管顶刊`;
  } else renderCalendar(papers);
  renderList(papers);
}

async function load() {
  $('reload').disabled = true;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('./data.json', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Load failed');
    const data = await response.json();
    if (data.schema_version !== 1 || !Array.isArray(data.papers) || !Array.isArray(data.journals) || !Array.isArray(data.runs)) throw new Error('Invalid data');
    state.data = data;
    for (const control of $('filters').elements) control.disabled = false;
    renderStatus(); renderFilters(); render();
  } catch {
    $('statusBadge').textContent = '读取失败'; $('statusBadge').className = 'status-badge failed';
    $('statusText').textContent = state.data ? '新数据读取失败；下方保留本页上次成功读取的内容，不是最新结果。请检查论文库或稍后重试。' :
      (isStaticPage ? '网页数据暂时无法读取，请稍后重试或联系维护者；这不代表没有论文。' : '论文数据暂时无法读取或未通过校验。请通过本地只读预览打开页面，或检查论文库；这不代表没有论文。');
  } finally { clearTimeout(timer); $('reload').disabled = false; }
}

for (const control of $('filters').elements) control.disabled = true;
let searchTimer, composingQuery = false;
const applyFilters = ({ preserveQuery = false } = {}) => {
  if (!state.data) return;
  clearTimeout(searchTimer); state.filters.q = $('query').value.trim(); state.filters.journal = $('journal').value;
  state.filters.category = $('category').value; state.page = 1;
  state.filters.kind = normalizeDocumentFilter($('kind').value);
  renderFilters({ syncQuery: !preserveQuery }); render();
};
$('filters').addEventListener('submit', (event) => { event.preventDefault(); applyFilters(); });
const scheduleSearch = () => {
  clearTimeout(searchTimer);
  if (!composingQuery) searchTimer = setTimeout(() => applyFilters({ preserveQuery: true }), 180);
};
// Do not overwrite an in-progress query: this preserves spaces, caret and IME composition.
$('query').addEventListener('compositionstart', () => { composingQuery = true; clearTimeout(searchTimer); });
$('query').addEventListener('compositionend', () => { composingQuery = false; scheduleSearch(); });
$('query').addEventListener('input', scheduleSearch);
for (const id of ['journal', 'category', 'kind']) $(id).addEventListener('change', applyFilters);
$('reset').addEventListener('click', () => { clearTimeout(searchTimer); state.filters = { journal: '', category: '', kind: 'candidate', q: '' }; state.page = 1; renderFilters(); render(); });
$('reload').addEventListener('click', load);
if (!isDayPage) {
  for (const [id, delta] of [['prevMonth', -1], ['nextMonth', 1]]) $(id).addEventListener('click', () => { state.month = shiftMonth(state.month, delta); render(); });
  $('thisMonth').addEventListener('click', () => { state.month = beijingDay().slice(0, 7); render(); });
}
// Navigation must remain usable even while the first read is pending or fails.
syncUrl();
load();
