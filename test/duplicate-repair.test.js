import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { buildMasterList, possibleDuplicatePeers } from '../src/services/masterList.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { readJournalLibrary, writeLibraryJson, publishLibrarySnapshot, withLibraryLock } from '../src/services/journalLibrary.js';
import { recordRepairAttempt } from '../src/services/repairState.js';
import { runMetadataRepair } from '../src/services/metadataRepairRun.js';
import { repairPaperMetadata } from '../src/services/searchMetadata.js';
import { runMasterCommand } from '../scripts/master-list.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER');
const at = '2026-09-16T01:00:00.000Z', later = '2026-09-16T02:00:00.000Z';
const title = 'Financial markets and the allocation of resources';
const abstract = 'We study resource allocation and firm investment using detailed panel data, and identify substantial differences across financial markets.';
function record(n, source = n === 1 ? 'crossref' : 'openalex', date = '2026-08', patch = {}) {
  const doi = `10.1257/duplicate${n}`;
  return normalizeSourceRecord({ source, source_id: source === 'crossref' ? doi : `W100${n}`, doi, title, abstract,
    authors: [n === 1 ? 'Alice Smith' : 'Bob Jones'], publication_date: date, journal_key: journal.key,
    journal_name: journal.name, journal_category: journal.category, journal_category_zh: journal.category_zh,
    print_issn: journal.print_issn, electronic_issn: journal.electronic_issn, type: 'journal-article', last_checked_at: at, ...patch });
}
const rowsToPapers = rows => mergePapers(rows, { checkedAt: at, firstSeenDate: '2026-09-16' }).papers;
const absent = async () => { throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' }); };
const sources = patch => ({ crossref: absent, openalex: absent, semanticscholar: absent, publisherArticle: absent, ...patch });
function response(n = 2, date = '2025-08', patch = {}) {
  const url = `https://api.crossref.org/works/10.1257%2Fduplicate${n}`;
  return record(n, 'crossref', date, { last_checked_at: later,
    source_evidence: { url, scope_url: url, fetched_at: later, body_sha256: 'a'.repeat(64), method: 'crossref_api' }, ...patch });
}
async function stored(t, secondDate = '2026-08', secondPatch = {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'duplicate-repair-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('duplicate-repair-')); await fs.rm(root, { recursive: true, force: true }); });
  const clients = Object.fromEntries(['crossref', 'openalex'].map((source, i) => [source, async () => ({ source, journal_key: 'AER',
    records: [record(i + 1, source, i ? secondDate : '2026-08', i ? secondPatch : {})], ok: true, complete: true, raw_count: 1,
    raw_pages: [], rejected: [], duration_ms: 0, error: null })]));
  await runJournalCollection(config, { root, journalKey: 'AER', now: () => new Date(at), clients });
  const before = await readJournalLibrary({ root, config });
  return { root, before, target: before.papers.find(p => p.source_records.some(r => r.source === 'openalex')) };
}

test('疑似重复的自动执行范围与总名册一致：同刊规范标题和相交年份，缺年份不武断排除', () => {
  const papers = rowsToPapers([record(1), record(2, 'openalex', '', { title: 'FINANCIAL MARKETS: AND THE ALLOCATION OF RESOURCES' }), record(3, 'crossref', '2025-08')]);
  const master = buildMasterList(papers, { generatedAt: at, policyVersion: 4 });
  for (const paper of papers) assert.equal(possibleDuplicatePeers(paper, papers).length > 0,
    master.entries.find(row => row.id === paper.id).conflicts.includes('possible_duplicate'));
  assert.deepEqual(possibleDuplicatePeers(papers[0], [papers[0]]), []);
});

test('日期缺失造成的重复误报可自动排除，两篇均保留且不改原文、译文和发现时间', async t => {
  const { root, before, target } = await stored(t, ''); let lookups = 0;
  const result = await runMetadataRepair(config, { root, paperIds: [target.id], now: () => new Date(later),
    sources: sources({ crossref: async () => { lookups++; return response(); } }), search: () => assert.fail('Years now distinguish records') });
  assert.equal(result.status, 'success'); assert.equal(lookups, 1);
  assert.deepEqual(result.report.repairs[0].duplicate_candidates, []);
  const saved = await readJournalLibrary({ root, config });
  assert.equal(saved.papers.length, 2);
  assert.ok(saved.masterList.entries.every(row => !row.conflicts.includes('possible_duplicate')));
  assert.ok(Object.values(saved.repairState.issues).filter(row => row.reason === 'possible_duplicate').every(row => row.status === 'resolved'));
  for (const old of before.papers) {
    const current = saved.papers.find(row => row.id === old.id);
    for (const field of ['id', 'doi', 'title_original', 'abstract_original', 'title_zh', 'abstract_zh', 'discovered_at']) assert.equal(current[field], old[field]);
  }
  assert.equal((await runMetadataRepair(config, { root, paperIds: [target.id], now: () => new Date(later), sources: sources(), search: () => assert.fail('No repeat') })).status, 'skipped');
});

test('即使基础字段齐全，疑似重复仍查询三源和搜索，不会把未处理身份问题报告成功', async t => {
  const { root, target } = await stored(t), calls = [];
  const result = await runMetadataRepair(config, { root, paperIds: [target.id], now: () => new Date(later),
    sources: sources(Object.fromEntries(['crossref', 'openalex', 'semanticscholar'].map(source => [source, async () => { calls.push(source); return absent(); }]))),
    search: async ({ provider }) => { calls.push(provider); return { called: true, result: { leads: [] } }; } });
  assert.equal(result.status, 'partial');
  assert.deepEqual(calls, ['crossref', 'openalex', 'semanticscholar', 'zhipu', 'serpapi_scholar', 'serpapi_google']);
  assert.deepEqual(result.report.repairs[0].missing_fields, ['identity']);
  assert.equal(result.report.repairs[0].duplicate_candidates.length, 1);
  const saved = await readJournalLibrary({ root, config });
  const issue = Object.values(saved.repairState.issues).find(row => row.paper_id === target.id && row.reason === 'possible_duplicate');
  assert.equal(issue.status, 'identity_conflict'); assert.equal(issue.attempt_count, 1); assert.ok(issue.next_retry_at);
  let exported;
  await runMasterCommand(['--unresolved'], { read: async () => saved, log: text => { exported = JSON.parse(text); } });
  const related = exported.issues.find(row => row.paper_id === target.id).last_repair.duplicate_candidates;
  assert.equal(related.length, 1); assert.equal(related[0].doi, '10.1257/duplicate1'); assert.equal(related[0].authors[0].name, 'Alice Smith');
  assert.equal(saved.papers.length, 2);
});

test('可合并证据持久化进报告，但未执行归并前不能关闭重复待办或删除旧记录', async t => {
  const { root, before, target } = await stored(t, '2026-08', { doi: '', authors: [] });
  const url = 'https://api.openalex.org/works/https://doi.org/10.1257%2Fduplicate1';
  const evidence = record(2, 'openalex', '2026-08', { doi: '10.1257/duplicate1', authors: ['Alice Smith'], last_checked_at: later,
    source_evidence: { url, scope_url: url, method: 'openalex_api', fetched_at: later, body_sha256: 'a'.repeat(64) } });
  const result = await runMetadataRepair(config, { root, paperIds: [target.id], now: () => new Date(later),
    sources: sources({ crossref: async () => response(1, '2026-08'), openalex: async () => evidence }), search: () => assert.fail('Merge evidence obtained') });
  assert.equal(result.status, 'partial'); assert.equal(result.report.repairs[0].status, 'merge_ready');
  const saved = await readJournalLibrary({ root, config });
  assert.equal(saved.papers.length, 2); assert.deepEqual(saved.papers, before.papers);
  assert.equal(saved.enrichmentReports.at(-1).repairs[0].duplicate_claims.length, 1);
  assert.equal(saved.enrichmentReports.at(-1).repairs[0].duplicate_claims[0].record.source_id, 'W1002');
  assert.notEqual(Object.values(saved.repairState.issues).find(row => row.paper_id === target.id && row.reason === 'possible_duplicate').status, 'resolved');
});

test('疑似重复遇免费额度耗尽保存真实重置时间，不冒充已查无结果', async t => {
  const { root, target } = await stored(t), reset = '2026-10-13T00:00:00.000Z';
  await runMetadataRepair(config, { root, paperIds: [target.id], now: () => new Date(later), sources: sources(), quotaResetsAt: reset,
    search: async ({ provider }) => provider === 'zhipu' ? { called: true, result: { leads: [] } } : { called: false, reason: 'quota_exhausted' } });
  const saved = await readJournalLibrary({ root, config });
  const issue = Object.values(saved.repairState.issues).find(row => row.paper_id === target.id && row.reason === 'possible_duplicate');
  assert.equal(issue.status, 'quota_exhausted'); assert.equal(issue.next_retry_at, reset);
});

test('同属identity字段的任务各自保留冷却：核实单源不能给未到期的重复任务增加失败次数', async t => {
  const { root, before, target } = await stored(t);
  const duplicate = Object.values(before.repairState.issues).find(row => row.paper_id === target.id && row.reason === 'possible_duplicate');
  const repairState = recordRepairAttempt(before.repairState, duplicate.id, { source: 'crossref', status: 'identity_conflict', checkedAt: at });
  const stats = { added: 0, abstracts_filled: 0, abstracts_checked: 0, pending_candidates: 0 };
  const log = { schema_version: 1, run_id: '20260916-duplicate-cooldown-fixture', kind: 'missing_metadata_repair',
    run_date: '2026-09-16', started_at: at, finished_at: at, from_date: before.masterList.from_date,
    to_date: before.masterList.to_date, status: 'partial', stats };
  const report = { schema_version: 1, run_id: log.run_id, stage: 'missing_metadata_repair', status: log.status,
    from_date: log.from_date, to_date: log.to_date, stats, journals: [], abstracts: [], repairs: [] };
  await withLibraryLock(root, async () => {
    log.report = await writeLibraryJson(root, `snapshots/${log.run_id}/enrichment-report.json`, report);
    await publishLibrarySnapshot({ root, config, previous: before, papers: before.papers, repairState, enrichment: log,
      audit: { duplicates: [], excluded: [], notices: [] } });
  });
  const result = await runMetadataRepair(config, { root, paperIds: [target.id], now: () => new Date(later),
    sources: sources({ crossref: async () => response(2, '2026-08') }), search: () => assert.fail('Single-source confirmation finished') });
  assert.equal(result.status, 'success');
  const saved = await readJournalLibrary({ root, config });
  assert.deepEqual(saved.repairState.issues[duplicate.id], repairState.issues[duplicate.id]);
  assert.equal(Object.values(saved.repairState.issues).find(row => row.paper_id === target.id && row.reason === 'single_source_confirmation').status, 'resolved');
});

test('补到已属于另一篇的DOI时保留两条身份与译文，不靠覆盖或删除完成去重', async () => {
  const papers = rowsToPapers([record(1), record(2, 'openalex', '2026-08', { doi: '' })]), original = structuredClone(papers);
  const target = papers.find(p => !p.doi);
  const result = await repairPaperMetadata(target, journal, { fields: ['identity'], checkPossibleDuplicate: true, otherPapers: papers,
    sources: sources({ crossref: async () => response(1, '2026-08', { authors: ['Bob Jones'] }) }), search: async () => ({ called: true, result: { leads: [] } }) });
  assert.equal(result.status, 'not_found'); assert.deepEqual(result.missing_fields, ['identity']);
  assert.ok(result.attempts.some(a => a.status === 'DOI_ALREADY_ASSIGNED'));
  assert.deepEqual(result.paper, target); assert.deepEqual(papers, original);
});
