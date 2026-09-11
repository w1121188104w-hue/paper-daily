import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadJournalConfig } from '../src/services/journals.js';

// A deliberately small DOM double for renderer unit tests, not a browser or layout test.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {};
    this.value = ''; this.disabled = false; this.hidden = false; this.dataset = {}; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('Untrusted HTML insertion is forbidden'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(event, callback) { (this.listeners[event] ||= []).push(callback); }
  async trigger(event) {
    if (this.disabled && event === 'click') return;
    for (const callback of this.listeners[event] || []) await callback({ preventDefault() {} });
  }
  scrollIntoView() {}
  focus() { this.focused = true; }
}
const descendants = (element) => [element, ...element.children.flatMap(descendants)];
const config = await loadJournalConfig();
const journals = config.journals.map(({ key, name, category, category_zh }) => ({ key, name, category, category_zh }));
function paper(overrides = {}) {
  return { id: 'doi:10.1234/one', doi: '10.1234/one', journal_key: 'AER',
    journal_name: 'American Economic Review', journal_category: 'economics', journal_category_zh: '经济',
    first_seen_date: '2026-09-07', title_original: 'Credit markets and investment', title_zh: '信贷市场与投资',
    title_translation_status: 'done', abstract_original: 'We study firm investment.', abstract_zh: '我们研究企业投资。',
    classification: { version: 2, kind: 'candidate', rule: 'retain_by_default', excluded: false },
    abstract_translation_status: 'done', sources: ['openalex', 'crossref'],
    authors: [{ name: 'Alice Smith', orcid: '' }], published_online_date: '2026-08-01', published_print_date: '',
    publication_date: '2026-08-01', volume: '', issue: '', pages: '', ...overrides };
}
function payload(overrides = {}) {
  return { schema_version: 1, initialized: true, snapshot_at: '2026-09-07T01:00:00Z', journals,
    papers: [paper()], runs: [], pending: { paper_count: 0, field_count: 0 }, attempt_warning: null, ...overrides };
}
let sequence = 0;
async function app(t, { data = payload(), day = false, search = '?month=2026-09', fail = false } = {}) {
  const commonIds = ['main', 'statusTitle', 'statusBadge', 'statusText', 'attemptWarning', 'libraryMeta', 'enrichmentStatus', 'enrichmentJournals', 'reload',
    'filterTitle', 'filters', 'query', 'category', 'journal', 'kind', 'reset', 'quickFilters', 'listTitle', 'listMeta', 'paperList', 'pagination'];
  const ids = new Map([...commonIds, ...(day ? ['dayTitle', 'backToCalendar', 'dayCoverage'] :
    ['monthTitle', 'prevMonth', 'nextMonth', 'calendarMeta', 'thisMonth', 'calendarGrid'])].map((id) => [id, new Element('div')]));
  ids.get('filters').elements = ['query', 'category', 'journal', 'kind', 'reset'].map((id) => ids.get(id));
  const body = new Element('body'); body.dataset.page = day ? 'day' : '';
  const replacements = { document: { body, getElementById: (id) => ids.get(id) || null, createElement: (tag) => new Element(tag) },
    location: { search }, history: { replaceState(_state, _title, url) { replacements.history.url = url; } },
    fetch: async (url, options) => {
      assert.equal(url, './data.json'); assert.equal(options.method, undefined);
      assert.equal(options.cache, 'no-store');
      return { ok: !fail, json: async () => structuredClone(data) };
    } };
  const originals = Object.fromEntries(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(() => { for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  await import(`../public/journals/app.js?unit=${sequence++}`);
  await new Promise(setImmediate);
  const result = { get: (id) => ids.get(id), document: replacements.document, history: replacements.history,
    setData(value) { data = value; }, setFailure(value) { fail = value; } };
  return result;
}

test('两页HTML控件ID唯一、模块引用相对，不加载旧设置或第三方脚本', async () => {
  for (const page of ['index', 'day']) {
    const text = await fs.readFile(new URL(`../public/journals/${page}.html`, import.meta.url), 'utf8');
    const ids = [...text.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(ids.length, new Set(ids).size); assert.ok(text.includes('src="./app.js"'));
    for (const required of ['filters', 'query', 'journal', 'category', 'paperList', 'pagination', 'reload']) assert.ok(ids.includes(required));
    for (const forbidden of ['settings.js', 'home.js', 'src="/', 'fonts.googleapis', 'llmApiKey', 'fetchDayBtn']) assert.ok(!text.includes(forbidden));
  }
});
test('真实渲染函数生成日历、全部19刊、双语卡片及双源徽章', async (t) => {
  const ui = await app(t);
  assert.equal(ui.get('journal').children.length, 20); assert.equal(ui.get('category').children.length, 5);
  assert.equal(ui.get('quickFilters').children.length, 5); assert.equal(ui.get('paperList').children.length, 1);
  const text = ui.get('paperList').textContent;
  for (const value of ['信贷市场与投资', 'Credit markets', 'OpenAlex', 'Crossref', 'Alice Smith', '在线发表：2026-08-01']) assert.ok(text.includes(value), value);
  assert.equal(ui.get('calendarGrid').children.filter((element) => element.tagName === 'a').length, 30);
  assert.ok(ui.get('calendarGrid').children.some((element) => element.href?.includes('date=2026-09-07')));
});
test('摘要中英文切换改变全文、语言及按下状态', async (t) => {
  const ui = await app(t), elements = descendants(ui.get('paperList'));
  const english = elements.find((element) => element.tagName === 'button' && element.textContent === 'English abstract');
  const chinese = elements.find((element) => element.tagName === 'button' && element.textContent === '中文摘要');
  const abstract = elements.find((element) => element.textContent === '我们研究企业投资。');
  await english.trigger('click'); assert.equal(abstract.textContent, 'We study firm investment.'); assert.equal(abstract.lang, 'en');
  assert.equal(english.getAttribute('aria-pressed'), 'true');
  await chinese.trigger('click'); assert.equal(abstract.textContent, '我们研究企业投资。'); assert.equal(abstract.lang, 'zh-CN');
});
test('搜索与快捷筛选可叠加，快速点击不丢掉刚输入的关键词；重置恢复', async (t) => {
  const ui = await app(t);
  ui.get('query').value = '没有匹配'; await ui.get('query').trigger('input');
  await ui.get('quickFilters').children[1].trigger('click');
  assert.ok(ui.get('listMeta').textContent.includes('找到 0 条'));
  assert.equal(ui.get('query').value, '没有匹配'); assert.ok(ui.history.url.includes('journal=AER'));
  await ui.get('reset').trigger('click'); assert.ok(ui.get('listMeta').textContent.includes('找到 1 条'));
  assert.equal(ui.get('query').value, ''); assert.equal(ui.get('journal').value, '');
});
test('分类联动不会留下不相容期刊，快捷切换回AER能显示论文', async (t) => {
  const ui = await app(t, { search: '?month=2026-09&journal=AER' });
  ui.get('category').value = 'accounting'; await ui.get('category').trigger('change');
  assert.equal(ui.get('journal').value, ''); assert.equal(ui.get('journal').children.length, 7);
  assert.ok(ui.get('listMeta').textContent.includes('找到 0 条'));
  await ui.get('quickFilters').children[1].trigger('click');
  assert.equal(ui.get('category').value, ''); assert.ok(ui.get('listMeta').textContent.includes('找到 1 条'));
});

test('自动搜索保留正在输入的空格，允许停顿后继续输入第二个词', async (t) => {
  const ui = await app(t);
  ui.get('query').value = 'credit '; await ui.get('query').trigger('input');
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(ui.get('query').value, 'credit ');
  assert.ok(ui.get('listMeta').textContent.includes('找到 1 条'));
  ui.get('query').value += 'Alice'; await ui.get('query').trigger('input');
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(ui.get('query').value, 'credit Alice');
  assert.ok(ui.get('listMeta').textContent.includes('找到 1 条'));
});

test('中文输入法组词期间不搜索，组词完成后再搜索', async (t) => {
  const ui = await app(t);
  await ui.get('query').trigger('compositionstart');
  ui.get('query').value = 'xin'; await ui.get('query').trigger('input');
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(ui.get('query').value, 'xin');
  assert.ok(ui.get('listMeta').textContent.includes('找到 1 条'));
  ui.get('query').value = '信贷'; await ui.get('query').trigger('compositionend');
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(ui.get('query').value, '信贷');
  assert.ok(ui.history.url.includes('q='));
  assert.ok(ui.get('listMeta').textContent.includes('找到 1 条'));
});
test('年月切换更新日历与地址，列表仍搜索全部日期', async (t) => {
  const ui = await app(t, { search: '?month=2026-12' });
  await ui.get('nextMonth').trigger('click'); assert.equal(ui.get('monthTitle').textContent, '2027年 1月');
  assert.ok(ui.history.url.includes('month=2027-01')); assert.equal(ui.get('paperList').children.length, 1);
  await ui.get('prevMonth').trigger('click'); assert.equal(ui.get('monthTitle').textContent, '2026年 12月');
});
test('日期页保留筛选，只显示首次发现当日，不扩大至全部日期', async (t) => {
  const ui = await app(t, { day: true, search: '?date=2026-09-06&journal=AER&q=credit' });
  assert.ok(ui.get('listMeta').textContent.includes('找到 0 条'));
  assert.ok(ui.get('backToCalendar').href.includes('journal=AER')); assert.ok(ui.get('backToCalendar').href.includes('month=2026-09'));
  assert.ok(ui.get('dayCoverage').textContent.includes('未采集'));
});
test('日期参数错误清晰提示，不借用今日日期', async (t) => {
  const ui = await app(t, { day: true, search: '?date=2026-02-30' });
  assert.equal(ui.get('dayTitle').textContent, '日期无效'); assert.equal(ui.get('paperList').children.length, 0);
});

test('日期页首次读取失败也保留返回日历的月份、分类、期刊和关键词', async (t) => {
  const ui = await app(t, { day: true, fail: true,
    search: '?date=2026-08-15&category=economics&journal=AER&q=credit+Alice' });
  assert.equal(ui.get('statusBadge').textContent, '读取失败');
  const back = new URL(ui.get('backToCalendar').href, 'http://localhost/journals/');
  assert.equal(back.searchParams.get('month'), '2026-08');
  assert.equal(back.searchParams.get('category'), 'economics');
  assert.equal(back.searchParams.get('journal'), 'AER');
  assert.equal(back.searchParams.get('q'), 'credit Alice');
  assert.equal(ui.get('paperList').children.length, 0);
});
test('分页显示完整匹配集，第二页不遗漏最后论文，筛选后回到第一页', async (t) => {
  const ui = await app(t, { data: payload({ papers: Array.from({ length: 21 }, (_, i) => paper({ id: `paper:${String(i).padStart(2, '0')}` })) }) });
  assert.equal(ui.get('paperList').children.length, 20);
  await ui.get('pagination').children[2].trigger('click'); assert.equal(ui.get('paperList').children.length, 1);
  assert.ok(ui.get('listMeta').textContent.includes('第 2/2 页'));
  assert.equal(ui.get('listTitle').getAttribute('tabindex'), '-1');
  assert.equal(ui.get('listTitle').focused, true);
  await ui.get('reset').trigger('click'); assert.equal(ui.get('paperList').children.length, 20);
});
test('长作者名单保序可展开，恶意标题仅作文字，过时中文折叠标注', async (t) => {
  const malicious = '<img src=x onerror=alert(1)>';
  const ui = await app(t, { data: payload({ papers: [paper({ title_original: malicious, title_translation_status: 'outdated',
    abstract_translation_status: 'outdated', authors: ['A', 'B', 'C', 'D', 'E'].map((name) => ({ name })) })] }) });
  const elements = descendants(ui.get('paperList'));
  assert.equal(elements.find((element) => element.tagName === 'h3').textContent, malicious);
  assert.equal(elements.some((element) => element.tagName === 'img'), false);
  assert.ok(elements.some((element) => element.tagName === 'summary' && element.textContent.includes('等5位')));
  assert.ok(ui.get('paperList').textContent.includes('A；B；C；D；E'));
  assert.ok(ui.get('paperList').textContent.includes('不作为当前译文')); assert.ok(ui.get('paperList').textContent.includes('We study firm investment.'));
});
test('无摘要保留论文且不出现虚构中文摘要', async (t) => {
  const ui = await app(t, { data: payload({ papers: [paper({ abstract_original: '', abstract_zh: '', abstract_translation_status: 'no_abstract' })] }) });
  assert.equal(ui.get('paperList').children.length, 1); assert.ok(ui.get('paperList').textContent.includes('来源未提供摘要'));
  assert.ok(!descendants(ui.get('paperList')).some((element) => element.textContent === 'English abstract'));
});
test('空库显示尚未采集，初次读取失败不渲染假零条日历', async (t) => {
  const ui = await app(t, { fail: true });
  assert.equal(ui.get('statusBadge').textContent, '读取失败'); assert.equal(ui.get('calendarGrid').children.length, 0);
  assert.equal(ui.get('query').disabled, true);
  ui.setFailure(false); ui.setData(payload({ initialized: false, papers: [], snapshot_at: null }));
  await ui.get('reload').trigger('click'); assert.equal(ui.get('statusBadge').textContent, '尚未采集');
  assert.ok(ui.get('paperList').textContent.includes('尚未建立真实论文库'));
});
test('重新读取失败保留旧列表并明确不是最新；恢复后更新', async (t) => {
  const ui = await app(t); ui.setFailure(true); await ui.get('reload').trigger('click');
  assert.equal(ui.get('paperList').children.length, 1); assert.ok(ui.get('statusText').textContent.includes('不是最新结果'));
  ui.setFailure(false); ui.setData(payload({ papers: [] })); await ui.get('reload').trigger('click');
  assert.ok(ui.get('listMeta').textContent.includes('找到 0 条')); assert.equal(ui.get('reload').disabled, false);
});
test('未提交采集尝试使状态醒目标注需核查，而非继续显示成功', async (t) => {
  const ui = await app(t, { data: payload({ attempt_warning: { status: 'uncommitted_failure', started_at: '2026-09-07T01:00:00Z' } }) });
  assert.equal(ui.get('statusBadge').textContent, '最新尝试需核查'); assert.equal(ui.get('attemptWarning').hidden, false);
  assert.ok(ui.get('attemptWarning').textContent.includes('未能保存'));
});

test('默认只看研究候选，切换文献类型后日历列表同口径，快捷期刊保留类型', async (t) => {
  const ui = await app(t, { data: payload({ papers: [paper(), paper({ id: 'admin', title_original: 'Issue Information',
    classification: { kind: 'administrative', rule: 'issue_information_title' } })] }) });
  assert.equal(ui.get('kind').value, 'candidate'); assert.equal(ui.get('paperList').children.length, 1);
  ui.get('kind').value = 'administrative'; await ui.get('kind').trigger('change');
  assert.equal(ui.get('paperList').children.length, 1); assert.ok(ui.get('listMeta').textContent.includes('期刊资料'));
  assert.ok(ui.get('paperList').textContent.includes('为什么这样分类'));
  assert.ok(ui.get('calendarGrid').children.find((cell) => cell.href?.includes('date=2026-09-07')).href.includes('kind=administrative'));
  await ui.get('quickFilters').children[1].trigger('click'); assert.equal(ui.get('kind').value, 'administrative');
  ui.get('kind').value = 'all'; await ui.get('kind').trigger('change'); assert.equal(ui.get('paperList').children.length, 2);
  await ui.get('reset').trigger('click'); assert.equal(ui.get('kind').value, 'candidate');
});

test('通知明确警示，不认定关联原论文已撤稿；日期页保留类型及其他筛选', async (t) => {
  const ui = await app(t, { day: true, search: '?date=2026-09-07&journal=AER&kind=possible_retraction',
    data: payload({ papers: [paper({ classification: { kind: 'possible_retraction', rule: 'notice_title' } })] }) });
  assert.ok(ui.get('paperList').textContent.includes('疑似撤稿通知'));
  assert.ok(ui.get('paperList').textContent.includes('不会自动删除或合并原论文'));
  assert.ok(ui.get('backToCalendar').href.includes('kind=possible_retraction'));
  assert.ok(ui.get('backToCalendar').href.includes('journal=AER'));
});

test('日期页首次读取失败仍保留文献类型，不用成功读取才准备返回链接', async (t) => {
  const ui = await app(t, { day: true, fail: true, search: '?date=2026-09-07&kind=administrative' });
  assert.ok(ui.get('backToCalendar').href.includes('kind=administrative'));
  assert.equal(ui.get('kind').disabled, true);
});

test('类型变化使分页回到第一页，总数用记录表述，不将资料称为研究论文', async (t) => {
  const rows = Array.from({ length: 21 }, (_, index) => paper({ id: `candidate-${index}` }));
  rows.push(paper({ id: 'admin', classification: { kind: 'administrative', rule: 'issue_information_title' } }));
  const ui = await app(t, { data: payload({ papers: rows }) });
  await ui.get('pagination').children[2].trigger('click');
  ui.get('kind').value = 'administrative'; await ui.get('kind').trigger('change');
  assert.ok(ui.get('listMeta').textContent.includes('第 1/1 页')); assert.equal(ui.get('paperList').children.length, 1);
  assert.ok(ui.get('libraryMeta').textContent.includes('22 条文献记录'));
  assert.ok(ui.get('libraryMeta').textContent.includes('期刊资料 1 条'));
});

test('卡片展示日期来源和年月精度，不声称来源日期已经官网核实', async (t) => {
  const ui = await app(t, { data: payload({ papers: [paper({ published_online_date: '2026-08',
    published_print_date: '2026-09-01', date_sources: { published_online_date: 'crossref', published_print_date: 'crossref' } })] }) });
  const text = ui.get('paperList').textContent;
  assert.ok(text.includes('在线发表：2026-08（Crossref；仅提供月份）'));
  assert.ok(text.includes('纸刊发表：2026-09-01（Crossref；数据库标注日期，未逐篇核实到日）'));
  assert.ok(text.includes('首次发现：2026-09-07（北京）'));
});

test('作者来源差异可展开对照，保持来源顺序并将特殊文本作为文字', async (t) => {
  const name = '<img src=x onerror=alert(1)>';
  const ui = await app(t, { data: payload({ papers: [paper({ author_variants: [
    { sources: ['crossref'], names: ['Benjamin A. Olken', name] },
    { sources: ['openalex'], names: ['Benjamin Olken', 'Second Author'] }
  ] })] }) });
  const text = ui.get('paperList').textContent, elements = descendants(ui.get('paperList'));
  assert.ok(text.includes('来源作者写法不同（展开对照）'));
  assert.ok(text.includes(`Crossref：Benjamin A. Olken；${name}`));
  assert.ok(text.includes('不据此自动合并作者'));
  assert.ok(!elements.some(element => element.tagName === 'img'));
});

test('网页显示官网部分核对/受限与摘要真实来源，不把未知显示成零篇或生成摘要', async t => {
  const ui = await app(t,{ data: payload({ papers: [paper({ sources: ['publisher'],abstract_status: 'found',abstract_source: 'publisher',
    abstract_source_url: 'https://www.aeaweb.org/articles?id=10.1234/one' })],enrichment: {
      latest: { finished_at: '2026-09-11T01:00:00Z',stats: { added: 0,abstracts_filled: 1 } },missing_abstracts: 3,
      journals: [{ journal_key: 'AER',coverage: 'partial',official_observed_count: 10,official_in_window_count: 9,
        existing_total_count: 9,missing_count: 0,added_count: 0,pending_count: 1,from_date: '2026-07-14',to_date: '2026-09-11',checked_at: '2026-09-11T01:00:00Z' },
      { journal_key: 'JPE',coverage: 'restricted',official_observed_count: null,official_in_window_count: 0,
        existing_total_count: 4,missing_count: 0,added_count: 0,pending_count: 0,from_date: '2026-07-14',to_date: '2026-09-11',checked_at: '2026-09-11T01:00:00Z' }] }
  }) });
  assert.ok(ui.get('enrichmentJournals').textContent.includes('官网清单观察 未知 条'));
  assert.ok(ui.get('enrichmentJournals').textContent.includes('部分核对'));
  assert.ok(ui.get('paperList').textContent.includes('期刊／出版社官网'));
  assert.ok(ui.get('paperList').textContent.includes('已从真实来源补全'));
  assert.ok(descendants(ui.get('paperList')).some(e => e.href === 'https://www.aeaweb.org/articles?id=10.1234/one'));
});

test('摘要来源链接白名单拒绝脚本/凭据/站外地址，待重试不展示伪中文', async t => {
  const ui = await app(t,{ data: payload({ papers: [paper({ abstract_original: '',abstract_zh: '',abstract_translation_status: 'no_abstract',
    abstract_status: 'access_restricted',abstract_next_retry_at: '2026-09-12T01:00:00Z',abstract_source_url: 'javascript:alert(1)' })] }) });
  assert.ok(ui.get('paperList').textContent.includes('部分来源访问受限'));
  assert.ok(ui.get('paperList').textContent.includes('不补写或推测'));
  assert.ok(!descendants(ui.get('paperList')).some(e => e.href?.startsWith('javascript:')));
});
