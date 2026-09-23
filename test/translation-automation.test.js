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
import { AUTOMATION_LIMITS, TRANSLATION_RETRY, readTranslationState, writeTranslationState, validateTranslationState,
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

test('插件发布翻译限定本批论文和请求上限，不翻译库中其他待办', async t => {
  const {root} = await fixture(t, [record(0),record(1)]); let calls=0;
  const result=await run(root,{paperIds:['doi:10.1234/auto1'],maxRequests:1,fetchImpl:async()=>{calls++;return response();}});
  assert.equal(calls,1); assert.equal(result.available_papers,0);
  const papers=(await readJournalLibrary({root,config})).papers;
  assert.equal(papers.find(p=>p.doi==='10.1234/auto0').title_zh,'');
  assert.equal(papers.find(p=>p.doi==='10.1234/auto1').title_zh,zh.title_zh);
  assert.equal((await run(root,{paperIds:[],fetchImpl:async()=>{throw Error('No selected papers');}})).requested_this_run,0);
});

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

const later = minutes => () => new Date(Date.parse(time) + minutes * 60000);

async function recollect(root, abstract, minutes) {
  const at = later(minutes), rows = [record(0, { abstract, last_checked_at: at().toISOString() })];
  const clients = Object.fromEntries(['crossref', 'openalex'].map(source => [source, async j => ({
    source, journal_key: j.key, ok: true, complete: true, raw_count: source === 'crossref' ? 1 : 0,
    records: source === 'crossref' ? rows : [], raw_pages: [{ fixture: true }], rejected: [], duration_ms: 0, error: null
  })]));
  return runJournalCollection(config, { root, journalKey: 'AER', clients, now: at });
}

test('自动恢复：英文回到历史版本后原样恢复已接受译文，零调用且不重置账本', async t => {
  const { root } = await fixture(t);
  await run(root);
  const original = (await readJournalLibrary({ root, config })).papers[0];
  await recollect(root, `${record(0).abstract} Additional evidence is provided.`, 60);
  const otherZh = `${zh.abstract_zh}我们还提供了额外的证据。`;
  await run(root, { now: later(61), fetchImpl: async () => response({ abstract_zh: otherZh }) });
  await recollect(root, record(0).abstract, 120);
  const before = await readJournalLibrary({ root, config }), ledger = await readTranslationState(root);
  assert.equal(before.papers[0].abstract_translation_status, 'outdated');
  assert.equal(before.papers[0].abstract_zh, otherZh);
  let checkpoints = 0;
  const recovered = await run(root, { apiKey: undefined, now: later(121),
    publishCheckpoint: async ({ phase }) => { assert.equal(phase, 'settle'); checkpoints++; },
    fetchImpl: async () => { throw new Error('must not call API'); } });
  assert.equal(recovered.recovered_fields, 1); assert.equal(recovered.requested_this_run, 0);
  assert.equal(recovered.held_fields, 0); assert.equal(checkpoints, 1);
  const after = await readJournalLibrary({ root, config }), paper = after.papers[0];
  assert.equal(paper.abstract_translation_status, 'done'); assert.equal(paper.abstract_zh, original.abstract_zh);
  assert.equal(paper.translation_provenance.abstract.translated_at, original.translation_provenance.abstract.translated_at);
  assert.equal(paper.translation_provenance.abstract.imported_at, later(121)().toISOString());
  for (const key of ['title_zh', 'title_original', 'abstract_original', 'source_records', 'source_text_hash', 'authors', 'doi'])
    assert.deepEqual(paper[key], before.papers[0][key]);
  assert.deepEqual(await readTranslationState(root), ledger);
  assert.equal((await run(root, { now: later(122) })).recovered_fields, 0);
});

test('自动恢复：历史原文不同则不借用旧译文，成功账本不能替代校验过的快照', async t => {
  const { root } = await fixture(t); await run(root);
  const original = await readJournalLibrary({ root, config });
  await recollect(root, `${record(0).abstract} Different original text.`, 60);
  assert.equal((await run(root, { now: later(61) })).recovered_fields, 0);
  await recollect(root, record(0).abstract, 120);
  const before = await readJournalLibrary({ root, config });
  // Tampering with the accepted old paper must fail its immutable reference hash.
  const file = path.join(root, Object.values(original.manifest.papers)[0].path);
  await fs.appendFile(file, ' ');
  await assert.rejects(run(root, { now: later(121), fetchImpl: async () => { throw new Error('must not call API'); } }));
  assert.equal(await fs.readFile(path.join(root, 'current.json'), 'utf8'), before.pointerText);
});

test('自动翻译恢复：30分钟后只重试失败摘要，保留成功标题和历史账本', async (t) => {
  const { root } = await fixture(t);
  await run(root, { fetchImpl: async () => response({ ...zh, abstract_zh: zh.abstract_zh.replace('2.5', '很多') }) });
  const initial = await readTranslationState(root);
  assert.equal(initial.schema_version, 2);
  assert.deepEqual(initial.reservations[0].items[0].field_errors, { abstract: 'MISSING_NUMBERS' });
  assert.equal((await run(root, { now: later(29) })).requested_this_run, 0);
  let calls = 0;
  const recovered = await run(root, { now: later(30), fetchImpl: async (url, options) => {
    calls++;
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.deepEqual(input.requested_fields, ['abstract']);
    const ledger = await readTranslationState(root);
    assert.equal(ledger.reservations.at(-1).items[0].status, 'reserved');
    assert.deepEqual(ledger.reservations.at(-1).items[0].retry_of, { abstract: initial.reservations[0].id });
    return response({ abstract_zh: zh.abstract_zh });
  } });
  assert.equal(calls, 1); assert.equal(recovered.held_fields, 0);
  const state = await readTranslationState(root);
  assert.deepEqual(state.reservations[0], initial.reservations[0]);
  const paper = (await readJournalLibrary({ root, config })).papers[0];
  assert.equal(paper.title_zh, zh.title_zh); assert.equal(paper.abstract_zh, zh.abstract_zh);
  assert.equal((await run(root, { now: later(90) })).requested_this_run, 0);
});

test('自动翻译恢复：旧版失败记录不删改，升级账本后可安全重试', async (t) => {
  const { root } = await fixture(t);
  await run(root, { fetchImpl: async () => response({ ...zh, abstract_zh: '待翻译' }) });
  const legacy = await readTranslationState(root); legacy.schema_version = 1;
  for (const r of legacy.reservations) for (const item of r.items) { delete item.retry_of; delete item.field_errors; delete item.request_profile; }
  await writeTranslationState(root, legacy);
  await run(root, { now: later(31), fetchImpl: async () => response({ abstract_zh: zh.abstract_zh }) });
  const state = await readTranslationState(root);
  assert.equal(state.schema_version, 2); assert.deepEqual(state.reservations[0], legacy.reservations[0]);
  assert.equal(state.reservations[1].items[0].status, 'succeeded');
});

test('自动翻译恢复：同一请求方案同一字段最多3次，不靠清空账本无限重跑', async (t) => {
  const { root } = await fixture(t); let calls = 0;
  const bad = async (url, options) => {
    calls++; const fields = JSON.parse(JSON.parse(options.body).messages[1].content).requested_fields;
    return response(Object.fromEntries(fields.map(field => [`${field}_zh`, field === 'title' ? zh.title_zh : '待翻译'])));
  };
  for (const minutes of [0, 30, 60]) assert.equal((await run(root, { now: later(minutes), fetchImpl: bad })).requested_this_run, 1);
  assert.equal((await run(root, { now: later(600), fetchImpl: bad })).requested_this_run, 0);
  assert.equal(calls, TRANSLATION_RETRY.max_attempts);
  const state = await readTranslationState(root); assert.equal(state.reservations.length, 3);
  assert.equal(state.reservations[2].items[0].retry_of.abstract, state.reservations[1].id);
  assert.equal(automationQueue(await readJournalLibrary({ root, config }), state, later(600)()).held.length, 1);
  for (const mutate of [
    s => { s.reservations[1].items[0].retry_of.abstract = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; },
    s => { s.reservations[1].created_at = time; },
    s => { s.reservations[0].items[0].usage = null; },
    s => { s.reservations[0].items[0].code = 'NETWORK_ERROR'; },
    s => { s.reservations[0].items[0].field_errors.abstract = 'secret response body'; },
    s => { const r = structuredClone(s.reservations[2]); r.id = randomUUID(); r.created_at = later(90)().toISOString(); r.finished_at = r.created_at; r.items[0].retry_of.abstract = s.reservations[2].id; s.reservations.push(r); }
  ]) {
    const badState = structuredClone(state); mutate(badState); assert.throws(() => validateTranslationState(badState));
  }
});

test('改进数字保留方案可恢复旧方案已结算失败，保留旧账本且最多新增3次', async (t) => {
  const { root } = await fixture(t);
  const bad = async (_, options) => {
    const fields = JSON.parse(JSON.parse(options.body).messages[1].content).requested_fields;
    return response(Object.fromEntries(fields.map(field => [`${field}_zh`, field === 'title' ? zh.title_zh : '待翻译'])));
  };
  for (const minutes of [0, 30, 60]) await run(root, { now: later(minutes), fetchImpl: bad });
  const legacy = await readTranslationState(root);
  for (const entry of legacy.reservations) for (const item of entry.items) delete item.request_profile;
  await writeTranslationState(root, legacy);
  assert.equal((await run(root, { now: later(89), fetchImpl: bad })).requested_this_run, 0);
  for (const minutes of [90, 120, 150]) assert.equal((await run(root, { now: later(minutes), fetchImpl: bad })).requested_this_run, 1);
  assert.equal((await run(root, { now: later(600), fetchImpl: bad })).requested_this_run, 0);
  const state = await readTranslationState(root);
  assert.equal(state.reservations.length, 6);
  assert.deepEqual(state.reservations.slice(0, 3), legacy.reservations);
  assert.deepEqual(state.reservations[3].items[0].tasks.map(t => t.field), ['abstract']);
  assert.equal(state.reservations[3].items[0].retry_of.abstract, legacy.reservations[2].id);
  const unknown = structuredClone(state); unknown.reservations.at(-1).items[0].request_profile = 'invented-reset';
  assert.throws(() => validateTranslationState(unknown));
});

test('自动翻译恢复：网络失败24小时内不重发，未结算预登记即使多日后也不能重发', async (t) => {
  const { root } = await fixture(t);
  await run(root, { fetchImpl: async () => { throw new Error('network'); } });
  assert.equal((await run(root, { now: later(600) })).requested_this_run, 0);
  const second = await fixture(t);
  await run(second.root, { fetchImpl: async () => response({ ...zh, abstract_zh: '待翻译' }) });
  await assert.rejects(run(second.root, { now: later(31), publishCheckpoint: async ({ phase }) => {
    if (phase === 'reserve') throw new Error('remote acknowledgement lost');
  }, fetchImpl: async () => { throw new Error('must not call'); } }), /acknowledgement lost/);
  assert.equal((await run(second.root, { now: later(10000) })).requested_this_run, 0);
});

test('已结束网络失败：24小时后有界重试，保留未知收费并在远端预登记后才调用', async t => {
  const { root } = await fixture(t);
  await run(root, { fetchImpl: async () => { throw new Error('network'); } });
  const initial = await readTranslationState(root);
  assert.equal((await run(root, { now: later(1439) })).requested_this_run, 0);
  let reserved = false, calls = 0;
  const result = await run(root, { now: later(1440), publishCheckpoint: async ({ phase }) => {
    if (phase === 'reserve') {
      const state = await readTranslationState(root);
      assert.deepEqual(state.reservations[0], initial.reservations[0]);
      assert.deepEqual(state.reservations[1].items[0].retry_of,
        { title: initial.reservations[0].id, abstract: initial.reservations[0].id });
      reserved = true;
    }
  }, fetchImpl: async () => { assert.ok(reserved); calls++; return response(); } });
  assert.equal(calls, 1); assert.equal(result.held_fields, 0); assert.equal(result.unknown_usage_requests, 1);
  assert.equal(result.completed_fields, 2);
  const state = await readTranslationState(root);
  assert.deepEqual(state.reservations[0], initial.reservations[0]);
  assert.equal(state.reservations[0].items[0].usage, null);
  assert.equal((await run(root, { now: later(3000) })).requested_this_run, 0);
});

test('网络重试不会因切换请求方案无限增加；未知模型、账户错误及缺用量响应仍不重试', async t => {
  const { root } = await fixture(t), fail = async () => { throw new Error('network'); };
  await run(root, { fetchImpl: fail });
  const initial = await readTranslationState(root);
  delete initial.reservations[0].items[0].request_profile;
  await writeTranslationState(root, initial);
  for (const minutes of [1440, 2880]) assert.equal((await run(root, { now: later(minutes), fetchImpl: fail })).requested_this_run, 1);
  assert.equal((await run(root, { now: later(4320), fetchImpl: fail })).requested_this_run, 0);
  const state = await readTranslationState(root);
  assert.equal(state.reservations.length, 3); assert.deepEqual(state.reservations[0], initial.reservations[0]);
  for (const code of ['USAGE_MISSING', 'AUTH_ERROR', 'INSUFFICIENT_BALANCE', 'ACCESS_DENIED', 'HTTP_ERROR', 'UNEXPECTED_MODEL']) {
    const blocked = structuredClone(initial); blocked.reservations[0].items[0].code = code;
    assert.equal(automationQueue(await readJournalLibrary({ root, config }), blocked, later(10000)()).available.length, 0);
  }
  const timeout = structuredClone(initial); timeout.reservations[0].items[0].code = 'TIMEOUT';
  assert.equal(automationQueue(await readJournalLibrary({ root, config }), timeout, later(1440)()).available.length, 2);
});

test('数字占位方案兼容旧数字请求账本，三种方案总共最多9次，不重译成功标题', async (t) => {
  const { root } = await fixture(t);
  const bad = async (_, options) => {
    const fields = JSON.parse(JSON.parse(options.body).messages[1].content).requested_fields;
    return response(Object.fromEntries(fields.map(field => [`${field}_zh`, field === 'title' ? zh.title_zh : '待翻译'])));
  };
  for (const minutes of [0, 30, 60]) await run(root, { now: later(minutes), fetchImpl: bad });
  let state = await readTranslationState(root);
  for (const r of state.reservations) for (const i of r.items) delete i.request_profile;
  await writeTranslationState(root, state);
  for (const minutes of [90, 120, 150]) await run(root, { now: later(minutes), fetchImpl: bad });
  state = await readTranslationState(root);
  for (const r of state.reservations.slice(3)) for (const i of r.items) i.request_profile = 'numeric_preservation_v1';
  await writeTranslationState(root, state);
  const legacy = structuredClone(state.reservations);
  for (const minutes of [180, 210, 240]) assert.equal((await run(root, { now: later(minutes), fetchImpl: bad })).requested_this_run, 1);
  assert.equal((await run(root, { now: later(600), fetchImpl: bad })).requested_this_run, 0);
  const final = await readTranslationState(root);
  assert.equal(final.reservations.length, TRANSLATION_RETRY.max_total_attempts);
  assert.deepEqual(final.reservations.slice(0, 6), legacy);
  assert.ok(final.reservations.slice(6).every(r => r.items.every(i => i.tasks.length === 1 && i.tasks[0].field === 'abstract')));
});

test('自动翻译恢复：完整但格式错误的返回可重试，未知用量和成功字段不能重试', async (t) => {
  const { root } = await fixture(t);
  await run(root, { fetchImpl: async () => response({ invalid: 'structure' }) });
  const result = await run(root, { now: later(31) });
  assert.equal(result.requested_this_run, 1); assert.equal(result.completed_fields, 2);
  const state = await readTranslationState(root), duplicate = structuredClone(state.reservations.at(-1));
  duplicate.id = randomUUID(); duplicate.created_at = later(90)().toISOString(); duplicate.finished_at = duplicate.created_at;
  duplicate.items[0].retry_of = { title: state.reservations.at(-1).id, abstract: state.reservations.at(-1).id };
  state.reservations.push(duplicate); assert.throws(() => validateTranslationState(state));
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
