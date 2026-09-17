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

// Exact records checked against both the DOI registrant metadata and the
// publisher, not a blanket ban on a publisher/prefix or on missing abstracts.
const VERIFIED_OTHER_SERIES_BOOKS = new Set([
  '10.1007/978-3-032-11327-6', '10.1007/978-3-032-25831-1', '10.1007/978-3-032-29056-4'
]);

// Independently verified correction, not a DOI-prefix whitelist for all JAR papers.
// S2 erroneously attaches JAR's 0021-8456 venue object to this unrelated journal.
export function knownJournalMismatch(paper) {
  const doi = String(paper.doi || '').trim().toLowerCase();
  if (paper.journal_key === 'RP' && VERIFIED_OTHER_SERIES_BOOKS.has(doi)) {
    return { reason: 'verified_wrong_journal', actual_journal: 'Research for Policy (book series)',
      actual_issn: '2662-3684', expected_issns: ['0048-7333', '1873-7625'],
      evidence_url: `https://link.springer.com/book/${doi}`,
      target_url: 'https://www.sciencedirect.com/journal/research-policy' };
  }
  if (paper.journal_key === 'JM' && doi === '10.34218/jom_13_02_005') {
    return { reason: 'verified_wrong_journal', actual_journal: 'Journal of Management (IAEME)',
      actual_issn: '2347-3940', expected_issns: ['0149-2063', '1557-1211'],
      evidence_url: 'https://iaeme.com/Home/article_id/JOM_13_02_005',
      target_url: 'https://journals.sagepub.com/home/jom' };
  }
  if (paper.journal_key === 'JAR' && /^10\.67983\/journaldialectica\./i.test(paper.doi || '')) {
    return { reason: 'verified_wrong_journal', actual_journal: 'Journal Dialectica (Journal of Accounting Research)',
      actual_issn: '3163-821X', expected_issns: ['0021-8456', '1475-679X'],
      evidence_url: 'https://garuda.kemdiktisaintek.go.id/journal/view/47732',
      target_url: 'https://onlinelibrary.wiley.com/journal/1475679x' };
  }
  return null;
}
