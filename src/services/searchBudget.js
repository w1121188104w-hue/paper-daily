import { createHash, randomUUID } from 'node:crypto';
import { assertLibrary, isCount, isIsoTime, isObject } from './libraryValidation.js';
import { dateInShanghai } from './paperMerge.js';
import { safeSearchDiagnostic } from './searchDiagnostics.js';

export const SERPAPI_MONTHLY_LIMIT = 250;
const providers = ['zhipu', 'serpapi_scholar', 'serpapi_google'];
const statuses = ['reserved', 'succeeded', 'failed', 'unknown'];
const digest = value => createHash('sha256').update(value).digest('hex');
export const emptySearchBudget = () => ({ schema_version: 1, requests: [] });
const serp = provider => provider.startsWith('serpapi_');
const monthAt = now => dateInShanghai(now).slice(0, 7);

export function validateSearchBudget(state) {
  assertLibrary(isObject(state) && state.schema_version === 1 && Array.isArray(state.requests) &&
    Object.keys(state).every(key => ['schema_version', 'requests'].includes(key)), '搜索额度账本无效');
  const ids = new Set();
  for (const request of state.requests) {
    assertLibrary(isObject(request) && typeof request.id === 'string' && /^[a-zA-Z0-9-]{10,80}$/.test(request.id) && !ids.has(request.id) &&
      providers.includes(request.provider) && statuses.includes(request.status) &&
      /^[a-f0-9]{64}$/.test(request.query_hash) && /^[a-f0-9]{64}$/.test(request.task_hash) &&
      isIsoTime(request.reserved_at) && request.month === monthAt(new Date(request.reserved_at)) &&
      (request.finished_at === null || (isIsoTime(request.finished_at) && Date.parse(request.finished_at) >= Date.parse(request.reserved_at))) &&
      [null, 0, 1].includes(request.charged) &&
      (serp(request.provider) ? typeof request.billing_cycle === 'string' && /^\d{4}-\d{2}-\d{2}/.test(request.billing_cycle) : request.billing_cycle === null) &&
      Object.keys(request).every(key => ['id', 'provider', 'query_hash', 'task_hash', 'reserved_at', 'finished_at', 'month', 'billing_cycle', 'status', 'charged'].includes(key)), '搜索额度条目无效');
    assertLibrary(request.status === 'reserved' ? request.finished_at === null && request.charged === null : Boolean(request.finished_at), '搜索额度结算状态无效');
    ids.add(request.id);
  }
  return state;
}

// Only this allowlisted projection may be kept from /account.json: its raw response echoes the API key.
export function safeSerpAccountDiagnostics(data, checkedAt) {
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000 ? value : null;
  const renewal = data?.plan_renewal_date;
  let verified = false;
  try { safeSerpAccount(data, checkedAt); verified = true; } catch { /* Report safe shape diagnostics, never raw account output. */ }
  return { verified_free_account: verified,
    account_status: ['Active', 'Inactive', 'Suspended', 'Disabled'].includes(data?.account_status) ? data.account_status : 'unknown',
    plan_monthly_price: number(data?.plan_monthly_price), monthly_limit: number(data?.searches_per_month),
    remaining: number(data?.plan_searches_left), used: number(data?.this_month_usage), extra_credits: number(data?.extra_credits),
    renewal_format: renewal == null ? 'missing' : /^\d{4}-\d{2}-\d{2}$/.test(renewal) ? 'date_only' :
      /^\d{4}-\d{2}-\d{2}T/.test(renewal) ? 'iso' : /^\d{4}-\d{2}-\d{2} /.test(renewal) ? 'space_separated' : 'unknown',
    renewal_parseable: typeof renewal === 'string' && /^\d{4}-\d{2}-\d{2}/.test(renewal) && Number.isFinite(Date.parse(renewal)),
    renewal_is_future: typeof renewal === 'string' && /^\d{4}-\d{2}-\d{2}/.test(renewal) && Date.parse(renewal) > Date.parse(checkedAt) };
}
export function safeSerpAccount(data, checkedAt) {
  assertLibrary(isIsoTime(checkedAt) && isObject(data) && data.account_status === 'Active' && data.plan_monthly_price === 0 &&
    isCount(data.searches_per_month) && data.searches_per_month > 0 && data.searches_per_month <= SERPAPI_MONTHLY_LIMIT &&
    isCount(data.plan_searches_left) && data.plan_searches_left <= data.searches_per_month &&
    isCount(data.this_month_usage) && data.this_month_usage <= data.searches_per_month &&
    data.extra_credits === 0 && typeof data.plan_renewal_date === 'string' &&
    /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(data.plan_renewal_date) && Number.isFinite(Date.parse(data.plan_renewal_date)), '无法确认SerpAPI为免费方案或账户额度无效');
  return { checked_at: checkedAt, monthly_limit: data.searches_per_month, remaining: data.plan_searches_left,
    used: data.this_month_usage, renewal_date: data.plan_renewal_date, free_plan: true };
}

