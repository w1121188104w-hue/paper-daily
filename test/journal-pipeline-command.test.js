import test from 'node:test';
import assert from 'node:assert/strict';
import { pipelineCommand, parsePipelineArgs } from '../scripts/journal-pipeline.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const policy = { production_enabled: false, zhipu_monthly_limit: 2000, serpapi_monthly_limit: 250 };
const options = patch => ({ loadConfig: async () => ({}), loadPolicy: async () => policy,
  readLibrary: async () => ({ papers: [] }), log: () => {}, runtime: async () => assert.fail('No runtime before gate'), ...patch });
test('命令默认帮助和plan只读，不接触环境、密钥或网络', async () => {
  const env = new Proxy({}, { get: () => assert.fail('Do not inspect env') });
  assert.equal((await pipelineCommand([], options({ env }))).status, 'help');
  const result = await pipelineCommand(['--plan', '--all'], options({ env }));
  assert.equal(result.status, 'plan'); assert.equal(result.production_enabled, false);
  assert.equal(result.lookback_days, 60); assert.deepEqual(result.phases,
    ['three_source_discovery', 'official_catalog_search', 'saved_duplicate_resolution', 'metadata_repair', 'duplicate_resolution', 'translation_queue']);
});
test('两个生产开关必须同时开启，关闭时不读取密钥或构造运行服务', async () => {
  assert.equal((await pipelineCommand(['--run', '--save', '--all'], options({ env: new Proxy({}, { get: () => assert.fail('Policy is off') }) }))).status, 'disabled');
  assert.equal((await pipelineCommand(['--run', '--save', '--all'], options({ env: {}, loadPolicy: async () => ({ ...policy, production_enabled: true }) }))).status, 'disabled');
});
test('参数互斥和上限在IO之前拒绝；未授权宿主不能运行', async () => {
  for (const args of [['--run', '--all'], ['--plan', '--all', '--save'], ['--run', '--all', '--save', '--isolate'],
    ['--plan', '--all', '--checkpoint'], ['--run', '--save', '--all', '--resume-from', 'archive'],
    ['--plan', '--all', '--journal', 'AER'], ['--plan', '--all', '--max-papers', '1001'], ['--plan', '--all', '--max-pages', '0']]) assert.throws(() => parsePipelineArgs(args));
  await assert.rejects(pipelineCommand(['--run', '--isolate', '--all'], options({ env: {} })));
});

