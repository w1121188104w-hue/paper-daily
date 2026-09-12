import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SCHEDULE_STATE_PATH, emptyScheduleState, validateScheduleState, planJournalSchedule, claimScheduleSlot } from '../src/services/journalSchedule.js';

const REPOSITORY = 'w1121188104w-hue/paper-daily';
const fail = code => { throw new Error(code); };

export function scheduleGitHubClient({ token, branch, fetchImpl = fetch } = {}) {
  if (!token || branch !== 'master') fail('INVALID_SCHEDULE_CONFIGURATION');
  async function request(relative, { method = 'GET', body, missing = false } = {}) {
    let response;
    try { response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/${relative}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'paper-daily-schedule', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { fail('SCHEDULE_NETWORK_ERROR'); }
    if (missing && response.status === 404) return null;
    if (!response.ok) fail(response.status === 409 || response.status === 422 ? 'SCHEDULE_CONCURRENT_CHANGE' : 'SCHEDULE_API_ERROR');
    try { return await response.json(); } catch { fail('SCHEDULE_INVALID_JSON'); }
  }
  function contentsUrl(file) {
    if (!/^data\/[A-Za-z0-9_./-]+\.json$/.test(file) || file.includes('..')) fail('INVALID_SCHEDULE_PATH');
    return `contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${branch}`;
  }
  async function readFile(file, { missing = false, sha256 } = {}) {
    const value = await request(contentsUrl(file), { missing });
    if (value === null) return null;
    if (value.type !== 'file' || value.encoding !== 'base64' || typeof value.content !== 'string' ||
      !Number.isSafeInteger(value.size) || value.size < 0 || value.size > 1024*1024 || !/^[a-f0-9]{40}$/.test(value.sha || '')) fail('SCHEDULE_INVALID_FILE');
    const bytes = Buffer.from(value.content,'base64');
    if (bytes.length !== value.size) fail('SCHEDULE_INVALID_FILE');
    if (sha256 && createHash('sha256').update(bytes).digest('hex') !== sha256) fail('SCHEDULE_HISTORY_HASH_MISMATCH');
    try { return { value: JSON.parse(bytes.toString('utf8')), sha: value.sha }; } catch { fail('SCHEDULE_INVALID_JSON'); }
  }
  async function readRef(ref) {
    if (!ref || !/^snapshots\/[A-Za-z0-9-]+\/[A-Za-z0-9_./-]+\.json$/.test(ref.path || '') || !/^[a-f0-9]{64}$/.test(ref.sha256 || '')) fail('SCHEDULE_INVALID_HISTORY_REF');
    return (await readFile(`data/journal-store/${ref.path}`,{ sha256: ref.sha256 })).value;
  }
  return {
    async readState() {
      const result = await readFile(SCHEDULE_STATE_PATH,{ missing: true });
      return { state: result ? validateScheduleState(result.value) : emptyScheduleState(), sha: result?.sha };
    },
    async lastCollection(now) {
      const pointer = await readFile('data/journal-store/current.json',{ missing: true });
      if (!pointer) return null;
      const manifest = await readRef(pointer.value.manifest);
      if (!manifest.runs || typeof manifest.runs !== 'object') fail('SCHEDULE_INVALID_HISTORY');
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{ timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(now).map(p => [p.type,p.value]));
      const month = `${parts.year}-${parts.month}`;
      const ref = manifest.runs[month];
      if (!ref) return null;
      const runs = await readRef(ref);
      if (!Array.isArray(runs) || runs.length !== ref.count) fail('SCHEDULE_INVALID_HISTORY');
      return runs.map(r => r.started_at).sort().at(-1) || null;
    },
    async saveState(state, sha) {
      validateScheduleState(state);
      return request(`contents/${SCHEDULE_STATE_PATH}`,{ method: 'PUT', body: {
        branch, message: 'ops: reserve Beijing collection time slot', ...(sha ? { sha } : {}),
        content: Buffer.from(`${JSON.stringify(state,null,2)}\n`,'utf8').toString('base64') } });
    }
  };
}

export async function runScheduleGate({ now = () => new Date(), env = process.env, client,
  append = fs.appendFile, log = console.log } = {}) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== REPOSITORY || env.DATA_BRANCH !== 'master' ||
    env.GITHUB_REF !== 'refs/heads/master' || !['schedule','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
    !path.isAbsolute(env.GITHUB_OUTPUT || '') || env.JOURNAL_AUTOMATION_ENABLED !== 'true') fail('INVALID_SCHEDULE_ENVIRONMENT');
  const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.RESPECT_SCHEDULE !== 'true';
  let plan = planJournalSchedule({ now: now(), manual });
  if (plan.run && !manual) {
    client ||= scheduleGitHubClient({ token: env.GITHUB_TOKEN, branch: env.DATA_BRANCH });
    const { state, sha } = await client.readState();
    plan = planJournalSchedule({ now: now(), state });
    if (plan.run) plan = planJournalSchedule({ now: now(), state, lastCollectionAt: await client.lastCollection(now()) });
    if (plan.run) {
      // Checkpoint MUST succeed before releasing collection, including uncertain PUT failures.
      await client.saveState(claimScheduleSlot(state,plan,{ now: now(),runId: env.GITHUB_RUN_ID }),sha);
    }
  }
  await append(env.GITHUB_OUTPUT,`run_collection=${plan.run}\nreason=${plan.reason}\n`,'utf8');
  if (path.isAbsolute(env.GITHUB_STEP_SUMMARY || '')) await append(env.GITHUB_STEP_SUMMARY,
    `## 北京时间采集闸门\n\n实际检查：${now().toISOString()}（UTC）；目标时段：${plan.slot?.key || '无／手动'}。\n\n放行采集：${plan.run ? '是' : '否'}；原因：${plan.reason}；距目标时间：${plan.delay_minutes ?? '不适用'}分钟。\n\n轻量检查不调用文献来源或AI。时段预约不代表采集成功；实际结果见后续任务。GitHub仍不保证准点触发。\n`,'utf8');
  log(JSON.stringify({ ...plan, claimed_before_collection: plan.run && !manual }));
  return plan;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).join(' ') !== '--run') console.log('默认不联网、不修改状态。GitHub生产环境明确执行：node scripts/journal-schedule.js --run');
  else try { await runScheduleGate(); } catch { console.error('时间闸门未放行；请检查状态或连接。未输出凭据或远程错误正文。'); process.exitCode = 1; }
}
