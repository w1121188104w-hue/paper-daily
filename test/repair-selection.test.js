import test from 'node:test';
import assert from 'node:assert/strict';
import { dueRepairIssues } from '../src/services/repairState.js';
import { dueMetadataRepairIssues } from '../src/services/metadataRepairRun.js';

const now = new Date('2026-09-15T12:00:00.000Z');
const config = { journals: [{ key: 'AER', enabled: true }, { key: 'JAR', enabled: true }, { key: 'OFF', enabled: false }] };
const issue = (id, patch = {}) => ({ id, paper_id: `paper:${id}`, journal_key: 'AER', field: 'doi', reason: 'missing_doi',
  status: 'pending', attempt_count: 0, created_at: '2026-09-14T00:00:00.000Z', next_retry_at: null, ...patch });
const state = rows => ({ issues: Object.fromEntries(rows.map(row => [row.id, row])) });
const crowded = () => Array.from({ length: 10005 }, (_, i) => issue(`early:${String(i).padStart(5, '0')}`));

test('待办选择先筛选再限量：一万项之后的目标期刊和指定论文仍可执行', () => {
  const target = issue('late:jar', { journal_key: 'JAR', attempt_count: 1 });
  const queue = state([...crowded(), target]);
  const before = JSON.stringify(queue);
  assert.deepEqual(dueRepairIssues(queue, now, { limit: 1, filter: row => row.journal_key === 'JAR' }), [target]);
  assert.deepEqual(dueMetadataRepairIssues(config, queue, now, { journalKey: 'JAR' }), [target]);
  assert.deepEqual(dueMetadataRepairIssues(config, queue, now, { paperIds: [target.paper_id] }), [target]);
  assert.equal(JSON.stringify(queue), before);
});

test('按论文限量前保留全部到期字段：同篇摘要在一万项后也不会丢失', () => {
  const first = issue('first:identity', { paper_id: 'target', field: 'identity', reason: 'single_source_confirmation' });
  const last = issue('last:abstract', { paper_id: 'target', field: 'abstract', reason: 'missing_abstract', attempt_count: 2 });
  const due = dueMetadataRepairIssues(config, state([first, ...crowded(), last]), now);
  assert.equal(due.length, 10007);
  const selected = [...new Set(due.map(row => row.paper_id))].slice(0, 1);
  assert.deepEqual(selected, ['target']);
  assert.deepEqual(due.filter(row => selected.includes(row.paper_id)).map(row => row.field), ['identity', 'abstract']);
});

test('自动执行与复用检查共同排除未到期、已解决、停用期刊和未支持的问题', () => {
  const dueNow = issue('due', { next_retry_at: now.toISOString() });
  const typeDue = issue('type', { field: 'classification', reason: 'document_type_uncertain' });
  const queue = state([dueNow, issue('future', { next_retry_at: '2026-09-15T12:00:00.001Z' }),
    issue('resolved', { status: 'resolved' }), issue('disabled', { journal_key: 'OFF' }),
    issue('unknown', { journal_key: 'UNKNOWN' }), issue('duplicate', { field: 'identity', reason: 'possible_duplicate', next_retry_at: '2026-09-16T00:00:00.000Z' }),
    typeDue]);
  assert.deepEqual(dueMetadataRepairIssues(config, queue, now), [dueNow, typeDue]);
  assert.deepEqual(dueMetadataRepairIssues(config, queue, now, { journalKey: 'JAR' }), []);
});

test('待办排序和默认数量兼容，明确不限条数不取消执行器的论文批量限制', () => {
  const queue = state([issue('retry', { attempt_count: 1 }), issue('new:abstract', { field: 'abstract', reason: 'missing_abstract' }),
    issue('new:identity', { field: 'identity', reason: 'title_conflict' }), issue('new:doi')]);
  assert.deepEqual(dueRepairIssues(queue, now).map(row => row.id), ['new:identity', 'new:doi', 'new:abstract', 'retry']);
  assert.equal(dueRepairIssues(state(crowded()), now).length, 100);
  assert.equal(dueRepairIssues(state(crowded()), now, { limit: null }).length, 10005);
  assert.deepEqual(dueRepairIssues(queue, now, { limit: 0 }), []);
});

test('待办查询拒绝非法限量、筛选器和时钟', () => {
  for (const limit of [-1, 10001, 1.5, '100', NaN]) assert.throws(() => dueRepairIssues(state([]), now, { limit }));
  for (const filter of [null, false, 'AER']) assert.throws(() => dueRepairIssues(state([]), now, { filter }));
  assert.throws(() => dueRepairIssues(state([]), new Date('invalid')));
});
