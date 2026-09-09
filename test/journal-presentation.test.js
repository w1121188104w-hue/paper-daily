import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { readJournalLibrary, writeLibraryJson, newRunId } from '../src/services/journalLibrary.js';
import { presentJournalLibrary, loadJournalPresentation, latestAttemptWarning, authorVariants } from '../src/services/journalPresentation.js';
import { createJournalPreviewServer } from '../src/journalPreviewServer.js';
import { beijingDay, validDay, validMonth, shiftMonth, monthCells, filterPapers, countsByDay,
  selectedJournalKeys, coverageForDay, paperTitle, doiHref, pageHref, publicationDateText } from '../public/journals/viewModel.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER');
const checkedAt = '2026-09-07T01:00:00.000Z';
function record(overrides = {}) {
  return normalizeSourceRecord({ source: 'crossref', source_id: '10.1234/one', doi: '10.1234/one',
    title: 'Credit markets and firm investment', abstract: 'We study capital allocation in 2020.',
    authors: [{ name: 'Alice Smith', orcid: '' }], journal_key: 'AER', journal_name: journal.name,
    journal_category: journal.category, journal_category_zh: journal.category_zh,
    print_issn: journal.print_issn, electronic_issn: journal.electronic_issn,
    publication_date: '2026-08-01', last_checked_at: checkedAt, ...overrides });
}
function clients(records = [record()]) {
  return Object.fromEntries(['openalex', 'crossref'].map((source) => [source, async (j) => ({
    source, journal_key: j.key, ok: true, complete: true, records: source === 'crossref' ? records : [],
    raw_count: source === 'crossref' ? records.length : 0, raw_pages: [{ private_marker: 'MUST_NOT_APPEAR_IN_WEBSITE' }],
    rejected: [], duration_ms: 0, error: null
  })]));
}
const base = () => mergePapers([record()], { firstSeenDate: '2026-09-07', checkedAt }).papers;
async function fixture(t, collect = true) {
  const parent = path.resolve(os.tmpdir()), temp = await fs.mkdtemp(path.join(parent, 'journal-preview-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)), parent); assert.ok(path.basename(temp).startsWith('journal-preview-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, 'library');
  if (collect) await runJournalCollection(config, { root, journalKey: 'AER', clients: clients(), now: () => new Date(checkedAt) });
  return { root, temp };
}
async function serve(t, options) {
  const server = createJournalPreviewServer({ config, ...options });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
async function request(url, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${url}${pathname}`, { method, headers }, (res) => {
      const parts = []; res.on('data', (chunk) => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }));
    }); req.on('error', reject); req.end();
  });
}

test('预览读取空库不创建目录，空库不是成功无新增', async (t) => {
  const { root, temp } = await fixture(t, false), data = await loadJournalPresentation(config, { root });
  assert.equal(data.initialized, false); assert.equal(data.journals.length, 19); assert.equal(data.papers.length, 0);
  assert.deepEqual(data.runs, []); assert.equal(data.attempt_warning, null); assert.deepEqual(await fs.readdir(temp), []);
});
test('网页数据为白名单，含双源署名和翻译状态，不含原始页、内部路径或工作批次', async (t) => {
  const { root } = await fixture(t), data = await loadJournalPresentation(config, { root });
  assert.equal(data.papers.length, 1); assert.equal(data.papers[0].title_translation_status, 'pending');
  assert.equal(data.runs[0].journal_keys.length, 1); assert.deepEqual(data.papers[0].sources, ['crossref']);
  const text = JSON.stringify(data);
  for (const hidden of ['MUST_NOT_APPEAR_IN_WEBSITE', 'source_records', 'source_text_hash', 'audit_path', 'snapshots/', 'run_id']) assert.ok(!text.includes(hidden));
});
test('双源同一DOI合并后日历只计一篇，按首次发现日而非发表日计数', () => {
  const papers = mergePapers([record(), record({ source: 'openalex', source_id: 'W123456' })],
    { firstSeenDate: '2026-09-07', checkedAt }).papers;
  assert.equal(papers.length, 1); assert.equal(papers[0].sources.length, 2);
  assert.deepEqual(countsByDay([...papers, ...papers]), { '2026-09-07': 1 });
});
test('日历今天固定北京时区，UTC下午跨到北京次日', () => {
  assert.equal(beijingDay(new Date('2026-09-07T15:59:59Z')), '2026-09-07');
  assert.equal(beijingDay(new Date('2026-09-07T16:00:00Z')), '2026-09-08');
});
test('月份跨年与闰年正确，周一开头，不接受不存在的日期', () => {
  assert.equal(shiftMonth('2026-12', 1), '2027-01'); assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(monthCells('2024-02').filter(Boolean).length, 29);
  assert.equal(monthCells('2026-02').filter(Boolean).length, 28);
  assert.equal(monthCells('2026-09')[0], null); assert.equal(monthCells('2026-09')[1], '2026-09-01');
  for (const value of ['2026-02-29', '2026-13-01', '2026-9-07', '', null]) assert.equal(validDay(value), false);
  assert.equal(validDay('2024-02-29'), true); assert.equal(validMonth('2026-13'), false);
});
test('中英文标题、摘要、作者、DOI、期刊、日期均可搜索，忽略大小写和全角', () => {
  const papers = base(); papers[0].title_zh = '信贷市场与企业投资'; papers[0].abstract_zh = '研究资本配置';
  for (const q of ['CREDIT', 'ＡＬＩＣＥ', '企业投资', '资本配置', 'allocation', '10.1234/one', 'American Economic Review', '2026-08-01', '2026-09-07', '经济']) {
    assert.equal(filterPapers(papers, { q }).length, 1, q);
  }
  assert.equal(filterPapers(papers, { q: 'CREDIT Alice' }).length, 1);
  assert.equal(filterPapers(papers, { q: 'CREDIT unrelated' }).length, 0);
});
test('关键词、期刊、分类和发现日期叠加筛选，不悄悄扩大范围', () => {
  const papers = base();
  assert.equal(filterPapers(papers, { journal: 'AER', category: 'economics', q: 'credit', date: '2026-09-07' }).length, 1);
  for (const filters of [{ journal: 'JAR' }, { category: 'accounting' }, { date: '2026-08-01' }]) assert.equal(filterPapers(papers, filters).length, 0);
  assert.equal(selectedJournalKeys(config.journals).length, 19);
  assert.deepEqual(selectedJournalKeys(config.journals, { journal: 'AER', category: 'accounting' }), []);
  assert.equal(selectedJournalKeys(config.journals, { category: 'accounting' }).length, 6);
});
test('过时或失败中文不冒充当前标题，完成才优先中文', () => {
  const paper = base()[0]; paper.title_zh = '旧中文标题';
  for (const status of ['pending', 'failed', 'outdated']) { paper.title_translation_status = status; assert.equal(paperTitle(paper), paper.title_original); }
  paper.title_translation_status = 'done'; assert.equal(paperTitle(paper), '旧中文标题');
});
test('DOI链接固定doi.org并编码查询字符，不使用任意来源URL', () => {
  for (const value of ['javascript:alert(1)', 'https://evil.test', '10.1234/x\n', '10.1234/<img>', '']) assert.equal(doiHref(value), null);
  assert.equal(doiHref('10.1234/a?x=1#f'), 'https://doi.org/10.1234/a%3Fx%3D1%23f');
});
test('跳转保留筛选与中文关键词，使用相对路径可放在仓库子路径', () => {
  const href = pageHref('day.html', { journal: 'AER', q: '信贷 & credit' }, { date: '2026-09-07' });
  const url = new URL(href, 'https://example.test/repository/index.html');
  assert.equal(url.pathname, '/repository/day.html'); assert.equal(url.searchParams.get('q'), '信贷 & credit');
  assert.equal(url.searchParams.get('date'), '2026-09-07');
});
const run = (patch = {}) => ({ run_date: '2026-09-07', started_at: checkedAt, status: 'success', journal_keys: ['AER'],
  sources: ['openalex', 'crossref'].map((source) => ({ source, journal_key: 'AER', ok: true, complete: true })), ...patch });
test('只采AER不能说全部19刊完成；无论文不意味着采集成功', () => {
  const all = config.journals.map((j) => j.key);
  assert.equal(coverageForDay([], '2026-09-07', all).label, '未采集');
  assert.equal(coverageForDay([run()], '2026-09-07', all).complete, 1);
  assert.equal(coverageForDay([run()], '2026-09-07', all).label, '仅部分期刊已采集');
  assert.equal(coverageForDay([run({ status: 'no_updates' })], '2026-09-07', ['AER']).label, '双源采集完成');
});
test('同日后一次失败覆盖先一次成功的显示，缺失来源不显示双源完成', () => {
  const failed = run({ started_at: '2026-09-07T02:00:00Z', status: 'full_failure' });
  assert.equal(coverageForDay([run(), failed], '2026-09-07', ['AER']).label, '采集不完整');
  assert.equal(coverageForDay([run({ sources: [] })], '2026-09-07', ['AER']).complete, 0);
  assert.equal(coverageForDay([run()], '2026-09-08', ['AER']).label, '未采集');
});
test('纯翻译版本时间不会替代最近采集时间', async (t) => {
  const { root } = await fixture(t), library = await readJournalLibrary({ root, config });
  const originalTime = library.runs[0].finished_at;
  const modified = structuredClone(library); modified.manifest.created_at = '2026-09-08T10:00:00Z';
  const data = presentJournalLibrary(modified, config);
  assert.equal(data.runs[0].finished_at, originalTime); assert.notEqual(data.snapshot_at, originalTime);
});
test('较新未提交失败显示提醒，不泄露错误正文且不修改旧库', async (t) => {
  const { root } = await fixture(t), before = await fs.readFile(path.join(root, 'current.json'), 'utf8');
  const runId = newRunId(new Date('2026-09-08T01:00:00Z'));
  await writeLibraryJson(root, `attempts/${runId}/started.json`, { run_id: runId, started_at: '2026-09-08T01:00:00Z' });
  await writeLibraryJson(root, `attempts/${runId}/failed.json`, { error: 'PRIVATE_TOKEN_AND_STACK' });
  const data = await loadJournalPresentation(config, { root });
  assert.equal(data.attempt_warning.status, 'uncommitted_failure'); assert.ok(!JSON.stringify(data).includes('PRIVATE_TOKEN'));
  assert.equal(await fs.readFile(path.join(root, 'current.json'), 'utf8'), before);
});
test('只有开始记录的采集标为待核查，不猜测仍在运行；跳过与翻译尝试不冒充采集', async (t) => {
  const { root } = await fixture(t), library = await readJournalLibrary({ root, config });
  const runId = newRunId(new Date('2026-09-08T01:00:00Z')), prefix = `attempts/${runId}`;
  await writeLibraryJson(root, `${prefix}/started.json`, { run_id: runId, started_at: '2026-09-08T01:00:00Z' });
  assert.equal((await latestAttemptWarning(root, library)).status, 'unconfirmed');
  await writeLibraryJson(root, `${prefix}/skipped.json`, { reason: 'already_covered_today' });
  assert.equal(await latestAttemptWarning(root, library), null);
  const translationId = newRunId(new Date('2026-09-09T01:00:00Z'));
  await writeLibraryJson(root, `attempts/${translationId}/started.json`, { operation: 'translation_import' });
  assert.equal(await latestAttemptWarning(root, library), null);
});
test('较早失败不盖住较新成功，诊断损坏时保留论文并提示无法核实', async (t) => {
  const { root } = await fixture(t), library = await readJournalLibrary({ root, config });
  const old = newRunId(new Date('2026-09-06T01:00:00Z'));
  await writeLibraryJson(root, `attempts/${old}/started.json`, { run_id: old, started_at: '2026-09-06T01:00:00Z' });
  assert.equal(await latestAttemptWarning(root, library), null);
  const invalid = newRunId(new Date('2026-09-09T01:00:00Z'));
  await writeLibraryJson(root, `attempts/${invalid}/started.json`, { private: 'secret' });
  const data = await loadJournalPresentation(config, { root });
  assert.equal(data.papers.length, 1); assert.equal(data.attempt_warning.status, 'unavailable');
});
test('只读HTTP入口返回新页面及数据，HEAD无正文，未初始化库不落盘', async (t) => {
  const { root, temp } = await fixture(t, false), { url } = await serve(t, { root });
  for (const route of ['/', '/index.html', '/day.html', '/app.js', '/viewModel.js', '/base.css', '/styles.css']) assert.equal((await request(url, route)).status, 200, route);
  const data = await request(url, '/data.json'); assert.equal(data.status, 200); assert.equal(JSON.parse(data.body).initialized, false);
  assert.equal(data.headers['cache-control'], 'no-store'); assert.equal(data.headers['x-content-type-options'], 'nosniff');
  assert.ok(data.headers['content-security-policy'].includes("script-src 'self'"));
  assert.equal((await request(url, '/', { method: 'HEAD' })).body, ''); assert.deepEqual(await fs.readdir(temp), []);
});
test('预览拒绝旧写API、目录穿越、密钥路径及任意文件', async (t) => {
  const { root } = await fixture(t, false), { url } = await serve(t, { root });
  for (const route of ['/api/digest/ensure-today', '/api/llm/config', '/.env', '/data/journal-store/current.json', '/src/server.js', '/..%2f.env', '/%2e%2e/.env', '/paper.html']) {
    assert.equal((await request(url, route)).status, 404, route);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await request(url, '/data.json', { method })).status, 405);
});
test('仅本机预览，拒绝外部Host和Origin，不开放跨域', async (t) => {
  const { root } = await fixture(t, false), { url } = await serve(t, { root });
  assert.equal((await request(url, '/data.json', { headers: { host: 'evil.test' } })).status, 403);
  assert.equal((await request(url, '/data.json', { headers: { origin: 'https://evil.test' } })).status, 403);
  const valid = await request(url, '/data.json', { headers: { origin: url } });
  assert.equal(valid.status, 200); assert.equal(valid.headers['access-control-allow-origin'], undefined);
});
test('数据损坏返回503而不是空库，不回显异常堆栈和敏感信息', async (t) => {
  const { url } = await serve(t, { loadData: async () => { throw new Error('PRIVATE_KEY G:/secret/file'); } });
  const response = await request(url, '/data.json');
  assert.equal(response.status, 503); assert.ok(!response.body.includes('PRIVATE_KEY')); assert.ok(!response.body.includes('G:/'));
  assert.ok(JSON.parse(response.body).error.includes('不代表没有论文'));
});
test('正式论文文件校验失败确实阻止网页数据输出，未改动损坏现场', async (t) => {
  const { root } = await fixture(t), library = await readJournalLibrary({ root, config });
  const file = path.join(root, library.manifest.papers['2026'].path), content = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, content + ' ');
  const { url } = await serve(t, { root });
  assert.equal((await request(url, '/data.json')).status, 503); assert.equal(await fs.readFile(file, 'utf8'), content + ' ');
});

test('发表日期按来源字符串精度显示，不把月份补成1日，也不擅自截短真实1日', () => {
  assert.equal(publicationDateText('', 'crossref'), '未提供');
  assert.equal(publicationDateText('2026', 'crossref'), '2026（Crossref；仅提供年份）');
  assert.equal(publicationDateText('2026-09', 'crossref'), '2026-09（Crossref；仅提供月份）');
  assert.equal(publicationDateText('2026-09-01', 'crossref'), '2026-09-01（Crossref；数据库标注日期，未逐篇核实到日）');
  assert.ok(publicationDateText('2024-02-29', 'openalex').startsWith('2024-02-29（OpenAlex'));
  assert.equal(publicationDateText('2026-02-29', 'crossref'), '日期无效，需核查');
  assert.ok(publicationDateText('2026-09-01').includes('来源未标明'));
});

test('日期来源只投影字段署名，不以采集来源列表猜测或泄露内部证据', async (t) => {
  const { root } = await fixture(t), library = await readJournalLibrary({ root, config });
  const before = structuredClone(library), presented = presentJournalLibrary(library, config).papers[0];
  assert.deepEqual(presented.date_sources, { published_online_date: null, published_print_date: null, publication_date: 'crossref' });
  assert.equal(presented.publication_date, '2026-08-01');
  assert.deepEqual(library, before);
  assert.equal(presented.source_records, undefined); assert.equal(presented.provenance, undefined);
});

test('作者中间首字母差异展示完整来源名单，不覆盖主记录或拼接作者身份', () => {
  const records = [record({ authors: [{ name: 'Benjamin A. Olken', orcid: '' }] }),
    record({ source: 'openalex', source_id: 'W123', authors: [{ name: 'Benjamin Olken', orcid: '0000-0001-1111-1111' }] })];
  const p = mergePapers(records, { firstSeenDate: '2026-09-07', checkedAt }).papers[0], before = structuredClone(p);
  assert.deepEqual(authorVariants(p), [{ sources: ['crossref'], names: ['Benjamin A. Olken'] },
    { sources: ['openalex'], names: ['Benjamin Olken'] }]);
  assert.deepEqual(p, before);
  assert.ok(!JSON.stringify(authorVariants(p)).includes('orcid'));
});

test('作者Unicode组合、连字符字形与大小写差异不制造虚假名单冲突', () => {
  const p = { source_records: [record({ authors: [{ name: 'Rüdiger Rossi-Hansberg', orcid: '' }] }),
    record({ source: 'openalex', source_id: 'W123', authors: [{ name: 'Ru\u0308diger Rossi\u2010Hansberg', orcid: '' }] })] };
  assert.deepEqual(authorVariants(p), []);
});

test('作者顺序、人数和重音的真实差异分别保留，不以姓名集合合并', () => {
  const make = (names, source = 'crossref') => record({ source, source_id: source === 'crossref' ? '10.1234/one' : 'W123', authors: names.map(name => ({ name, orcid: '' })) });
  for (const names of [['Bob', 'Alice'], ['Alice'], ['Álice', 'Bob']]) {
    const variants = authorVariants({ source_records: [make(['Alice', 'Bob']), make(names, 'openalex')] });
    assert.equal(variants.length, 2); assert.deepEqual(variants[1].names, names);
  }
});

test('作者对照复用合并的最新非空证据规则，旧拼写不冒充当前来源写法', () => {
  const p = { source_records: [record({ authors: [{ name: 'Alice Smith' }] }),
    record({ source: 'openalex', source_id: 'W123', authors: [{ name: 'Wrong Name' }], source_updated_at: '2026-09-06' }),
    record({ source: 'openalex', source_id: 'W123', authors: [{ name: 'Alice Smith' }], source_updated_at: '2026-09-07' }),
    record({ source: 'openalex', source_id: 'W123', authors: [], source_updated_at: '2026-09-08' })] };
  assert.deepEqual(authorVariants(p), []);
});

test('搜索可找到来源中的完整作者名，同时保留期刊和日期筛选', () => {
  const p = base()[0]; p.authors = [{ name: 'Benjamin Olken', orcid: '' }];
  p.author_variants = [{ sources: ['crossref'], names: ['Benjamin A. Olken'] }, { sources: ['openalex'], names: ['Benjamin Olken'] }];
  assert.equal(filterPapers([p], { q: 'Benjamin A. Olken', journal: 'AER', date: '2026-09-07' }).length, 1);
  assert.equal(filterPapers([p], { q: 'Benjamin A. Olken', journal: 'JAR' }).length, 0);
});
