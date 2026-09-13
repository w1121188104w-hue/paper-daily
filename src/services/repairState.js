import { assertLibrary, isObject, isIsoTime, isCount, stableJson } from './libraryValidation.js';
import { repairRequirements } from './masterList.js';

export const REPAIR_STATUSES = ['pending', 'resolved', 'not_found', 'quota_exhausted', 'access_restricted', 'source_unavailable', 'identity_conflict'];
const PROVIDERS = ['crossref', 'openalex', 'semanticscholar', 'publisher', 'zhipu', 'serpapi_scholar', 'serpapi_google'];
export const emptyRepairState = () => ({ schema_version: 1, issues: {} });

export function validateRepairState(state, papers) {
  assertLibrary(isObject(state) && state.schema_version === 1 && isObject(state.issues) &&
    Object.keys(state).every(key => ['schema_version', 'issues'].includes(key)), '自动待办状态结构无效');
  const known = new Map(papers.map(paper => [paper.id, paper.journal_key]));
  for (const [id, issue] of Object.entries(state.issues)) {
    assertLibrary(/^issue:[a-f0-9]{64}$/.test(id) && issue.id === id && known.get(issue.paper_id) === issue.journal_key &&
      ['doi', 'authors', 'publication_month', 'abstract', 'identity', 'classification'].includes(issue.field) &&
      /^(missing_(doi|authors|publication_month|abstract)|title_conflict|possible_duplicate|publication_month_conflict|single_source_confirmation|document_type_uncertain)$/.test(issue.reason) &&
      /^[a-f0-9]{64}$/.test(issue.input_hash) && REPAIR_STATUSES.includes(issue.status) &&
      isIsoTime(issue.created_at) && isIsoTime(issue.updated_at) && Date.parse(issue.updated_at) >= Date.parse(issue.created_at) &&
      isCount(issue.attempt_count) && Array.isArray(issue.attempts) && issue.attempts.length <= issue.attempt_count &&
      (issue.next_retry_at === null || isIsoTime(issue.next_retry_at)) &&
      (issue.resolved_at === null || isIsoTime(issue.resolved_at)), '自动待办条目无效');
    assertLibrary((issue.status === 'resolved') === Boolean(issue.resolved_at) &&
      (!['quota_exhausted', 'not_found', 'access_restricted', 'source_unavailable', 'identity_conflict'].includes(issue.status) ||
        (isIsoTime(issue.next_retry_at) && Date.parse(issue.next_retry_at) > Date.parse(issue.updated_at))), '待办状态与重试时间不一致');
    for (const attempt of issue.attempts) {
      assertLibrary(isObject(attempt) && PROVIDERS.includes(attempt.source) && REPAIR_STATUSES.includes(attempt.status) &&
        isIsoTime(attempt.checked_at) && /^[a-f0-9]{64}$/.test(attempt.input_hash) &&
        Object.keys(attempt).every(key => ['source', 'status', 'checked_at', 'input_hash'].includes(key)), '待办尝试记录无效');
    }
  }
  return state;
}

// Reconcile after every saved operation: closing a repaired field never reopens other fields.
// Resolved confirmations remain cached while their identity fingerprint is unchanged.
export function reconcileRepairState(previous, master) {
  const state = structuredClone(previous || emptyRepairState()), now = master.generated_at;
  const requirements = repairRequirements(master), active = new Set(requirements.map(row => row.id));
  for (const item of requirements) {
    const old = state.issues[item.id];
    if (!old) state.issues[item.id] = { ...item, status: 'pending', created_at: now, updated_at: now,
      attempt_count: 0, attempts: [], next_retry_at: null, resolved_at: null };
    else if (old.input_hash !== item.input_hash || (old.status === 'resolved' && item.reason !== 'single_source_confirmation')) {
      state.issues[item.id] = { ...old, ...item, status: 'pending', updated_at: now, next_retry_at: null, resolved_at: null };
    }
  }
  for (const issue of Object.values(state.issues)) if (!active.has(issue.id) && issue.status !== 'resolved') {
    issue.status = 'resolved'; issue.updated_at = now; issue.resolved_at = now; issue.next_retry_at = null;
  }
  return state;
}

export function dueRepairIssues(state, now = new Date(), { limit = 100 } = {}) {
  assertLibrary(Number.isInteger(limit) && limit >= 0 && limit <= 10000 && Number.isFinite(now.getTime()), '自动待办查询参数无效');
  const priority = issue => ['identity', 'doi', 'classification', 'authors', 'publication_month', 'abstract'].indexOf(issue.field);
  return Object.values(state.issues).filter(issue => issue.status !== 'resolved' &&
    (!issue.next_retry_at || Date.parse(issue.next_retry_at) <= now.getTime()))
    .sort((a, b) => a.attempt_count - b.attempt_count || priority(a) - priority(b) ||
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).slice(0, limit);
}

export function recordRepairAttempt(state, id, { source, status, checkedAt, quotaResetsAt = null }) {
  assertLibrary(isObject(state.issues[id]) && PROVIDERS.includes(source) && REPAIR_STATUSES.includes(status) &&
    !['pending', 'resolved'].includes(status) && isIsoTime(checkedAt), '自动待办尝试参数无效');
  const next = structuredClone(state), issue = next.issues[id];
  assertLibrary(Date.parse(checkedAt) >= Date.parse(issue.updated_at), '自动待办时间不能倒退');
  if (status === 'quota_exhausted') assertLibrary(isIsoTime(quotaResetsAt) && Date.parse(quotaResetsAt) > Date.parse(checkedAt), '额度耗尽必须记录真实的未来重置时间');
  issue.attempt_count++;
  issue.attempts.push({ source, status, checked_at: checkedAt, input_hash: issue.input_hash });
  // Older attempts remain in immutable history; the current working queue keeps the latest 50.
  issue.attempts = issue.attempts.slice(-50);
  issue.status = status; issue.updated_at = checkedAt; issue.resolved_at = null;
  issue.next_retry_at = status === 'quota_exhausted' ? quotaResetsAt :
    new Date(Date.parse(checkedAt) + [1, 3, 7, 14, 30][Math.min(issue.attempt_count - 1, 4)] * 86400000).toISOString();
  return next;
}

export function repairSummary(state) {
  const open = Object.values(state.issues).filter(issue => issue.status !== 'resolved');
  return { unresolved_papers: new Set(open.map(issue => issue.paper_id)).size, unresolved_issues: open.length,
    by_status: Object.fromEntries(REPAIR_STATUSES.filter(status => status !== 'resolved').map(status => [status, open.filter(issue => issue.status === status).length])) };
}

export function validateRepairProjection(state, master) {
  assertLibrary(stableJson(reconcileRepairState(state, master)) === stableJson(state), '自动待办与总名册不一致');
}