test('隔离续跑先验证存档再读密钥；部分失败与执行异常仍导出已提交历史', async () => {
  const events = [], base = options({ root: 'G:/test/data/journal-store', env: {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'w1121188104w-hue/paper-daily', GITHUB_EVENT_NAME: 'workflow_dispatch',
    RUNNER_TEMP: 'runner-temp', GITHUB_OUTPUT: 'runner-output' },
    clone: async () => ({ root: 'original-copy', verifyOriginal: async () => { events.push('formal-verified'); return true; } }),
    restoreCheckpoint: async () => { events.push('restored'); return { root: 'resumed-copy', verifyOriginal: async () => { events.push('artifact-verified'); } }; },
    runtime: async () => { events.push('runtime'); return { summary: () => ({}) }; },
    execute: async (_, o) => { assert.equal(o.root, 'resumed-copy'); events.push('executed'); return { status: 'partial' }; },
    saveCheckpoint: async (_, o) => { assert.equal(o.root, 'resumed-copy'); events.push('saved'); return { directory: 'archive-copy', files: 1, versions: 1 }; },
    outputCheckpoint: async (file, saved) => { assert.equal(file, 'runner-output'); assert.equal(saved.directory, 'archive-copy'); events.push('output'); } });
  const args = ['--run', '--isolate', '--all', '--checkpoint', '--resume-from', 'artifact'];
  assert.equal((await pipelineCommand(args, base)).status, 'partial');
  assert.deepEqual(events, ['restored', 'runtime', 'executed', 'formal-verified', 'formal-verified', 'artifact-verified', 'saved', 'output']);
  events.length = 0;
  await assert.rejects(pipelineCommand(args, { ...base, execute: async () => { throw new Error('stage failed'); } }), /stage failed/);
  assert.ok(events.includes('saved')); assert.ok(events.includes('output'));
  events.length = 0;
  await assert.rejects(pipelineCommand(args, { ...base, restoreCheckpoint: async () => { throw new Error('invalid artifact'); } }), /invalid artifact/);
  assert.deepEqual(events, ['formal-verified']);
  events.length = 0;
  await assert.rejects(pipelineCommand(args, { ...base, clone: async () => ({ root: 'original-copy', verifyOriginal: async () => { throw new Error('formal changed'); } }) }), /formal changed/);
  assert.ok(!events.includes('saved'));
});
test('隔离入口仅向副本写入，执行失败仍核对原库，不自动开启生产', async () => {
  let verified = 0, constructed = 0;
  const base = options({ root: 'G:/test/data/journal-store', env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'w1121188104w-hue/paper-daily', GITHUB_EVENT_NAME: 'workflow_dispatch' },
    clone: async () => ({ root: 'isolated-copy', verifyOriginal: async () => { verified++; return true; } }),
    runtime: async () => { constructed++; return { summary: () => ({ search_calls: { zhipu: 0, serpapi: 0 } }) }; },
    execute: async (c, o) => { assert.equal(o.root, 'isolated-copy'); return { status: 'success' }; } });
  const result = await pipelineCommand(['--run', '--isolate', '--all'], base);
  assert.equal(result.original_unchanged, true); assert.equal(verified, 2); assert.equal(constructed, 1);
  await assert.rejects(pipelineCommand(['--run', '--isolate', '--all'], { ...base, execute: async () => { throw Error('stop'); } }));
  assert.equal(verified, 3);
});
test('正式入口限定默认分支并且不自行提交Git或调用翻译', async () => {
  const env = { JOURNAL_SEARCH_ENABLED: 'true', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'w1121188104w-hue/paper-daily',
    GITHUB_EVENT_NAME: 'schedule', DATA_BRANCH: 'master', GITHUB_REF: 'refs/heads/feature' };
  const base = options({ env, loadPolicy: async () => ({ ...policy, production_enabled: true }) });
  await assert.rejects(pipelineCommand(['--run', '--save', '--all'], base));
  const result = await pipelineCommand(['--run', '--save', '--all'], { ...base, env: { ...env, GITHUB_REF: 'refs/heads/master' },
    runtime: async () => ({ summary: () => ({}) }), execute: async () => ({ status: 'success', translation_calls: 0 }) });
  assert.equal(result.isolated, false); assert.equal(result.translation_calls, 0);
});
test('每日工作流真实门控：配置关闭即输出false，新旧路径互斥，翻译密钥不混入', async t => {
  const flow = JSON.parse(await fs.readFile(new URL('../.github/workflows/daily-collect.yml', import.meta.url), 'utf8'));
  const steps = flow.jobs.collect.steps, gate = steps.find(s => s.id === 'search_gate'), pipeline = steps.find(s => s.id === 'pipeline');
  assert.ok(!JSON.stringify(gate).includes('secrets.'));
  assert.equal(pipeline.if, "steps.search_gate.outputs.enabled == 'true'");
  assert.equal(steps.find(s => s.id === 'collect').if, "steps.search_gate.outputs.enabled != 'true'");
  assert.ok(steps.find(s => s.id === 'enrich').if.startsWith("steps.search_gate.outputs.enabled != 'true'"));
  assert.equal(pipeline.env.DEEPSEEK_API_KEY, undefined);
  assert.ok(steps.findIndex(s => s.id === 'pipeline') < steps.findIndex(s => s.id === 'translate'));
  assert.equal(steps.find(s => s.id === 'translate').env.ZHIPU_API_KEY, undefined);
  const parent = path.resolve(os.tmpdir()), dir = await fs.mkdtemp(path.join(parent, 'pipeline-gate-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(dir)), parent); assert.ok(path.basename(dir).startsWith('pipeline-gate-test-')); await fs.rm(dir, { recursive: true, force: true }); });
  const output = path.join(dir, 'output'), prefix = 'node --input-type=module -e "';
  assert.ok(gate.run.startsWith(prefix) && gate.run.endsWith('"'));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', gate.run.slice(prefix.length, -1)], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, JOURNAL_SEARCH_ENABLED: 'true', GITHUB_OUTPUT: output } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(await fs.readFile(output, 'utf8'), 'enabled=false\n');
});

test('隔离工作流只上传明确输出的存档，部分失败仍保存；下载不覆盖代码和正式库', async () => {
  const flow = JSON.parse(await fs.readFile(new URL('../deploy/github/search-preflight.yml.example', import.meta.url), 'utf8'));
  const steps = flow.jobs.preflight.steps, upload = steps.find(s => s.uses?.startsWith('actions/upload-artifact@')),
    download = steps.find(s => s.uses?.startsWith('actions/download-artifact@')), run = steps.find(s => s.id === 'verification');
  assert.equal(upload.if, "always() && steps.verification.outputs.checkpoint_path != ''");
  assert.equal(upload.with.path, '${{ steps.verification.outputs.checkpoint_path }}');
  assert.equal(upload.with.overwrite, false); assert.equal(upload.with['include-hidden-files'], false);
  assert.equal(download.with.path, '${{ runner.temp }}/pipeline-resume');
  assert.equal(download.with.repository, '${{ github.repository }}');
  assert.equal(download.with.name, upload.with.name); assert.equal(upload.with['retention-days'], 30);
  assert.ok(steps.indexOf(download) < steps.indexOf(run));
  assert.ok(run.run.includes('--checkpoint')); assert.ok(run.run.includes('--resume-from'));
  assert.equal(run.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(flow.concurrency.group, 'journal-production');
  for (const step of [upload, download]) assert.match(step.uses, /@[a-f0-9]{40}$/);
  const validate = steps.find(s => s.name.startsWith('Validate checkpoint selection'));
  assert.ok(!JSON.stringify(validate).includes('secrets.'));
  const prefix = 'node --input-type=module -e "', code = validate.run.slice(prefix.length, -1);
  for (const [id, mode, expected] of [['', 'false', 0], ['12345', 'true', 0], ['$(evil)', 'true', 1], ['123', 'false', 1]]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { RESUME_RUN_ID: id, PIPELINE_ALL: mode } });
    assert.equal(child.status, expected);
  }
});
