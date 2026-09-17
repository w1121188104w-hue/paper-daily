import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { runMetadataRepair } from '../src/services/metadataRepairRun.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { presentJournalLibrary } from '../src/services/journalPresentation.js';
import { publicationMonthText, filterPapers, countsByDay } from '../public/journals/viewModel.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER'), at = '2026-09-15T01:00:00.000Z';
const updatedAt = '2026-09-15T01:01:00.000Z', doi = '10.1257/month';
const abstract = 'We examine investment responses to financial constraints using detailed firm records and identify persistent effects on capital allocation.';
function row(source = 'crossref', date = '2026-08-01', patch = {}) {
  return normalizeSourceRecord({ source, source_id: source === 'crossref' ? doi : 'W1234', doi,
    title: 'Investment responses to financial market conditions', abstract, authors: ['Alice Smith'],
    publication_date: date, journal_key: journal.key, journal_name: journal.name, journal_category: journal.category,
    journal_category_zh: journal.category_zh, print_issn: journal.print_issn, electronic_issn: journal.electronic_issn,
    type: 'journal-article', last_checked_at: at, ...patch });
}
async function stored(t, records = [row(), row('openalex', '2026-09-01')]) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'publication-month-test-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('publication-month-test-')); await fs.rm(root, { recursive: true, force: true }); });
  const clients = Object.fromEntries(['crossref', 'openalex'].map(source => [source, async () => ({ source, journal_key: journal.key,
    records: records.filter(r => r.source === source), ok: true, complete: true, raw_count: records.filter(r => r.source === source).length,
    raw_pages: [], rejected: [], duration_ms: 0, error: null })]));
  await runJournalCollection(config, { root, journalKey: journal.key, now: () => new Date(at), clients });
  return { root, library: await readJournalLibrary({ root, config }) };
}
const absent = async () => { throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' }); };
const sources = patch => ({ crossref: absent, openalex: absent, semanticscholar: absent, publisherArticle: absent, ...patch });

test('只提供年份时月份为null，展示和搜索年份，不编造1月或具体日期', async t => {
  const { library } = await stored(t, [row('crossref', '2026')]), before = structuredClone(library);
  const paper = presentJournalLibrary(library, config).papers[0];
  assert.equal(paper.publication_year, 2026); assert.equal(paper.publication_month, null);
  assert.equal(publicationMonthText(paper), '2026（月份待补全）');
  assert.equal(paper.publication_date, '2026');
  assert.equal(filterPapers([paper], { q: '2026' }).length, 1);
  assert.deepEqual(library, before);
});

test('来源按日提供的时间公开展示到月，首次发现日期和历史原始日期不截短', async t => {
  const { library } = await stored(t, [row()]), before = structuredClone(library), paper = presentJournalLibrary(library, config).papers[0];
  assert.equal(paper.publication_month, '2026-08'); assert.equal(paper.publication_date, '2026-08');
  assert.equal(paper.publication_month_source, 'crossref');
  assert.match(publicationMonthText(paper), /^2026-08（Crossref；来源通用发表时间）$/);
  assert.equal(paper.first_seen_date, '2026-09-15'); assert.deepEqual(countsByDay([paper]), { '2026-09-15': 1 });
  assert.equal(library.papers[0].source_records[0].publication_date, '2026-08-01');
  assert.deepEqual(library, before);
});

test('月份冲突公开为待核实，不展示任意一方旧值，论文仍保留且进入自动待办', async t => {
  const { library } = await stored(t), paper = presentJournalLibrary(library, config).papers[0];
  assert.equal(paper.publication_month, null); assert.equal(paper.publication_conflict, true);
  assert.equal(paper.publication_date, ''); assert.equal(paper.publication_month_source, null);
  assert.deepEqual(paper.date_conflicts, ['publication_date']);
  assert.equal(publicationMonthText(paper), '待自动核实（来源月份有冲突）');
  assert.ok(Object.values(library.repairState.issues).some(i => i.reason === 'publication_month_conflict'));
});

test('来源后来更正月份：自动修复并关闭两项待办，页面依据新证据而非旧规范字段', async t => {
  const { root, library } = await stored(t), canonical = library.papers[0].publication_date;
  const url = 'https://api.crossref.org/works/10.1257%2Fmonth';
  const repaired = await runMetadataRepair(config, { root, now: () => new Date(updatedAt), sources: sources({ crossref: async () =>
    row('crossref', '2026-09-01', { last_checked_at: updatedAt, source_evidence: { url, scope_url: url,
      fetched_at: updatedAt, body_sha256: 'a'.repeat(64), method: 'crossref_api' } }) }), search: () => assert.fail('Already resolved by source correction') });
  assert.equal(repaired.status, 'success'); assert.equal(repaired.report.repairs.length, 1);
  assert.deepEqual(repaired.report.repairs[0].requested_fields, ['publication_month']);
  const saved = await readJournalLibrary({ root, config }), paper = presentJournalLibrary(saved, config).papers[0];
  assert.equal(saved.papers[0].publication_date, canonical);
  assert.equal(saved.masterList.entries[0].publication_month, '2026-09');
  assert.equal(paper.publication_month, '2026-09'); assert.equal(paper.publication_date, '2026-09');
  assert.deepEqual(paper.date_conflicts, []);
  assert.ok(Object.values(saved.repairState.issues).every(i => i.status === 'resolved'));
  assert.equal((await runMetadataRepair(config, { root, now: () => new Date(updatedAt), sources: sources(), search: () => assert.fail() })).status, 'skipped');
});

test('刷新仍冲突就搜索兜底，同篇月份缺失与冲突共用一次查询，失败状态有冷却', async t => {
  const { root } = await stored(t), calls = [];
  const result = await runMetadataRepair(config, { root, now: () => new Date(updatedAt),
    sources: sources(Object.fromEntries(['crossref', 'openalex', 'semanticscholar'].map(source => [source, async () => { calls.push(source); return absent(); }]))),
    search: async ({ provider }) => { calls.push(provider); return { called: true, result: { leads: [] } }; } });
  assert.equal(result.status, 'partial');
  assert.deepEqual(calls, ['crossref', 'openalex', 'semanticscholar', 'zhipu', 'serpapi_scholar', 'serpapi_google']);
  const saved = await readJournalLibrary({ root, config }), issues = Object.values(saved.repairState.issues);
  assert.equal(issues.length, 2);
  assert.ok(issues.every(i => i.status === 'identity_conflict' && i.attempt_count === 1 && i.next_retry_at));
  assert.equal((await runMetadataRepair(config, { root, now: () => new Date(updatedAt), sources: sources(), search: () => assert.fail() })).status, 'skipped');
});
