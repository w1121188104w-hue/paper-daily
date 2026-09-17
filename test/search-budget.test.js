import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySearchBudget, safeSerpAccount, searchAllowance, reserveSearchRequest, settleSearchRequest, makeBudgetedSearch } from '../src/services/searchBudget.js';

const at = '2026-09-12T01:00:00.000Z', now = () => new Date(at);
const raw = { account_status: 'Active', plan_monthly_price: 0, searches_per_month: 250, plan_searches_left: 250,
  this_month_usage: 0, extra_credits: 0, plan_renewal_date: '2026-10-12', api_key: 'never-retain-secret', account_email: 'private@example.com' };
const account = patch => safeSerpAccount({ ...raw, ...patch }, at);
const options = (patch = {}) => ({ provider: 'serpapi_scholar', query: 'Paper title', taskId: 'paper1-doi', now: now(), account: account(), ...patch });

test('搜索额度：账户投影不保留密钥和邮箱，付费套餐/额外付费额度拒绝', () => {
  assert.equal(JSON.stringify(account()).includes('never-retain-secret'), false); assert.equal(JSON.stringify(account()).includes('private@'), false);
  for (const patch of [{ plan_monthly_price: 25 }, { searches_per_month: 1000 }, { extra_credits: 1 }, { plan_searches_left: 251 }, { account_status: 'Disabled' }]) assert.throws(() => account(patch));
});

test('搜索额度：没有新鲜账户确认时禁止SerpAPI，没有单独预算时禁止智谱', () => {
  assert.equal(searchAllowance(emptySearchBudget(), { provider: 'serpapi_google', now: now() }).reason, 'account_unverified');
  assert.equal(searchAllowance(emptySearchBudget(), { provider: 'serpapi_google', now: new Date('2026-09-12T01:02:00Z'), account: account() }).reason, 'account_unverified');
  assert.equal(searchAllowance(emptySearchBudget(), { provider: 'zhipu', now: now() }).reason, 'budget_not_configured');
});

test('搜索额度：Scholar和Google共用250上限，不因换引擎而翻倍', () => {
  let state = emptySearchBudget();
  for (let i = 0; i < 250; i++) state = reserveSearchRequest(state, options({ taskId: `task-${i}` })).state;
  const blocked = reserveSearchRequest(state, options({ provider: 'serpapi_google', taskId: 'last' }));
  assert.equal(blocked.allowed, false); assert.equal(blocked.reason, 'quota_exhausted'); assert.equal(state.requests.length, 250);
});

test('搜索额度：账户被其他程序用尽、本地未达250也必须停', () => {
  const remaining = account({ plan_searches_left: 0, this_month_usage: 250 });
  assert.equal(searchAllowance(emptySearchBudget(), options({ account: remaining })).reason, 'quota_exhausted');
});

test('搜索额度：跨自然月不擅自刷新尚未重置的官方免费周期', () => {
  let state = emptySearchBudget();
  for (let i = 0; i < 250; i++) state = reserveSearchRequest(state, options({ taskId: `task-${i}` })).state;
  const next = '2026-10-01T01:00:00.000Z';
  assert.equal(searchAllowance(state, options({ now: new Date(next), account: safeSerpAccount(raw, next) })).reason, 'quota_exhausted');
});

test('搜索额度：成功空结果也计费；明确免费缓存可释放预占', () => {
  const reserved = reserveSearchRequest(emptySearchBudget(), options());
  const billed = settleSearchRequest(reserved.state, reserved.reservation.id, { status: 'succeeded', charged: 1, now: now() });
  assert.equal(searchAllowance(billed, options()).local_used, 1);
  const free = settleSearchRequest(reserved.state, reserved.reservation.id, { status: 'succeeded', charged: 0, now: now() });
  assert.equal(searchAllowance(free, options()).local_used, 0);
});

test('搜索额度：网络断线计费未知不能释放，也不能重复请求同一任务', () => {
  const reserved = reserveSearchRequest(emptySearchBudget(), options());
  const unknown = settleSearchRequest(reserved.state, reserved.reservation.id, { status: 'unknown', charged: null, now: now() });
  assert.equal(searchAllowance(unknown, options()).local_used, 1);
  assert.equal(reserveSearchRequest(unknown, options()).reason, 'request_outcome_unknown');
  assert.throws(() => settleSearchRequest(reserved.state, reserved.reservation.id, { status: 'unknown', charged: 0, now: now() }));
});

test('搜索额度：未知结果冷却后可以自动重试，但旧预占仍保留，不能永久要求人工解锁', () => {
  const reserved = reserveSearchRequest(emptySearchBudget(), options());
  const state = settleSearchRequest(reserved.state, reserved.reservation.id, { status: 'unknown', charged: null, now: now() });
  const tomorrow = '2026-09-13T01:00:00.000Z';
  const retried = reserveSearchRequest(state, options({ now: new Date(tomorrow), account: safeSerpAccount(raw, tomorrow) }));
  assert.equal(retried.allowed, true); assert.equal(retried.state.requests.length, 2);
  assert.equal(retried.state.requests[0].charged, null);
});

