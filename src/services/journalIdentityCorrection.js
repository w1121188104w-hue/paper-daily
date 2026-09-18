import { assertLibrary, stableJson } from './libraryValidation.js';
import { knownJournalMismatch } from './journalIdentity.js';

// Version 1 remains the exact historical five-JAR authorization. Version 2 adds
// only the IAEME DOI explicitly approved on 2026-09-18; no blanket removal.
export const APPROVED_JAR_REMOVALS = Object.freeze(['100', '106', '109', '64', '65']
  .map(suffix => `10.67983/journaldialectica.v1i2.${suffix}`));

export const APPROVED_JM_REMOVAL = '10.34218/jom_13_02_005';
export function journalIdentityCorrection(previous, { policyVersion = 2 } = {}) {
  assertLibrary([1, 2].includes(policyVersion), '不支持的错刊删除授权版本');
  const removed = previous.papers.filter(p => (p.journal_key === 'JAR' && APPROVED_JAR_REMOVALS.includes(p.doi)) ||
    (policyVersion >= 2 && p.journal_key === 'JM' && p.doi === APPROVED_JM_REMOVAL))
    .map(p => ({ paper_id: p.id, doi: p.doi, journal_key: p.journal_key, evidence: knownJournalMismatch(p) }));
  const ids = new Set(removed.map(r => r.paper_id));
  const papers = previous.papers.filter(p => !ids.has(p.id));
  const enrichmentState = { ...previous.enrichmentState,
    abstracts: Object.fromEntries(Object.entries(previous.enrichmentState.abstracts).filter(([id]) => !ids.has(id))) };
  return { papers, removed, enrichmentState };
}

export function validateJournalIdentityCorrection(previous, papers, report, enrichmentState) {
  const expected = journalIdentityCorrection(previous, { policyVersion: report.removal_policy_version ?? 1 });
  assertLibrary(expected.removed.length > 0 && stableJson(report.removed) === stableJson(expected.removed) &&
    stableJson(papers) === stableJson(expected.papers) && report.stats.removed === expected.removed.length &&
    stableJson(enrichmentState) === stableJson(expected.enrichmentState), '错刊删除仅限该版本用户明确确认的DOI，其余记录与状态必须原样保留');
}
