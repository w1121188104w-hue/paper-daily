import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { createTranslationBatch } from '../src/services/translationQueue.js';
import { runJournalCollection } from '../src/services/journalRun.js';
import { applyTranslationResult } from '../src/services/translationImport.js';
import { importTranslationFile } from '../src/services/translationWorkflow.js';
import { DEEPSEEK_ENDPOINT, DEEPSEEK_MODEL, PILOT_LIMITS, deepseekRequest, planDeepSeekBatch,
  translateDeepSeekBatch } from '../src/services/deepseekTranslation.js';
import { generateReviewKey, reviewPublicKey, sealTranslationReview, openTranslationReview } from '../src/services/translationReviewEnvelope.js';
import { runDeepSeekCommand } from '../scripts/deepseek-translate.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'AER');
const time = '2026-09-10T09:00:00.000Z', now = () => new Date(time);
const apiKey = 'test-only-secret-not-a-real-credential';
const zh = { title_zh: '信贷市场与企业投资', abstract_zh: '我们利用2001至2020年的数据研究企业投资。信贷供给对投资的影响幅度为2.5%。结果在不同企业和地区中均保持稳健。' };
function record(override = {}) {
  return normalizeSourceRecord({ source: 'crossref', source_id: '10.1234/deepseek', doi: '10.1234/deepseek',
    title: 'Credit markets and firm investment',
    abstract: 'We study firm investment using data from 2001 to 2020. Credit supply affects investment by 2.5 percent. The results remain robust across firms and regions.',
    authors: [{ name: 'Alice Smith', orcid: '' }], journal_key: 'AER', journal_name: journal.name,
    journal_category: journal.category, journal_category_zh: journal.category_zh,
    print_issn: journal.print_issn, electronic_issn: journal.electronic_issn, publication_date: '2026-09-01', last_checked_at: time, ...override });
}
const papers = (records = [record()]) => mergePapers(records, { firstSeenDate: '2026-09-10', checkedAt: time }).papers;
const batch = (records) => createTranslationBatch(papers(records), { now: now() });
const payload = (overrides = {}) => ({ model: DEEPSEEK_MODEL,
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(zh) } }],
  usage: { prompt_tokens: 300, completion_tokens: 70, total_tokens: 370 }, ...overrides });
const response = (data = payload(), status = 200) => new Response(JSON.stringify(data), { status });
const run = (value = batch(), options = {}) => translateDeepSeekBatch(value, { apiKey, now, fetchImpl: async () => response(), ...options });
const keys = generateReviewKey();

async function fixture(t, initialize = true) {
  const parent = path.resolve(os.tmpdir()), temp = await fs.mkdtemp(path.join(parent, 'paper-deepseek-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)), parent); assert.ok(path.basename(temp).startsWith('paper-deepseek-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, 'library');
  if (initialize) {
    const clients = Object.fromEntries(['crossref', 'openalex'].map((source) => [source, async (j) => {
      const rows = source === 'crossref' ? [record()] : [];
      return { source, journal_key: j.key, ok: true, complete: true, raw_count: rows.length, records: rows,
        raw_pages: [{ fixture: true, items: rows }], rejected: [], duration_ms: 0, error: null };
    }]));
    await runJournalCollection(config, { root, journalKey: 'AER', clients, now });
  }
  return { root, temp };
}

test('DeepSeek：固定官方地址、非思考JSON、输出上限；原文只作为资料且不发作者与路径', async () => {
  let calls = 0;
  const output = await run(batch(), { fetchImpl: async (url, options) => {
    calls++; assert.equal(url, DEEPSEEK_ENDPOINT); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.max_tokens, 4096);
    assert.equal(body.stream, false); assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.tools, undefined); assert.ok(!options.body.includes(apiKey));
    assert.deepEqual(Object.keys(JSON.parse(body.messages[1].content)).sort(), ['abstract_original', 'journal', 'requested_fields', 'title_original']);
    return response();
  } });
  assert.equal(calls, 1); assert.equal(output.report.successful_fields, 2);
  assert.equal(output.report.estimated_cny_known_usage, 0.00116);
  assert.equal(output.result.model, DEEPSEEK_MODEL); assert.ok(!JSON.stringify(output).includes(apiKey));
  assert.equal(applyTranslationResult(papers(), output.request, output.result, { config, importedAt: time }).report.stats.completed_fields, 2);
});