export function searchAllowance(state, { provider, now = new Date(), account = null, zhipuMonthlyLimit = 0 } = {}) {
  validateSearchBudget(state);
  assertLibrary(providers.includes(provider) && Number.isFinite(now.getTime()) && (zhipuMonthlyLimit === null || isCount(zhipuMonthlyLimit)), '搜索额度查询参数无效');
  const requests = state.requests.filter(request => serp(provider) ? serp(request.provider) : request.provider === provider);
  const counted = request => request.charged === 0 ? 0 : 1; // Uncertain billing always stays reserved.
  const localUsed = requests.filter(request => request.month === monthAt(now)).reduce((sum, request) => sum + counted(request), 0);
  const limit = serp(provider) ? SERPAPI_MONTHLY_LIMIT : zhipuMonthlyLimit;
  if (!serp(provider) && limit === null) return { allowed: true, reason: null, remaining: null, local_used: localUsed, limit: null };
  if (!limit) return { allowed: false, reason: 'budget_not_configured', remaining: 0, local_used: localUsed, limit };
  if (serp(provider)) {
    if (!account || account.free_plan !== true || !isIsoTime(account.checked_at) ||
        now.getTime() < Date.parse(account.checked_at) || now.getTime() - Date.parse(account.checked_at) > 60000 ||
        !isCount(account.remaining) || !isCount(account.used) || !isCount(account.monthly_limit) ||
        account.monthly_limit < 1 || account.monthly_limit > SERPAPI_MONTHLY_LIMIT || account.remaining > account.monthly_limit ||
        account.used > account.monthly_limit || !Number.isFinite(Date.parse(account.renewal_date))) {
      return { allowed: false, reason: 'account_unverified', remaining: 0, local_used: localUsed, limit };
    }
    const cycleRequests = requests.filter(request => request.billing_cycle === account.renewal_date);
    // Account usage can be shared with other programs. Add unsettled reservations conservatively;
    // double-reserving is safer than guessing that a request has not been billed.
    const unsettled = cycleRequests.filter(request => request.charged === null).length;
    const completedSinceSnapshot = cycleRequests.filter(request => request.charged === 1 &&
      Date.parse(request.finished_at) >= Date.parse(account.checked_at)).length;
    const cycleUsed = cycleRequests.reduce((sum, request) => sum + counted(request), 0);
    const remaining = Math.max(0, Math.min(limit - localUsed, account.remaining - unsettled - completedSinceSnapshot,
      account.monthly_limit - account.used - unsettled - completedSinceSnapshot, account.monthly_limit - cycleUsed));
    return { allowed: remaining > 0, reason: remaining ? null : 'quota_exhausted', remaining, local_used: localUsed,
      account_used: account.used, limit, renewal_date: account.renewal_date };
  }
  const remaining = Math.max(0, limit - localUsed);
  return { allowed: remaining > 0, reason: remaining ? null : 'quota_exhausted', remaining, local_used: localUsed, limit };
}