test('搜索额度：先落盘再请求，保存失败不得调用收费服务', async () => {
  const events = [];
  const search = makeBudgetedSearch({ now, persist: async state => events.push(state.requests.at(-1).status),
    request: async () => { events.push('request'); return { charged: 1, leads: [] }; } });
  await search.run(options()); assert.deepEqual(events, ['reserved', 'request', 'succeeded']);
  let calls = 0;
  const failed = makeBudgetedSearch({ now, persist: async () => { throw new Error('checkpoint failed'); }, request: async () => calls++ });
  await assert.rejects(failed.run(options())); assert.equal(calls, 0);
});

test('安全诊断不改变记账：失败仍占额度、不重试，原始错误不进入日志或账本', async () => {
  const persisted = []; let calls = 0;
  const search = makeBudgetedSearch({ now, persist: async state => persisted.push(structuredClone(state)), request: async () => {
    calls++; throw Object.assign(new Error('private-secret'), { code: 'RATE_LIMITED', http_status: 429, provider_error_code: '1113', api_key: 'private-secret' });
  } });
  const opts = options({ provider: 'zhipu', zhipuMonthlyLimit: 2000 });
  const result = await search.run(opts);
  assert.deepEqual(result.diagnostic, { code: 'RATE_LIMITED', http_status: 429, provider_error_code: '1113' });
  assert.equal(result.reason, 'request_outcome_unknown');
  assert.deepEqual(persisted.map(state => state.requests.at(-1).status), ['reserved', 'unknown']);
  assert.equal(search.state().requests[0].charged, null); assert.equal(searchAllowance(search.state(), opts).local_used, 1);
  assert.equal((await search.run(opts)).called, false); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify({ result, persisted }), /private-secret/);
});

test('搜索额度：只剩一次时两个并行调用只有一个能发出', async () => {
  let calls = 0;
  const last = account({ plan_searches_left: 1, this_month_usage: 249 });
  const search = makeBudgetedSearch({ now, persist: async () => {}, request: async () => { calls++; return { charged: 1 }; } });
  const outputs = await Promise.all([search.run(options({ account: last, taskId: 'first' })), search.run(options({ account: last, taskId: 'second' }))]);
  assert.equal(calls, 1); assert.equal(outputs[1].called, false);
});

test('搜索额度：智谱单独计数与硬上限，不消耗SerpAPI名额', async () => {
  const search = makeBudgetedSearch({ now, persist: async () => {}, request: async () => ({ charged: 1 }) });
  assert.equal((await search.run(options({ provider: 'zhipu', zhipuMonthlyLimit: 1 }))).called, true);
  assert.equal((await search.run(options({ provider: 'zhipu', zhipuMonthlyLimit: 1, taskId: 'next' }))).reason, 'quota_exhausted');
  assert.equal(searchAllowance(search.state(), options()).local_used, 0);
});

test('智谱1113欠费后同轮新查询及排队请求都停止，未知占额不释放，SerpAPI仍按原免费规则', async () => {
  const calls = [], persisted = [];
  const search = makeBudgetedSearch({ now, persist: async state => persisted.push(structuredClone(state)), request: async o => {
    calls.push(o.provider);
    if (o.provider === 'zhipu') throw Object.assign(new Error('redacted'), { code: 'RATE_LIMITED', http_status: 429, provider_error_code: '1113' });
    return { charged: 1, leads: [] };
  } });
  const opts = options({ provider: 'zhipu', zhipuMonthlyLimit: null });
  const results = await Promise.all([0, 1, 2].map(i => search.run({ ...opts, query: `Different query ${i}`, taskId: `different-${i}` })));
  assert.equal(results[0].called, true);
  for (const row of results.slice(1)) { assert.equal(row.called, false); assert.equal(row.reason, 'provider_payment_required'); }
  assert.deepEqual(calls, ['zhipu']); assert.equal(search.state().requests.length, 1);
  assert.equal(search.state().requests[0].charged, null); assert.equal(persisted.length, 2);
  assert.equal((await search.run(options())).called, true);
  assert.deepEqual(calls, ['zhipu', 'serpapi_scholar']);
  assert.equal((await search.run(options({ provider: 'serpapi_google', taskId: 'free-exhausted', account: account({ plan_searches_left: 0, this_month_usage: 250 }) }))).reason, 'quota_exhausted');
  let recoveredCalls = 0;
  const recovered = makeBudgetedSearch({ now, initialState: search.state(), persist: async () => {}, request: async () => { recoveredCalls++; return { charged: 1 }; } });
  assert.equal((await recovered.run({ ...opts, query: 'New query after account recovery', taskId: 'recovered' })).called, true);
  assert.equal(recoveredCalls, 1); assert.equal(recovered.state().requests[0].charged, null);
});

test('普通智谱429不是欠费，不错误禁止本轮其他查询', async () => {
  let calls = 0;
  const search = makeBudgetedSearch({ now, persist: async () => {}, request: async () => {
    if (++calls === 1) throw Object.assign(new Error('rate'), { code: 'RATE_LIMITED', http_status: 429, provider_error_code: '1302' });
    return { charged: 1 };
  } });
  const opts = options({ provider: 'zhipu', zhipuMonthlyLimit: 2000 });
  await search.run(opts);
  assert.equal((await search.run({ ...opts, query: 'Another query', taskId: 'another' })).called, true);
  assert.equal(calls, 2);
});
