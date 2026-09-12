import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { scheduleSlot, planJournalSchedule, emptyScheduleState, validateScheduleState, claimScheduleSlot, SCHEDULE_WAKE_CRON } from '../src/services/journalSchedule.js';
import { runScheduleGate, scheduleGitHubClient } from '../scripts/journal-schedule.js';

const date = value => new Date(value);
const at = '2026-09-12T00:17:00.000Z';
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'w1121188104w-hue/paper-daily', DATA_BRANCH: 'master',
  GITHUB_REF: 'refs/heads/master', GITHUB_RUN_ID: '123456', GITHUB_EVENT_NAME: 'schedule',
  JOURNAL_AUTOMATION_ENABLED: 'true', GITHUB_OUTPUT: path.join(os.tmpdir(),'schedule-output') };
const noop = () => {};
const options = more => ({ now: () => date(at),env,log: noop,append: async () => {},...more });
const jsonFile = value => { const bytes = Buffer.from(JSON.stringify(value)); return {
  type: 'file',encoding: 'base64',sha: 'a'.repeat(40),size: bytes.length,content: bytes.toString('base64') }; };
const fakeResponse = value => new Response(JSON.stringify(value),{ status: 200 });

test('北京时间08:17/13:17边界正确，深夜跨UTC日期不误跑前一天', () => {
  assert.equal(scheduleSlot(date('2026-09-12T00:16:59Z')),null);
  assert.equal(scheduleSlot(date(at)).key,'2026-09-12:morning');
  assert.equal(scheduleSlot(date('2026-09-12T05:16:59Z')).name,'morning');
  assert.equal(scheduleSlot(date('2026-09-12T05:17:00Z')).name,'afternoon');
  assert.equal(scheduleSlot(date('2026-09-12T16:01:00Z')),null);
  assert.equal(scheduleSlot(date('2026-09-13T00:17:00Z')).key,'2026-09-13:morning');
});
test('四小时迟到的旧触发按实际北京时间判断，不依赖事件声称的计划时刻', () => {
  assert.equal(planJournalSchedule({ now: date('2026-09-11T04:39:19Z') }).slot.name,'morning');
  assert.equal(planJournalSchedule({ now: date('2026-09-11T09:40:49Z') }).slot.name,'afternoon');
  assert.equal(planJournalSchedule({ now: date('2026-09-11T09:40:49Z') }).delay_minutes,263);
});
test('重复轻量检查每天至多放行早午各一次，次日重新允许', () => {
  let state = emptyScheduleState(); const accepted = [];
  for (let minutes = 0; minutes < 1440; minutes += 10) {
    const now = date(Date.parse('2026-09-11T16:00:00Z')+minutes*60000);
    const plan = planJournalSchedule({ now,state });
    if (plan.run) { accepted.push(plan.slot.name); state = claimScheduleSlot(state,plan,{ now,runId: '123' }); }
  }
  assert.deepEqual(accepted,['morning','afternoon']);
  assert.equal(planJournalSchedule({ now: date('2026-09-13T00:17:00Z'),state }).run,true);
});
test('先前手动采集或部分失败也占当前时段，不因缺标题警告每十分钟重采', () => {
  const now = date('2026-09-12T04:00:00Z');
  assert.equal(planJournalSchedule({ now,lastCollectionAt: '2026-09-12T03:45:14.693Z' }).reason,'ALREADY_COLLECTED_IN_SLOT');
  assert.equal(planJournalSchedule({ now: date('2026-09-12T05:17:00Z'),lastCollectionAt: '2026-09-12T03:45:14.693Z' }).run,true);
  assert.equal(planJournalSchedule({ now,lastCollectionAt: '2026-09-11T09:41:08.255Z' }).run,true);
});
test('非法状态、未来正式日志、错误预约与过期计划均拒绝，不静默清空', () => {
  assert.throws(() => validateScheduleState({ schema_version: 1,slots: { bad: {} } }));
  assert.throws(() => planJournalSchedule({ now: date(at),lastCollectionAt: '2026-09-13T00:17:00.000Z' }));
  assert.throws(() => claimScheduleSlot(emptyScheduleState(),planJournalSchedule({ now: date(at) }),{ now: date('2026-09-12T05:17:00Z'),runId: '123' }));
  const state = claimScheduleSlot(emptyScheduleState(),planJournalSchedule({ now: date(at) }),{ now: date(at),runId: '123' });
  assert.throws(() => claimScheduleSlot(state,planJournalSchedule({ now: date(at) }),{ now: date(at),runId: '123' }));
});
test('清晨检查不联网；手动默认保持原入口，按计划手动验收则遵守时段', async () => {
  const client = { readState: async () => { throw new Error('must not read'); } };
  assert.equal((await runScheduleGate(options({ now: () => date('2026-09-12T00:00:00Z'),client }))).run,false);
  assert.equal((await runScheduleGate(options({ client,env: { ...env,GITHUB_EVENT_NAME: 'workflow_dispatch' } }))).reason,'MANUAL_REQUEST');
  assert.equal((await runScheduleGate(options({ now: () => date('2026-09-12T00:00:00Z'),client,env: { ...env,GITHUB_EVENT_NAME: 'workflow_dispatch',RESPECT_SCHEDULE: 'true' } }))).run,false);
});
test('必须先远端预约成功才输出放行；超时/冲突/不确定写入一律不采集', async () => {
  const events = [];
  const client = { readState: async () => ({ state: emptyScheduleState(),sha: 'old' }),lastCollection: async () => null,
    saveState: async (s,sha) => { assert.equal(sha,'old'); assert.equal(s.slots['2026-09-12:morning'].github_run_id,env.GITHUB_RUN_ID); events.push('save'); } };
  await runScheduleGate(options({ client,append: async () => { events.push('output'); } }));
  assert.deepEqual(events,['save','output']); events.length = 0;
  client.saveState = async () => { throw new Error('uncertain'); };
  await assert.rejects(runScheduleGate(options({ client,append: async () => events.push('output') })));
  assert.deepEqual(events,[]);
});
test('已有预约直接跳过，不读取论文历史或写入，也不调用文献/翻译接口', async () => {
  const state = claimScheduleSlot(emptyScheduleState(),planJournalSchedule({ now: date(at) }),{ now: date(at),runId: '100' });
  const client = { readState: async () => ({ state,sha: 'old' }),lastCollection: async () => assert.fail('history read'),saveState: async () => assert.fail('write') };
  assert.equal((await runScheduleGate(options({ client }))).reason,'SLOT_ALREADY_CLAIMED');
  await assert.rejects(runScheduleGate(options({ env: { ...env,GITHUB_REF: 'refs/heads/other' },client })));
});
test('GitHub读取只接受明确404为空，拒绝坏JSON和受限响应，固定仓库且禁止重定向', async () => {
  const make = status => scheduleGitHubClient({ token: 'private-token',branch: 'master',fetchImpl: async (url,opts) => {
    assert.ok(url.startsWith('https://api.github.com/repos/w1121188104w-hue/paper-daily/contents/')); assert.equal(opts.redirect,'error');
    return new Response('withheld',{ status });
  } });
  assert.deepEqual((await make(404).readState()).state,emptyScheduleState());
  for (const status of [403,429,500]) await assert.rejects(make(status).readState(),/SCHEDULE_API_ERROR/);
  await assert.rejects(make(200).readState(),/SCHEDULE_INVALID_JSON/);
});
test('内容接口预约采用文件SHA并且不强制写入，409竞争失败不重试', async () => {
  let calls = 0;
  const client = scheduleGitHubClient({ token: 'private-token',branch: 'master',fetchImpl: async (url,opts) => {
    calls++; const body = JSON.parse(opts.body); assert.equal(body.sha,'b'.repeat(40)); assert.equal(body.branch,'master'); assert.equal(body.force,undefined);
    assert.deepEqual(JSON.parse(Buffer.from(body.content,'base64').toString()),emptyScheduleState()); return new Response('{}',{ status: 409 });
  } });
  await assert.rejects(client.saveState(emptyScheduleState(),'b'.repeat(40)),/SCHEDULE_CONCURRENT_CHANGE/); assert.equal(calls,1);
});
test('已有手动采集识别读取哈希保护的真实月度日志，不把网页显示时间当启动时间', async () => {
  const logs = [{ started_at: '2026-09-12T03:45:14.693Z' }];
  const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const logRef = { path: 'snapshots/20260912-test/runs/2026-09.json',sha256: hash(logs),count: 1 };
  const manifest = { runs: { '2026-09': logRef } };
  const pointer = { manifest: { path: 'snapshots/20260912-test/manifest.json',sha256: hash(manifest) } };
  const client = scheduleGitHubClient({ token: 'private-token',branch: 'master',fetchImpl: async url => fakeResponse(jsonFile(
    url.includes('/current.json') ? pointer : url.includes('/manifest.json') ? manifest : logs)) });
  assert.equal(await client.lastCollection(date('2026-09-12T04:00:00Z')),logs[0].started_at);
  pointer.manifest.sha256 = 'b'.repeat(64);
  await assert.rejects(client.lastCollection(date('2026-09-12T04:00:00Z')),/SCHEDULE_HISTORY_HASH_MISMATCH/);
});
test('轻量工作流无安装/采集/AI，正式流程只在放行后启动，时区和两个业务时段独立', async () => {
  const workflow = JSON.parse(await fs.readFile(new URL('../.github/workflows/daily-collect.yml',import.meta.url),'utf8'));
  assert.deepEqual(workflow.on.schedule,[{ cron: SCHEDULE_WAKE_CRON,timezone: 'Asia/Shanghai' }]);
  const gate = workflow.jobs.check_schedule;
  assert.equal(gate.timeout_minutes,undefined); assert.equal(gate['timeout-minutes'],5);
  assert.equal(gate.steps[0].with['persist-credentials'],false);
  assert.ok(!JSON.stringify(gate).includes('DEEPSEEK')); assert.ok(!JSON.stringify(gate).includes('npm ci'));
  assert.ok(!JSON.stringify(gate).includes('SEMANTIC_SCHOLAR'));
  assert.equal(workflow.jobs.collect.needs,'check_schedule'); assert.ok(workflow.jobs.collect.if.includes("run_collection == 'true'"));
  assert.equal(workflow.concurrency.group,'journal-production'); assert.equal(workflow.on.push,undefined);
});
