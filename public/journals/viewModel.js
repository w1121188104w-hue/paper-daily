export const RUN_LABELS = { success: '采集成功', no_updates: '采集完成，无新增或更新',
  partial_failure: '部分来源失败', full_failure: '采集失败' };
export const TRANSLATION_LABELS = { pending: '待翻译', done: '已翻译', failed: '翻译失败，待重试',
  outdated: '原文已更新，待重译', no_abstract: '来源未提供摘要' };
export const DOCUMENT_LABELS = { candidate: '研究论文候选', all: '全部文献记录', administrative: '期刊资料',
  possible_correction: '疑似更正通知', possible_retraction: '疑似撤稿通知', needs_review: '待人工核查' };
export const CLASSIFICATION_REASONS = {
  retain_by_default: '未命中已知非论文规则；仍是候选，不代表已人工确认。',
  exact_administrative_title: '标题与目录、编委会等期刊资料规则精确匹配。',
  issue_information_title: '标题明确标为期刊信息或其征稿附页。',
  journal_specific_administrative_title: '期刊及标题共同匹配已核查的期刊资料规则。',
  notice_title: '标题提示这是更正或撤稿通知；请到来源核实具体内容及所指论文。',
  source_notice_type: '来源类型提示这是更正或撤稿通知；请到来源核实。',
  source_disagreement_notice: '来源分类不一致且含通知线索；保留提醒，不据此认定另一篇论文已撤稿。',
  source_type_needs_review: '来源标为附属材料、编者文字或书评，需要人工核查，暂不排除。',
  source_classification_disagreement: '来源的标题或类型分类不一致，暂不归为研究论文或期刊资料。',
  missing_title: '缺少可用标题，需要人工核查。'
};
export const documentKind = (paper) => Object.hasOwn(DOCUMENT_LABELS, paper.classification?.kind || '') &&
  paper.classification.kind !== 'all' ? paper.classification.kind : 'needs_review';
export const normalizeDocumentFilter = (value) => Object.hasOwn(DOCUMENT_LABELS, value || '') ? value : 'candidate';

export function beijingDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export const validMonth = (value) => typeof value === 'string' && validDay(`${value}-01`);
export function shiftMonth(month, offset) {
  if (!validMonth(month)) throw new Error('月份无效');
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  const result = date.toISOString().slice(0, 7);
  return validMonth(result) ? result : month;
}
export function monthCells(month) {
  if (!validMonth(month)) throw new Error('月份无效');
  const first = new Date(`${month}-01T00:00:00Z`), last = new Date(first);
  last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
  return [...Array((first.getUTCDay() + 6) % 7).fill(null),
    ...Array.from({ length: last.getUTCDate() }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
}
const normalized = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export const sourceLabel = (source) => ({ crossref: 'Crossref', openalex: 'OpenAlex' })[source] || '来源未标明';
export function publicationDateText(value, source) {
  if (!value) return '未提供';
  const precision = /^\d{4}$/.test(value) && Number(value) > 0 ? '仅提供年份' : validMonth(value) ? '仅提供月份' :
    validDay(value) ? '数据库标注日期，未逐篇核实到日' : null;
  return precision ? `${value}（${sourceLabel(source)}；${precision}）` : '日期无效，需核查';
}
export function filterPapers(papers, { journal = '', category = '', q = '', date = '', kind = 'all' } = {}) {
  const tokens = normalized(q).split(' ').filter(Boolean);
  return papers.filter((paper) => {
    if ((journal && paper.journal_key !== journal) || (category && paper.journal_category !== category) ||
        (date && paper.first_seen_date !== date) || (kind !== 'all' && documentKind(paper) !== kind)) return false;
    if (!tokens.length) return true;
    const haystack = normalized([paper.title_original, paper.title_zh, paper.abstract_original, paper.abstract_zh,
      paper.doi, paper.journal_key, paper.journal_name, paper.journal_category_zh, paper.first_seen_date,
      paper.published_online_date, paper.published_print_date, paper.publication_date,
      ...paper.authors.map((author) => author.name),
      ...(paper.author_variants || []).flatMap((variant) => variant.names)].join(' '));
    return tokens.every((token) => haystack.includes(token));
  })
    .sort((a, b) => b.first_seen_date.localeCompare(a.first_seen_date) || a.journal_key.localeCompare(b.journal_key) || a.id.localeCompare(b.id));
}
export function countsByDay(papers) {
  const counts = {}, seen = new Set();
  for (const paper of papers) {
    if (seen.has(paper.id)) continue;
    seen.add(paper.id); counts[paper.first_seen_date] = (counts[paper.first_seen_date] || 0) + 1;
  }
  return counts;
}
export function selectedJournalKeys(journals, { journal = '', category = '' } = {}) {
  return journals.filter((item) => (!journal || item.key === journal) && (!category || item.category === category)).map((item) => item.key);
}
export function coverageForDay(runs, date, keys) {
  // Use the latest attempt per journal that day; a later failure must not be hidden by an earlier success.
  let complete = 0, failed = 0, attempted = 0;
  for (const key of keys) {
    const run = runs.filter((item) => item.run_date === date && item.journal_keys.includes(key))
      .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
    if (!run) continue;
    attempted++;
    if (run.status !== 'full_failure' && ['openalex', 'crossref'].every((source) =>
      run.sources.some((item) => item.journal_key === key && item.source === source && item.ok && item.complete))) complete++;
    else failed++;
  }
  const label = !keys.length ? '无匹配期刊' : !attempted ? '未采集' : failed ? '采集不完整' :
    complete < keys.length ? '仅部分期刊已采集' : '双源采集完成';
  return { complete, failed, attempted, total: keys.length, label };
}
export function paperTitle(paper) {
  return paper.title_translation_status === 'done' && paper.title_zh ? paper.title_zh : paper.title_original;
}
export function doiHref(doi) {
  // Build the link from a validated DOI, never from a source-provided URL.
  return typeof doi === 'string' && /^10\.\d{4,9}\/\S+$/i.test(doi) && !/[<>"\x00-\x20]/.test(doi)
    ? `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}` : null;
}
export function pageHref(page, filters = {}, extra = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) if (value) params.set(key, value);
  return `${page}${params.size ? `?${params}` : ''}`;
}
