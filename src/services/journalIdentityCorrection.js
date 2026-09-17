import { assertLibrary, stableJson } from './libraryValidation.js';
import { knownJournalMismatch } from './journalIdentity.js';

// The user's 2026-09-17 deletion authorization covers these five verified
// misimports only, not arbitrary missing abstracts or future ambiguous records.
export const APPROVED_JAR_REMOVALS = Object.freeze(['100', '106', '109', '64', '65']
  .map(suffix => `10.67983/journaldialectica.v1i2.${suffix}`));

export function journalIdentityCorrection(previous) {
  const removed = previous.papers.filter(p => p.journal_key === 'JAR' && APPROVED_JAR_REMOVALS.includes(p.doi))
    .map(p => ({ paper_id: p.id, doi: p.doi, journal_key: p.journal_key, evidence: knownJournalMismatch(p) }));
  const ids = new Set(removed.map(r => r.paper_id));
  const papers = previous.papers.filter(p => !ids.has(p.id));
  const enrichmentState = { ...previous.enrichmentState,
    abstracts: Object.fromEntries(Object.entries(previous.enrichmentState.abstracts).filter(([id]) => !ids.has(id))) };
  return { papers, removed, enrichmentState };
}

export function validateJournalIdentityCorrection(previous, papers, report, enrichmentState) {
  const expected = journalIdentityCorrection(previous);
  assertLibrary(expected.removed.length > 0 && stableJson(report.removed) === stableJson(expected.removed) &&
    stableJson(papers) === stableJson(expected.papers) && report.stats.removed === expected.removed.length &&
    stableJson(enrichmentState) === stableJson(expected.enrichmentState), '错刊删除仅限用户确认的五个DOI，其余记录与状态必须原样保留');
}
