import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMasterArgs, runMasterCommand } from '../scripts/master-list.js';

const at = '2026-09-15T01:00:00.000Z';
function issue(i, patch = {}) { return { id: `issue:${i.toString(16).padStart(64, '0')}`, paper_id: 'paper-one', journal_key: 'AER',
  field: 'abstract', reason: 'missing_abstract', status: 'pending', attempt_count: 0, attempts: [], next_retry_at: null, ...patch }; }
function library(issues = [issue(1)]) {
  return { pointer: { manifest: { sha256: 'a'.repeat(64) } }, repairState: { issues: Object.fromEntries(issues.map(i => [i.id, i])) },
    papers: [{ id: 'paper-one', source_records: [{ source: 'crossref', source_id: '10.1257/example',
      url: 'https://doi.org/10.1257/example', raw_abstract: 'DO_NOT_EXPORT_RAW',
      source_evidence: { url: 'https://api.crossref.org/works/10.1257%2Fexample', method: 'crossref_api', fetched_at: at, body_sha256: 'b'.repeat(64), extra: 'DO_NOT_EXPORT_EVIDENCE_EXTRA' } },
      { source: 'publisher', source_id: 'unsafe', url: 'https://example.com/?api_key=DO_NOT_EXPORT_KEY' }] }],
    masterList: { entries: [{ id: 'paper-one', title: 'Investment and economic growth', doi: '10.1257/example',
      authors: [{ name: 'Alice Smith', orcid: '' }], journal_name: 'American Economic Review', publication_year: 2026,
      publication_month: '2026-09', discovery_sources: ['crossref'], missing_fields: ['abstract'], conflicts: [], abstract: 'DO_NOT_EXPORT_ABSTRACT' }] },
    enrichmentState: { catalog_search: {} }, enrichments: [{ run_id: '20260915-new', finished_at: at }],
    enrichmentReports: [{ run_id: '20260915-new', journals: [], repairs: [{ paper_id: 'paper-one', status: 'not_found',
      changed_fields: [], missing_fields: ['abstract'], requested_fields: ['abstract'], private_marker: 'DO_NOT_EXPORT_REPAIR',
      attempts: [{ source: 'zhipu', status: 'not_found', stage: 'original_page_verification', called: true,
        leads_returned: 3, leads_checked: 3, lead_statuses: { ACCESS_RESTRICTED: 3 }, body: 'DO_NOT_EXPORT_BODY' }] }] },
      { run_id: '20260914-old', journals: [], repairs: [{ paper_id: 'paper-one', status: 'source_unavailable', attempts: [] }] }] };
}
async function output(args, lib, patch = {}) {
  let result;
  await runMasterCommand(args, { read: async () => lib, now: () => new Date(at), log: text => { result = JSON.parse(text); }, ...patch });
  return result;
}

test('待办导出提供作者月份、可靠证据链接和最新来源尝试，不输出原始响应或密钥参数', async () => {
  const lib = library(), before = structuredClone(lib), result = await output(['--unresolved'], lib), row = result.issues[0];
  assert.equal(result.schema_version, 2); assert.equal(result.snapshot_sha256, 'a'.repeat(64));
  assert.equal(row.title, 'Investment and economic growth'); assert.equal(row.authors[0].name, 'Alice Smith');
  assert.equal(row.publication_month, '2026-09'); assert.equal(row.evidence_sources.length, 1);
  assert.equal(row.last_repair.run_id, '20260915-new'); assert.equal(row.last_repair.checked_at, at);
  assert.equal(row.last_repair.attempts[0].leads_checked, 3);
  assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT'), false);
  assert.deepEqual(lib, before); assert.equal(result.manual_review_required, false);
});

test('超过一万项也可按期刊完整分页，明确总量、页长和是否还有下一页', async () => {
  const lib = library(Array.from({ length: 10008 }, (_, i) => issue(i, { journal_key: i < 3 ? 'JAR' : 'AER' })));
  const first = await output(['--unresolved', '--due', '--journal', 'AER', '--limit', '3', '--offset', '10000'], lib);
  assert.equal(first.issue_count, 10005); assert.equal(first.returned_issue_count, 3); assert.equal(first.has_more, true);
  assert.ok(first.issues.every(i => i.journal_key === 'AER'));
  const last = await output(['--unresolved', '--due', '--journal', 'AER', '--limit', '3', '--offset', '10003'], lib);
  assert.equal(last.returned_issue_count, 2); assert.equal(last.has_more, false);
  assert.equal(new Set([...first.issues, ...last.issues].map(i => i.id)).size, 5);
  assert.equal(first.snapshot_sha256, last.snapshot_sha256);
  const empty = await output(['--unresolved', '--journal', 'AER', '--offset', '10005'], lib);
  assert.equal(empty.issue_count, 10005); assert.equal(empty.returned_issue_count, 0); assert.equal(empty.has_more, false);
});

test('到期筛选固定在同一时刻，跨页可冻结查询时间，排除未到期和已解决记录', async () => {
  const lib = library([issue(1), issue(2, { status: 'resolved' }), issue(3, { next_retry_at: '2026-09-16T00:00:00.000Z' })]);
  let clocks = 0;
  const result = await output(['--unresolved', '--due'], lib, { now: () => { clocks++; return new Date(at); } });
  assert.equal(result.issue_count, 1); assert.equal(clocks, 1);
  const later = await output(['--unresolved', '--due', '--as-of', result.query_at], lib,
    { now: () => new Date('2026-09-17T00:00:00.000Z') });
  assert.equal(later.issue_count, 1); assert.equal(later.query_at, result.query_at);
  assert.notEqual(later.exported_at, result.exported_at);
  await assert.rejects(output(['--unresolved', '--due'], lib, { now: () => new Date('invalid') }));
});

test('分页参数只允许待办模式，非法或越界参数在读取前拒绝', async () => {
  for (const args of [['--status', '--limit', '1'], ['--unresolved', '--limit', '0'], ['--unresolved', '--limit', '1001'],
    ['--unresolved', '--offset', '-1'], ['--unresolved', '--offset', '9007199254740992'], ['--unresolved', '--limit', '1.5'],
    ['--unresolved', '--offset', ''], ['--unresolved', '--as-of', 'yesterday'], ['--status', '--as-of', at]]) {
    assert.throws(() => parseMasterArgs(args));
    await assert.rejects(runMasterCommand(args, { read: () => assert.fail('Must reject before reading') }));
  }
});