test('DeepSeek：缺少密钥、超过10篇、过大原文均在请求前拒绝，原文不被截短', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return response(); };
  await assert.rejects(run(batch(), { apiKey: '', fetchImpl }), { code: 'MISSING_OR_INVALID_KEY' });
  const many = Array.from({ length: 11 }, (_, i) => record({ doi: `10.1234/p${i}`, source_id: `10.1234/p${i}` }));
  const eleven = createTranslationBatch(papers(many), { limit: 11, now: now() });
  await assert.rejects(run(eleven, { fetchImpl }), { code: 'PILOT_LIMIT' });
  const big = batch([record({ abstract: 'A'.repeat(21000) })]);
  await assert.rejects(run(big, { fetchImpl }), { code: 'INPUT_TOO_LARGE' });
  const total = batch(Array.from({ length: 10 }, (_, i) => record({ doi: `10.1234/b${i}`, source_id: `10.1234/b${i}`, abstract: 'A'.repeat(12000) })));
  await assert.rejects(run(total, { fetchImpl }), { code: 'BATCH_TOO_LARGE' });
  assert.equal(calls, 0); assert.equal(JSON.parse(deepseekRequest(big.items[0]).messages[1].content).abstract_original.length, 21000);
});

test('DeepSeek：队列不重译已完成字段、不补写缺失摘要、不翻译期刊目录', async () => {
  const rows = papers([record({ abstract: '' }), record({ doi: '10.1234/admin', source_id: '10.1234/admin', title: 'Table of contents', abstract: '' })]);
  const selected = createTranslationBatch(rows, { now: now() });
  assert.equal(selected.items.length, 1); assert.deepEqual(selected.items[0].requested_fields, ['title']);
  const body = deepseekRequest(selected.items[0]); assert.ok(!body.messages[1].content.includes('abstract_original'));
  const output = await run(selected, { fetchImpl: async () => response(payload({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ title_zh: zh.title_zh }) } }] })) });
  assert.equal(output.result.items[0].abstract_zh, undefined);
  const done = papers(); done[0].title_translation_status = 'done'; done[0].title_zh = zh.title_zh;
  assert.deepEqual(createTranslationBatch(done, { now: now() }).items[0].requested_fields, ['abstract']);
});

for (const [status, code] of [[401, 'AUTH_ERROR'], [402, 'INSUFFICIENT_BALANCE'], [403, 'ACCESS_DENIED'], [429, 'RATE_LIMITED'], [500, 'HTTP_ERROR']]) {
  test(`DeepSeek：HTTP ${status}停止且无重试、无敏感错误正文`, async () => {
    let calls = 0;
    const output = await run(batch([record(), record({ doi: '10.1234/two', source_id: '10.1234/two' })]), {
      fetchImpl: async () => { calls++; return response({ error: apiKey }, status); }
    });
    assert.equal(calls, 1); assert.equal(output.report.rows[0].code, code); assert.equal(output.report.status, 'stopped');
    assert.equal(output.result.items.length, 0); assert.equal(output.report.unknown_usage_requests, 1);
    assert.ok(!JSON.stringify(output).includes(apiKey));
  });
}

test('DeepSeek：网络异常、畸形JSON、截断、模型变化、工具调用、缺用量都不重试', async () => {
  const cases = [
    [async () => { throw new Error(apiKey); }, 'NETWORK_ERROR'],
    [async () => new Response('not JSON'), 'INVALID_RESPONSE'],
    [async () => response(payload({ usage: null })), 'USAGE_MISSING'],
    [async () => response(payload({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: JSON.stringify(zh) } }] })), 'INCOMPLETE_RESPONSE'],
    [async () => response(payload({ model: 'not-trusted' })), 'INVALID_MODEL'],
    [async () => response(payload({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', tool_calls: [{}] } }] })), 'INVALID_RESPONSE'],
    [async () => response(payload({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '' } }] })), 'INVALID_JSON'],
    [async () => response(payload({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ ...zh, extra: 'x' }) } }] })), 'INVALID_TRANSLATION_SHAPE'],
    [async () => response(payload({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ ...zh, title_zh: apiKey }) } }] })), 'SECRET_IN_RESPONSE'],
    [async () => new Response('X'.repeat(PILOT_LIMITS.response_bytes + 1)), 'RESPONSE_TOO_LARGE']
  ];
  for (const [fetchImpl, code] of cases) {
    const output = await run(batch(), { fetchImpl }); assert.equal(output.report.rows[0].code, code);
    assert.equal(output.report.attempted_requests, 1); assert.ok(!JSON.stringify(output).includes(apiKey));
  }
  let calls = 0;
  const changed = await run(batch([record(), record({ doi: '10.1234/two', source_id: '10.1234/two' })]), {
    fetchImpl: async () => response(payload({ model: ++calls === 1 ? DEEPSEEK_MODEL : 'deepseek-other-version' }))
  });
  assert.equal(changed.report.rows[1].code, 'MODEL_CHANGED'); assert.equal(changed.result.items.length, 1);
});

