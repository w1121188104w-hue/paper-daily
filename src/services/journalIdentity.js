import { isValidIssn } from './journals.js';

export function canonicalIssn(value) {
  const text = String(value || '').trim().toUpperCase().replaceAll('-', '');
  if (!isValidIssn(text)) return null;
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

// A print/electronic pair belongs to one configured journal, never two name aliases.
export function journalIdentity(journal) {
  const issns = [...new Set([journal.print_issn, journal.electronic_issn].map(canonicalIssn).filter(Boolean))];
  if (!issns.length) throw new Error('期刊缺少有效ISSN');
  return { id: `issn:${canonicalIssn(journal.print_issn) || issns[0]}`, issns };
}

export function matchesJournalIssn(values, journal) {
  const expected = journalIdentity(journal).issns;
  return values.some(value => expected.includes(canonicalIssn(value)));
}

// Independently verified correction, not a DOI-prefix whitelist for all JAR papers.
// S2 erroneously attaches JAR's 0021-8456 venue object to this unrelated journal.
export function knownJournalMismatch(paper) {
  if (paper.journal_key === 'JAR' && /^10\.67983\/journaldialectica\./i.test(paper.doi || '')) {
    return { reason: 'verified_wrong_journal', actual_journal: 'Journal Dialectica (Journal of Accounting Research)',
      actual_issn: '3163-821X', expected_issns: ['0021-8456', '1475-679X'],
      evidence_url: 'https://garuda.kemdiktisaintek.go.id/journal/view/47732',
      target_url: 'https://onlinelibrary.wiley.com/journal/1475679x' };
  }
  return null;
}
