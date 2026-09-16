import { mergeConfirmedDuplicate } from './duplicateMerge.js';
import { assertLibrary, isIsoTime, stableJson } from './libraryValidation.js';

/** Deterministic archival transaction: only the supplied verified identities may
 * leave the active list. Complete before-images are retained in the report. */
export function applyDuplicateResolutions(papers, claims, checkedAt) {
  assertLibrary(Array.isArray(claims) && claims.length > 0 && isIsoTime(checkedAt), '归并事务参数无效');
  const active = new Map(papers.map(paper => [paper.id, structuredClone(paper)])), merges = [];
  const seen = new Set();
  for (const claim of claims) {
    assertLibrary(claim && !seen.has(claim.original_id) && claim.original_id !== claim.target_id, '重复的归并原记录');
    seen.add(claim.original_id);
    const original = active.get(claim.original_id), target = active.get(claim.target_id);
    assertLibrary(original && target, '归并身份不在当前名册中');
    const result = mergeConfirmedDuplicate(original, target, claim.record, checkedAt);
    // The active paper now represents both discoveries; the before-images retain
    // each record's original timestamp, including legacy day-only precision.
    result.target.first_seen_date = result.resolution.first_seen_date;
    if (result.resolution.discovered_at) result.target.discovered_at = result.resolution.discovered_at;
    else delete result.target.discovered_at;
    merges.push({ original: result.archived, target_before: structuredClone(target), resolution: result.resolution });
    active.set(target.id, result.target); active.delete(original.id);
  }
  return { papers: [...active.values()].sort((a, b) => a.id.localeCompare(b.id)), merges };
}

export function duplicateWorkingState(previous, papers) {
  const ids = new Set(papers.map(paper => paper.id));
  const entries = Object.entries(previous.enrichmentState.abstracts);
  return { enrichmentState: { ...structuredClone(previous.enrichmentState), abstracts: Object.fromEntries(entries.filter(([id]) => ids.has(id))) },
    archived_abstract_state: Object.fromEntries(entries.filter(([id]) => !ids.has(id))),
    archived_issues: Object.values(previous.repairState.issues).filter(issue => !ids.has(issue.paper_id)).sort((a, b) => a.id.localeCompare(b.id)) };
}

export function validateDuplicateState(previous, papers, report, enrichmentState) {
  const expected = duplicateWorkingState(previous, papers);
  assertLibrary(stableJson(expected.enrichmentState) === stableJson(enrichmentState) &&
    stableJson(expected.archived_issues) === stableJson(report.archived_issues) &&
    stableJson(expected.archived_abstract_state) === stableJson(report.archived_abstract_state), '归并只能归档原记录待办，不能篡改其他重试状态');
}

export function validateDuplicateTransition(previous, next, report) {
  assertLibrary(report?.stage === 'duplicate_resolution' && Array.isArray(report.merges) && report.merges.length > 0 &&
    isIsoTime(report.checked_at), '归并报告缺少可重演证据');
  const claims = report.merges.map(merge => ({ original_id: merge.resolution?.original_id,
    target_id: merge.resolution?.target_id, record: merge.resolution?.evidence }));
  const replayed = applyDuplicateResolutions(previous, claims, report.checked_at);
  assertLibrary(stableJson(replayed.merges) === stableJson(report.merges) &&
    stableJson(replayed.papers) === stableJson([...next].sort((a, b) => a.id.localeCompare(b.id))), '归并记录或结果不能由父版本证据重现');
  assertLibrary(report.stats?.merged === claims.length && previous.length - next.length === claims.length, '归并数量与名册不一致');
  return replayed;
}
