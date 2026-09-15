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
  assert.equal(result.lookback_days, 60); assert.equal(result.phases.length, 4);
});
test('两个生产开关必须同时开启，关闭时不读取密钥或构造运行服务', async () => {
  assert.equal((await pipelineCommand(['--run', '--save', '--all'], options({ env: new Proxy({}, { get: () => assert.fail('Policy is off') }) }))).status, 'disabled');
  assert.equal((await pipelineCommand(['--run', '--save', '--all'], options({ env: {}, loadPolicy: async () => ({ ...policy, production_enabled: true }) }))).status, 'disabled');
});
test('参数互斥和上限在IO之前拒绝；未授权宿主不能运行', async () => {
  for (const args of [['--run', '--all'], ['--plan', '--all', '--save'], ['--run', '--all', '--save', '--isolate'],
    ['--plan', '--all', '--journal', 'AER'], ['--plan', '--all', '--max-papers', '1001'], ['--plan', '--all', '--max-pages', '0']]) assert.throws(() => parsePipelineArgs(args));
  await assert.rejects(pipelineCommand(['--run', '--isolate', '--all'], options({ env: {} })));
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