test('DeepSeek：遗漏数字的摘要不进入导入结果，合格标题仍可留待审阅', async () => {
  const output = await run(batch(), { fetchImpl: async () => response(payload({ choices: [{ finish_reason: 'stop',
    message: { role: 'assistant', content: JSON.stringify({ ...zh, abstract_zh: zh.abstract_zh.replace('2.5', '很多') }) } }] })) });
  assert.equal(output.report.status, 'quality_review_needed'); assert.equal(output.report.rows[0].fields.abstract, 'MISSING_NUMBERS');
  assert.equal(output.result.items[0].abstract_zh, undefined); assert.equal(output.result.items[0].title_zh, zh.title_zh);
});

test('DeepSeek：最多10个串行请求，逐篇检查点和用量累计', async () => {
  let active = 0, maximum = 0, checkpoints = 0;
  const ten = batch(Array.from({ length: 10 }, (_, i) => record({ doi: `10.1234/p${i}`, source_id: `10.1234/p${i}` })));
  const output = await run(ten, { fetchImpl: async () => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return response(); },
    checkpoint: async (value) => { checkpoints++; assert.equal(value.report.attempted_requests, checkpoints); } });
  assert.equal(maximum, 1); assert.equal(checkpoints, 10); assert.equal(output.report.usage.total_tokens, 3700);
  assert.equal(planDeepSeekBatch(ten).max_output_tokens, 40960);
});

test('草稿加密：正确钥匙可读，错误钥匙、损坏密文、篡改标签均拒绝；附件无明文', () => {
  const value = { title: zh.title_zh, draft: 'unreviewed translation' };
  const sealed = sealTranslationReview(value, keys.public_key);
  assert.deepEqual(openTranslationReview(sealed, keys.private_key), value);
  assert.ok(!JSON.stringify(sealed).includes(zh.title_zh)); assert.ok(!JSON.stringify(sealed).includes(value.draft));
  assert.throws(() => openTranslationReview(sealed, generateReviewKey().private_key), { code: 'REVIEW_DECRYPT_FAILED' });
  for (const field of ['tag', 'ciphertext', 'wrapped_key']) {
    const bad = structuredClone(sealed); const bytes = Buffer.from(bad[field], 'base64'); bytes[0] ^= 1; bad[field] = bytes.toString('base64');
    assert.throws(() => openTranslationReview(bad, keys.private_key), { code: 'REVIEW_DECRYPT_FAILED' });
  }
  assert.throws(() => reviewPublicKey(apiKey), { code: 'INVALID_REVIEW_PUBLIC_KEY' });
});

test('DeepSeek命令：默认/plan/空库只读且不取密钥，run缺钥匙不写工作文件', async (t) => {
  const { root } = await fixture(t), before = await fs.readFile(path.join(root, 'current.json'), 'utf8');
  const messages = [], log = (value) => messages.push(value);
  const env = new Proxy({}, { get: () => { throw new Error('Read-only mode must not read secrets'); } });
  for (const args of [[], ['--plan']]) assert.equal(await runDeepSeekCommand(args, { root, env, log, now }), 0);
  assert.equal(JSON.parse(messages.at(-1)).network_called, false);
  await assert.rejects(runDeepSeekCommand(['--run'], { root, env: {}, log, now }), { code: 'MISSING_OR_INVALID_KEY' });
  await assert.rejects(fs.stat(path.join(root, 'translations')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(root, 'current.json'), 'utf8'), before);
  const empty = await fixture(t, false);
  assert.equal(await runDeepSeekCommand(['--plan'], { root: empty.root, env, log, now }), 0);
  await assert.rejects(fs.stat(empty.root), { code: 'ENOENT' });
});

test('DeepSeek命令：真实流程的离线模拟只留密文，重复批次拒绝；本机解密预检不改正式库', async (t) => {
  const { root } = await fixture(t), before = await fs.readFile(path.join(root, 'current.json'), 'utf8');
  const logs = []; const log = (value) => logs.push(value);
  await runDeepSeekCommand(['--prepare-review'], { root, log });
  const info = JSON.parse(logs.at(-1)); let calls = 0;
  const env = { DEEPSEEK_API_KEY: apiKey, TRANSLATION_REVIEW_PUBLIC_KEY: info.public_key };
  const options = { root, env, now, log, fetchImpl: async () => { calls++; return response(); } };
  assert.equal(await runDeepSeekCommand(['--run'], options), 0);
  await assert.rejects(runDeepSeekCommand(['--run'], options), { code: 'BATCH_ALREADY_ATTEMPTED' });
  assert.equal(calls, 1); assert.equal(await fs.readFile(path.join(root, 'current.json'), 'utf8'), before);
  const [id] = await fs.readdir(path.join(root, 'translations', 'deepseek'));
  const encrypted = path.join(root, 'translations', 'deepseek', id, 'encrypted', 'review-01.json');
  assert.ok(!(await fs.readFile(encrypted, 'utf8')).includes(zh.title_zh));
  assert.equal(await runDeepSeekCommand(['--open-review', encrypted, '--key-id', info.key_id], { root, log }), 0);
  const opened = JSON.parse(logs.at(-1));
  const preview = await importTranslationFile(config, { root, file: opened.response_path, now });
  assert.equal(preview.report.stats.completed_fields, 2); assert.equal(preview.committed, false);
  assert.equal(await fs.readFile(path.join(root, 'current.json'), 'utf8'), before);
  assert.ok(!logs.join('\n').includes(apiKey)); assert.ok(!logs.join('\n').includes('BEGIN PRIVATE KEY'));
});

