import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { translationTaskId } from '../src/services/translationQueue.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { journalGitFiles } from '../src/services/journalGitFiles.js';
import { DEEPSEEK_MODEL } from '../src/services/deepseekTranslation.js';
import { AUTOMATION_LIMITS, readTranslationState, writeTranslationState, validateTranslationState,
  automationQueue, runTranslationAutomation } from '../src/services/translationAutomation.js';
import { makeTranslationPublisher, STATE_GIT_PATH } from '../src/services/translationAutomationGit.js';
import { runAutomaticTranslationCommand } from '../scripts/translate-library.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER');
const time = '2026-09-10T09:00:00.000Z', now = () => new Date(time);
const apiKey = 'test-only-secret-not-a-real-credential';
const zh = { title_zh: '信贷市场与企业投资', abstract_zh: '我们利用2001至2020年的数据研究企业投资。信贷供给对投资的影响幅度为2.5%。结果在不同企业和地区中均保持稳健。' };
const emptyState = () => ({ schema_version: 1, paused: null, reservations: [] });
function record(i, overrides = {}) {
  return normalizeSourceRecord({ source: 'crossref', source_id: `10.1234/auto${i}`, doi: `10.1234/auto${i}`,
    title: 'Credit markets and firm investment',
    abstract: 'We study firm investment using data from 2001 to 2020. Credit supply affects investment by 2.5 percent. The results remain robust across firms and regions.',
    authors: [{ name: 'Alice Smith', orcid: '' }], journal_key: 'AER', journal_name: journal.name,
    journal_category: journal.category, journal_category_zh: journal.category_zh,
    print_issn: journal.print_issn, electronic_issn: journal.electronic_issn,
    publication_date: '2026-09-01', last_checked_at: time, ...overrides });
}
function response(text = zh, overrides = {}, status = 200) {
  return new Response(JSON.stringify({ model: DEEPSEEK_MODEL,
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(text) } }],
    usage: { prompt_tokens: 300, completion_tokens: 70, total_tokens: 370 }, ...overrides }), { status });
}
async function fixture(t, rows = [record(0)]) {
  const parent = path.resolve(os.tmpdir()), temp = await fs.mkdtemp(path.join(parent, 'paper-auto-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)), parent); assert.ok(path.basename(temp).startsWith('paper-auto-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const repo = path.join(temp, 'repo'), root = path.join(repo, 'data', 'journal-store');
  const clients = Object.fromEntries(['crossref', 'openalex'].map((source) => [source, async (j) => {
    const records = source === 'crossref' ? rows : [];
    return { source, journal_key: j.key, ok: true, complete: true, raw_count: records.length, records,
      raw_pages: [{ fixture: true, items: records }], rejected: [], duration_ms: 0, error: null };
  }]));
  await runJournalCollection(config, { root, journalKey: 'AER', clients, now });
  await writeTranslationState(root, emptyState());
  return { temp, repo, root };
}
const run = (root, options = {}) => runTranslationAutomation(config,
  { root, apiKey, mode: 'backfill', now, fetchImpl: async () => response(), publishCheckpoint: async () => {}, ...options });

test('自动翻译：分批原样保存机器译文，远端登记先于收费；重跑不重复调用', async (t) => {
  const { root } = await fixture(t, Array.from({ length: 14 }, (_, i) => record(i)));
  const before = await readJournalLibrary({ root, config });
  let calls = 0, registered = 0, checkpoints = [];
  const result = await run(root, {
    publishCheckpoint: async ({ phase }) => { checkpoints.push(phase); if (phase === 'reserve') registered += (await readTranslationState(root)).reservations.at(-1).items.length; },
    fetchImpl: async () => { calls++; assert.ok(registered >= calls); return response(); }
  });
  assert.equal(calls, 14); assert.equal(result.completed_fields, 28); assert.equal(result.available_papers, 0);
  assert.deepEqual(checkpoints, ['reserve', 'settle', 'reserve', 'settle']);
  const after = await readJournalLibrary({ root, config });
  for (const paper of after.papers) {
    assert.equal(paper.title_zh, zh.title_zh); assert.equal(paper.abstract_zh, zh.abstract_zh);
    const old = before.papers.find((p) => p.id === paper.id);
    for (const key of ['title_original', 'abstract_original', 'doi', 'authors', 'publication_date', 'first_seen_date']) assert.deepEqual(paper[key], old[key]);
  }
  assert.equal((await run(root, { fetchImpl: async () => { throw new Error('repeat billing'); } })).requested_this_run, 0);
});

test('自动翻译：非 DOI 标识可登记；没有英文摘要时只翻标题，目录不处理', async (t) => {
  const { root } = await fixture(t, [record(0, { doi: '', source_id: 'external-record', abstract: '' }),
    record(1, { title: 'Table of contents', abstract: '' })]);
  let calls = 0;
  const result = await run(root, { fetchImpl: async (url, options) => {
    calls++; const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.deepEqual(input.requested_fields, ['title']); assert.equal(input.abstract_original, undefined);
    return response({ title_zh: zh.title_zh });
  } });
  assert.equal(calls, 1); assert.equal(result.completed_fields, 1);
  assert.ok((await readTranslationState(root)).reservations[0].items[0].id.startsWith('fp:'));
});

test('自动翻译：登记上传失败零调用；保存上传失败后预登记仍阻止重复计费', async (t) => {
  for (const failPhase of ['reserve', 'settle']) {
    const { root } = await fixture(t); let calls = 0, remoteState;
    await assert.rejects(run(root, {
      publishCheckpoint: async ({ phase }) => {
        if (phase === failPhase) throw new Error('upload failed');
        remoteState = structuredClone(await readTranslationState(root));
      }, fetchImpl: async () => { calls++; return response(); }
    }), /upload failed/);
    assert.equal(calls, failPhase === 'reserve' ? 0 : 1);
    if (remoteState) {
      // A fresh runner starts from the last remotely acknowledged reservation.
      const library = await readJournalLibrary({ root, config });
      for (const paper of library.papers) { paper.title_translation_status = 'pending'; paper.abstract_translation_status = 'pending'; }
      assert.equal(automationQueue(library, remoteState).available_papers, 0);
    }
    assert.equal((await run(root, { fetchImpl: async () => { throw new Error('repeat'); } })).requested_this_run, 0);
  }
});

for (const [status, expected] of [[401, 'AUTH_ERROR'], [402, 'INSUFFICIENT_BALANCE']]) {
  test(`自动翻译：HTTP ${status} 一次请求即暂停，未请求条目可辨认`, async (t) => {
    const { root } = await fixture(t, [record(0), record(1)]); let calls = 0;
    const result = await run(root, { fetchImpl: async () => { calls++; return response({}, {}, status); } });
    assert.equal(calls, 1); assert.equal(result.paused.code, expected); assert.equal(result.available_papers, 1);
    assert.equal((await readTranslationState(root)).reservations[0].items[1].status, 'unused');
    assert.equal((await run(root, { fetchImpl: async () => { throw new Error('repeat'); } })).requested_this_run, 0);
  });
}

test('自动翻译：网络失败不盲目重试，后续运行仅继续未调用论文', async (t) => {
  const { root } = await fixture(t, [record(0), record(1)]);
  const first = await run(root, { fetchImpl: async () => { throw new Error(apiKey); } });
  assert.equal(first.requested_this_run, 1); assert.equal(first.paused, null); assert.equal(first.held_fields, 2);
  const next = await run(root); assert.equal(next.requested_this_run, 1); assert.equal(next.completed_fields, 2);
  assert.equal(next.held_fields, 2); assert.ok(!JSON.stringify(await readTranslationState(root)).includes(apiKey));
});

test('自动翻译：连续三个格式错误熔断；不同模型的结果不落库', async (t) => {
  const { root } = await fixture(t, Array.from({ length: 5 }, (_, i) => record(i)));
  const bad = await run(root, { fetchImpl: async () => response({ unexpected: 'bad' }) });
  assert.equal(bad.requested_this_run, 3); assert.equal(bad.paused.code, 'REPEATED_INVALID_RESULTS');
  assert.equal(bad.completed_fields, 0); assert.equal(bad.available_papers, 2);
  const second = await fixture(t);
  const changed = await run(second.root, { fetchImpl: async () => response(zh, { model: 'deepseek-other' }) });
  assert.equal(changed.completed_fields, 0); assert.equal(changed.paused.code, 'UNEXPECTED_MODEL');
});

test('自动翻译：机械检查只拒绝失败字段，不改写、不重复翻译成功字段', async (t) => {
  const { root } = await fixture(t);
  const result = await run(root, { fetchImpl: async () => response({ ...zh, abstract_zh: zh.abstract_zh.replace('2.5', '很多') }) });
  assert.equal(result.completed_fields, 1); assert.equal(result.held_fields, 1); assert.equal(result.paused, null);
  const paper = (await readJournalLibrary({ root, config })).papers[0];
  assert.equal(paper.title_zh, zh.title_zh); assert.equal(paper.abstract_zh, '');
  assert.equal((await run(root)).requested_this_run, 0);
});

test('自动翻译：状态缺失、损坏、重复指纹、混入正文一律拒绝', async (t) => {
  const { root } = await fixture(t); await run(root);
  const state = await readTranslationState(root);
  for (const mutate of [s => { s.extra = apiKey; }, s => { s.reservations[0].items[0].tasks[0].source_hash = 'a'.repeat(64); },
    s => { const second = structuredClone(s.reservations[0]); second.id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; s.reservations.push(second); }]) {
    const bad = structuredClone(state); mutate(bad); assert.throws(() => validateTranslationState(bad));
  }
  await fs.rename(path.join(root, 'automation/translation-state.json'), path.join(root, 'automation/held.json'));
  await assert.rejects(run(root), { code: 'ENOENT' });
});

test('自动翻译：超大原文在收费前拒绝；运行时间和大批上限明确', async (t) => {
  assert.equal(AUTOMATION_LIMITS.backfill_requests, 1000); assert.equal(AUTOMATION_LIMITS.daily_requests, 500);
  const { root } = await fixture(t, [record(0, { abstract: 'A'.repeat(21000) })]);
  await assert.rejects(run(root, { fetchImpl: async () => { throw new Error('must not call'); } }), { code: 'INPUT_TOO_LARGE' });
  assert.equal((await readTranslationState(root)).reservations.length, 0);
  let tick = 0;
  const timed = await run(root, { now: () => new Date(Date.parse(time) + tick++ * 61 * 60000) });
  assert.equal(timed.stop_reason, 'TIME_LIMIT'); assert.equal(timed.requested_this_run, 0);
});

test('自动翻译命令：只读不读密钥；非已启用默认分支禁止调用', async (t) => {
  const { root } = await fixture(t), log = () => {};
  const secretTrap = new Proxy({}, { get() { throw new Error('secret read'); } });
  for (const args of [[], ['--status']]) assert.equal(await runAutomaticTranslationCommand(args, { root, env: secretTrap, log }), 0);
  for (const env of [{}, { GITHUB_ACTIONS: 'true', JOURNAL_TRANSLATION_ENABLED: 'false' },
    { GITHUB_ACTIONS: 'true', JOURNAL_TRANSLATION_ENABLED: 'true', GITHUB_REF: 'refs/heads/wrong', DATA_BRANCH: 'master' }]) {
    await assert.rejects(runAutomaticTranslationCommand(['--run', '--mode', 'backfill', '--github-output'], { root, env, log,
      execute: async () => { throw new Error('must not execute'); } }), /默认分支/);
  }
});

test('自动翻译：两个每日时段共用500次上限，次日未请求论文正常继续', async (t) => {
  const { root } = await fixture(t, [record(0), record(1)]);
  const state = emptyState(), sourceHash = 'a'.repeat(64);
  for (let batch = 0; batch < 50; batch++) {
    state.reservations.push({ id: randomUUID(), batch_id: `batch-${'b'.repeat(64)}`, mode: 'daily',
      created_at: time, finished_at: time, items: Array.from({ length: batch === 49 ? 9 : 10 }, (_, i) => {
        const id = `doi:10.1234/history-${batch}-${i}`;
        return { id, tasks: [{ field: 'title', source_hash: sourceHash, task_id: translationTaskId(id, 'title', sourceHash) }],
          status: 'failed', code: 'INVALID_JSON', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, completed_fields: [] };
      }) });
  }
  await writeTranslationState(root, state);
  const lastSlot = await run(root, { mode: 'daily' });
  assert.equal(lastSlot.requested_this_run, 1); assert.equal(lastSlot.stop_reason, 'REQUEST_LIMIT');
  const sameDay = await run(root, { mode: 'daily' }); assert.equal(sameDay.requested_this_run, 0);
  const nextDay = await run(root, { mode: 'daily', now: () => new Date('2026-09-11T01:00:00Z') });
  assert.equal(nextDay.requested_this_run, 1); assert.equal(nextDay.available_papers, 0);
});

test('自动翻译真实 Git 测试：收费前远端已有登记，结算后只上传正式资料', async (t) => {
  const { root, repo, temp } = await fixture(t);
  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const remote = path.join(temp, 'remote.git'); git(['init', '--bare', remote], temp); git(['init', '-b', 'master']);
  await fs.writeFile(path.join(repo, '.gitignore'), 'data/\n');
  await fs.writeFile(path.join(repo, '.gitattributes'), 'data/journal-store/** -text\n');
  await fs.writeFile(path.join(root, 'private-draft.json'), JSON.stringify({ secret: apiKey, draft: 'never publish' }));
  const plan = await journalGitFiles(config, { root, repositoryRoot: repo });
  git(['add', '.gitignore', '.gitattributes']); git(['add', '-f', '--', ...plan.files, STATE_GIT_PATH]);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'seed']);
  git(['remote', 'add', 'origin', remote]); git(['push', 'origin', 'master']);
  const publisher = makeTranslationPublisher(config, { root, repositoryRoot: repo, branch: 'master', env: { ...process.env, DEEPSEEK_API_KEY: apiKey } });
  await run(root, { publishCheckpoint: publisher, fetchImpl: async () => {
    const remoteState = JSON.parse(git(['show', `master:${STATE_GIT_PATH}`], remote));
    assert.equal(remoteState.reservations[0].items[0].status, 'reserved'); return response();
  } });
  const finalState = JSON.parse(git(['show', `master:${STATE_GIT_PATH}`], remote));
  assert.equal(finalState.reservations[0].items[0].status, 'succeeded');
  const tracked = git(['ls-tree', '-r', '--name-only', 'master'], remote);
  assert.ok(!tracked.includes('private-draft')); assert.ok(!tracked.includes('translations/batches'));
  assert.equal(git(['status', '--porcelain']).trim(), '');
});

test('自动翻译工作流：只把密钥交给翻译步骤；手动补库和每日共享生产锁', async () => {
  const manual = JSON.parse(await fs.readFile(new URL('../.github/workflows/translate-library.yml', import.meta.url), 'utf8'));
  const daily = JSON.parse(await fs.readFile(new URL('../.github/workflows/daily-collect.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manual.on), ['workflow_dispatch']);
  assert.equal(manual.concurrency.group, daily.concurrency.group);
  for (const workflow of [manual, daily]) {
    assert.equal(JSON.stringify(workflow).split('secrets.DEEPSEEK_API_KEY').length - 1, 1);
    assert.ok(workflow.jobs.report_translation_attention.needs.includes('deploy'));
    assert.ok(JSON.stringify(workflow).includes('JOURNAL_TRANSLATION_ENABLED'));
  }
});
