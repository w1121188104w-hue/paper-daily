import test from 'node:test';
import assert from 'node:assert/strict';
import { knownJournalMismatch } from '../src/services/journalIdentity.js';
import { semanticScholarJournalMatches } from '../src/services/semanticScholar.js';
import { journalIdentityCorrection } from '../src/services/journalIdentityCorrection.js';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';

const cases = [
  ['RP', '10.1007/978-3-032-11327-6', '2662-3684'],
  ['RP', '10.1007/978-3-032-25831-1', '2662-3684'],
  ['RP', '10.1007/978-3-032-29056-4', '2662-3684'],
  ['JM', '10.34218/jom_13_02_005', '2347-3940']
];

test('独立核实的同名刊物及相似丛书不能因S2附上目标ISSN而再次入库', async () => {
  const config = await loadJournalConfig();
  for (const [key, doi, issn] of cases) {
    const journal = findJournal(config, key);
    const work = { externalIds: { DOI: doi.toUpperCase() }, journal: { name: journal.name },
      venue: journal.name, publicationVenue: { name: journal.name, type: 'journal', issn: journal.print_issn } };
    assert.equal(semanticScholarJournalMatches(work, journal), false);
    const evidence = knownJournalMismatch({ journal_key: key, doi });
    assert.equal(evidence.actual_issn, issn);
    assert.deepEqual(evidence.expected_issns, [journal.print_issn, journal.electronic_issn]);
    assert.ok(evidence.evidence_url.startsWith('https://'));
  }
});

test('错刊证据限定已核实DOI和归属，不扩大到同出版商、未知文章或缺摘要研究论文', () => {
  for (const [journal_key, doi] of [['RP', '10.1016/j.respol.2026.105588'],
    ['RP', '10.1007/978-3-032-99999-9'], ['JM', '10.1177/01492063260000000'],
    ['JM', '10.34218/jom_13_02_006'], ['JIBS', '10.1007/978-3-032-11327-6']])
    assert.equal(knownJournalMismatch({ journal_key, doi, abstract_original: '' }), null);
});

test('新确认错刊先隔离，不扩张此前五条JAR的实体删除许可，全部历史记录保留', () => {
  const papers = cases.map(([journal_key, doi]) => ({ id: `doi:${doi}`, journal_key, doi }));
  const previous = { papers, enrichmentState: { abstracts: Object.fromEntries(papers.map(p => [p.id, { status: 'missing' }])) } };
  const result = journalIdentityCorrection(previous);
  assert.deepEqual(result.papers, papers);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.enrichmentState, previous.enrichmentState);
});
