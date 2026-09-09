import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJournalConfig } from '../src/services/journals.js';
import { journalUiFixture } from '../scripts/qa/journal-ui-fixture.js';
import { createJournalUiQaServer } from '../scripts/qa/journal-ui-server.js';
import { filterPapers, countsByDay } from '../public/journals/viewModel.js';

test('隔离浏览器材料覆盖19刊、分页、双语状态及日期，不冒充真实论文', async () => {
  const fixture = journalUiFixture(await loadJournalConfig(), new Date('2026-09-07T17:00:00Z'));
  assert.equal(fixture.papers.length, 25);
  assert.equal(new Set(fixture.papers.map((paper) => paper.journal_key)).size, 19);
  assert.deepEqual(countsByDay(fixture.papers), { '2026-09-07': 5, '2026-09-08': 20 });
  assert.equal(filterPapers(fixture.papers, { q: '信贷' }).length, 15);
  assert.equal(filterPapers(fixture.papers, { journal: 'AER', q: 'credit Alice' }).length, 3);
  assert.equal(filterPapers(fixture.papers, { category: 'accounting' }).length, 10);
  assert.equal(fixture.pending.paper_count, 20); assert.equal(fixture.pending.field_count, 35);
  for (const paper of fixture.papers) {
    assert.ok(paper.id.startsWith('ui-test:')); assert.ok(paper.title_original.startsWith('[UI TEST]'));
    assert.ok(!paper.title_zh || paper.title_zh.startsWith('【验收测试】'));
    assert.ok(!paper.abstract_original || paper.abstract_original.includes('not a real paper'));
  }
  assert.ok(fixture.papers.some((paper) => paper.title_original.includes('<img')));
  assert.ok(fixture.papers.some((paper) => paper.authors.length === 9));
});

async function qaServer(t) {
  const qa = await createJournalUiQaServer();
  assert.equal(qa.server.listening, false);
  await new Promise((resolve, reject) => {
    qa.server.once('error', reject); qa.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    qa.server.closeAllConnections(); await new Promise((resolve) => qa.server.close(resolve));
  });
  return { ...qa, origin: `http://127.0.0.1:${qa.server.address().port}` };
}

test('隔离验收服务器仅提供白名单资源和只读请求，页面醒目标注虚构材料', async (t) => {
  const qa = await qaServer(t); qa.setScenario('fixture');
  const response = await fetch(`${qa.origin}/`), html = await response.text();
  assert.equal(response.status, 200); assert.ok(html.includes('隔离验收环境'));
  assert.ok(html.includes('论文均为虚构测试材料，不进入正式论文库'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${qa.origin}/data/config/journals.json`)).status, 404);
  assert.equal((await fetch(`${qa.origin}/data.json`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${qa.origin}/data.json`, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.throws(() => qa.setScenario('collect'), /Invalid QA scenario/);
});

test('验收故障、空库和未确认状态可恢复，且不修改内存中的原始测试材料', async (t) => {
  const qa = await qaServer(t);
  qa.setScenario('failure'); assert.equal((await fetch(`${qa.origin}/data.json`)).status, 503);
  qa.setScenario('empty');
  const empty = await (await fetch(`${qa.origin}/data.json`)).json();
  assert.equal(empty.initialized, false); assert.deepEqual(empty.papers, []);
  qa.setScenario('unconfirmed');
  const warning = await (await fetch(`${qa.origin}/data.json`)).json();
  assert.equal(warning.attempt_warning.status, 'unconfirmed');
  qa.setScenario('fixture');
  const restored = await (await fetch(`${qa.origin}/data.json`)).json();
  assert.equal(restored.papers.length, 25); assert.equal(restored.attempt_warning, null);
  assert.equal(qa.fixture.papers.length, 25); assert.equal(qa.fixture.attempt_warning, null);
});