export function reserveSearchRequest(state, { provider, query, taskId, now = new Date(), account, zhipuMonthlyLimit = 0 } = {}) {
  assertLibrary(typeof query === 'string' && query.trim() && query.length <= 2000 &&
    typeof taskId === 'string' && taskId.trim() && taskId.length <= 500, '搜索请求身份无效');
  const allowance = searchAllowance(state, { provider, now, account, zhipuMonthlyLimit });
  if (!allowance.allowed) return { state, reservation: null, ...allowance };
  const queryHash = digest(query), taskHash = digest(taskId);
  if (state.requests.some(request => request.provider === provider && request.query_hash === queryHash &&
      request.task_hash === taskHash && ['reserved', 'unknown'].includes(request.status) &&
      now.getTime() - Date.parse(request.reserved_at) < 86400000)) {
    return { state, reservation: null, allowed: false, reason: 'request_outcome_unknown' };
  }
  const reservation = { id: randomUUID(), provider, query_hash: queryHash, task_hash: taskHash,
    reserved_at: now.toISOString(), finished_at: null, month: monthAt(now),
    billing_cycle: serp(provider) ? account.renewal_date : null, status: 'reserved', charged: null };
  const next = { schema_version: 1, requests: [...state.requests, reservation] };
  validateSearchBudget(next);
  return { ...allowance, state: next, reservation };
}

export function settleSearchRequest(state, id, { status, charged, now = new Date() }) {
  validateSearchBudget(state);
  const next = structuredClone(state), request = next.requests.find(row => row.id === id);
  assertLibrary(request && request.status === 'reserved' && ['succeeded', 'failed', 'unknown'].includes(status) &&
    [0, 1, null].includes(charged) && Number.isFinite(now.getTime()) && now.getTime() >= Date.parse(request.reserved_at), '搜索结算参数无效');
  assertLibrary(status !== 'unknown' || charged === null, '未知请求结果不能释放额度');
  request.status = status; request.charged = charged; request.finished_at = now.toISOString();
  validateSearchBudget(next); return next;
}

/** Serial within a run. Caller MUST hold the shared writer lock and durably checkpoint to
 * the production remote before calling request; failures leave the reservation held. */
export function makeBudgetedSearch({ initialState = emptySearchBudget(), persist, request, now = () => new Date() }) {
  assertLibrary(typeof persist === 'function' && typeof request === 'function', '收费搜索必须提供持久化检查点');
  let state = structuredClone(validateSearchBudget(initialState)), tail = Promise.resolve();
  let zhipuPaymentDiagnostic = null;
  return {
    state: () => structuredClone(state),
    run(options) {
      const perform = async () => {
        // 1113 is account payment failure, NOT a transient rate limit. Stop
        // new Zhipu queries in this run without erasing uncertain reservations
        // or blocking independent providers. A new run may check again after
        // the account is funded; never recharge or change a plan automatically.
        if (options.provider === 'zhipu' && zhipuPaymentDiagnostic)
          return { called: false, reason: 'provider_payment_required', diagnostic: { ...zhipuPaymentDiagnostic } };
        const reserved = reserveSearchRequest(state, { ...options, now: now() });
        if (!reserved.reservation) return { called: false, reason: reserved.reason };
        await persist(reserved.state); state = reserved.state; // Before ANY billable network request.
        let result;
        try { result = await request(options); }
        catch (error) {
          const uncertain = settleSearchRequest(state, reserved.reservation.id, { status: 'unknown', charged: null, now: now() });
          await persist(uncertain); state = uncertain;
          const diagnostic = safeSearchDiagnostic(error, options.provider);
          if (options.provider === 'zhipu' && diagnostic.provider_error_code === '1113') zhipuPaymentDiagnostic = diagnostic;
          return { called: true, status: 'source_unavailable', reason: 'request_outcome_unknown',
            diagnostic };
        }
        assertLibrary(result && [null, 0, 1].includes(result.charged), '搜索计费结果无法核实');
        const settled = settleSearchRequest(state, reserved.reservation.id, { status: 'succeeded', charged: result.charged, now: now() });
        await persist(settled); state = settled;
        return { called: true, result };
      };
      const pending = tail.then(perform); tail = pending.catch(() => {}); return pending;
    }
  };
}