test('DeepSeek工作流：仅手动、默认分支、首次运行、无仓库写权限，密钥只给翻译步骤，附件限密文', async () => {
  const workflow = JSON.parse(await fs.readFile(new URL('../.github/workflows/translate-pilot.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']); assert.equal(workflow.on.workflow_dispatch.inputs.confirm_pilot.default, false);
  assert.deepEqual(workflow.permissions, { contents: 'read' }); assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const job = workflow.jobs.pilot; assert.match(job.if, /github.run_attempt == 1/); assert.match(job.if, /default_branch/);
  const secretSteps = job.steps.filter((step) => JSON.stringify(step).includes('secrets.DEEPSEEK_API_KEY'));
  assert.equal(secretSteps.length, 1); assert.equal(secretSteps[0].id, 'translate');
  assert.equal(job.steps[0].with['persist-credentials'], false);
  const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.match(upload.uses, /@[a-f0-9]{40}$/); assert.equal(upload.with.path, '${{ steps.translate.outputs.directory }}/*.json');
  assert.equal(upload.with['retention-days'], 7);
  const daily = await fs.readFile(new URL('../.github/workflows/daily-collect.yml', import.meta.url), 'utf8');
  assert.ok(!daily.toLowerCase().includes('deepseek')); assert.ok(!JSON.stringify(workflow).includes('git push'));
});

test('人工续接：绑定同一10篇清单，仅请求尚未尝试的后8篇，前2篇绝不重发', async () => {
  const ten = batch(Array.from({ length: 10 }, (_, i) => record({ doi: `10.1234/p${i}`, source_id: `10.1234/p${i}` })));
  const output = await run(ten, { startIndex: 2 });
  assert.equal(output.report.plan.start_index, 2); assert.equal(output.report.plan.max_requests, 8);
  assert.equal(output.report.attempted_requests, 8);
  assert.deepEqual(output.report.rows.map((row) => row.id), ten.items.slice(2).map((item) => item.id));
  for (const startIndex of [-1, 10, 1.5, NaN]) await assert.rejects(run(ten, { startIndex }), { code: 'INVALID_START_INDEX' });
});

test('格式不合格时保留模型正文供加密审阅，但不能进入导入结果或泄露密钥', async () => {
  const content = JSON.stringify({ unexpected: '仅用于审阅的模型正文' });
  const output = await run(batch(), { fetchImpl: async () => response(payload({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] })) });
  assert.equal(output.result.items.length, 0); assert.equal(output.review_rejections[0].content, content);
  assert.ok(!JSON.stringify(output.report).includes('仅用于审阅'));
  const leaked = await run(batch(), { fetchImpl: async () => response(payload({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: apiKey } }] })) });
  assert.equal(leaked.review_rejections.length, 0); assert.ok(!JSON.stringify(leaked).includes(apiKey));
});

test('人工续接：错误的批次指纹在读密钥和写工作目录前拒绝', async (t) => {
  const { root } = await fixture(t);
  const env = new Proxy({}, { get: () => { throw new Error('Must not read key before batch guard'); } });
  await assert.rejects(runDeepSeekCommand(['--run', '--expected-batch', 'batch-wrong'], { root, env, now, log: () => {} }), { code: 'EXPECTED_BATCH_MISMATCH' });
  await assert.rejects(fs.stat(path.join(root, 'translations')), { code: 'ENOENT' });
});

test('完整返回的格式错误只隔离该论文，继续下一篇，不重试坏条目', async () => {
  let count = 0;
  const two = batch([record(), record({ doi: '10.1234/two', source_id: '10.1234/two' })]);
  const output = await run(two, { fetchImpl: async () => ++count === 1
    ? response(payload({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }] })) : response() });
  assert.equal(count, 2); assert.equal(output.report.status, 'quality_review_needed');
  assert.equal(output.result.items.length, 1); assert.equal(output.result.items[0].id, two.items[1].id);
  assert.equal(output.report.unknown_usage_requests, 0); assert.equal(output.review_rejections.length, 1);
});
