import test from 'node:test';
import assert from 'node:assert/strict';
import { knownJournalMismatch } from '../src/services/journalIdentity.js';
import { semanticScholarJournalMatches } from '../src/services/semanticScholar.js';
import { journalIdentityCorrection, validateJournalIdentityCorrection } from '../src/services/journalIdentityCorrection.js';
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

test('历史v1/v2授权保留原范围；v3删除已确认三条错收丛书，不再隔离', () => {
  const papers = cases.map(([journal_key, doi]) => ({ id: `doi:${doi}`, journal_key, doi }));
  const previous = { papers, enrichmentState: { abstracts: Object.fromEntries(papers.map(p => [p.id, { status: 'missing' }])) } };
  const result = journalIdentityCorrection(previous, { policyVersion: 1 });
  assert.deepEqual(result.papers, papers);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.enrichmentState, previous.enrichmentState);
  const current = journalIdentityCorrection(previous, { policyVersion: 2 });
  assert.deepEqual(current.removed.map(p => p.doi), ['10.34218/jom_13_02_005']);
  assert.deepEqual(current.papers, papers.filter(p => p.journal_key !== 'JM'));
  assert.ok(!Object.hasOwn(current.enrichmentState.abstracts, 'doi:10.34218/jom_13_02_005'));
  const latest = journalIdentityCorrection(previous);
  assert.equal(latest.removed.length, 4);
  assert.deepEqual(latest.papers, []);
  assert.deepEqual(latest.enrichmentState.abstracts, {});
  const report = { removal_policy_version: 3, removed: latest.removed, stats: { removed: 4 } };
  assert.doesNotThrow(() => validateJournalIdentityCorrection(previous, [], report, latest.enrichmentState));
  assert.throws(() => validateJournalIdentityCorrection(previous, [], { ...report, removal_policy_version: 2 }, latest.enrichmentState));
});

test('错刊删除不扩展到未知同前缀记录、其他期刊归属或缺摘要论文；重复执行不再删除', () => {
  const papers = [['RP', '10.1007/978-3-032-11327-6'], ['RP', '10.1007/978-3-032-99999-9'],
    ['JIBS', '10.1007/978-3-032-11327-6'], ['RP', '10.1016/j.respol.2026.105588']]
    .map(([journal_key, doi], i) => ({ id: String(i), journal_key, doi, abstract_original: '' }));
  const previous = { papers, enrichmentState: { abstracts: { '0': { status: 'missing' }, '1': { status: 'missing' } } } };
  const result = journalIdentityCorrection(previous);
  assert.deepEqual(result.papers, papers.slice(1));
  assert.deepEqual(result.enrichmentState.abstracts, { '1': { status: 'missing' } });
  assert.deepEqual(journalIdentityCorrection(result).removed, []);
  assert.throws(() => validateJournalIdentityCorrection(previous, [],
    { removal_policy_version: 3, removed: result.removed, stats: { removed: 1 } }, result.enrichmentState));
});

test('旧JAR删除快照即使同时含IAEME也仍按v1验证，不扩大历史授权；新授权不能删除其他记录', () => {
  const previous = { papers: [{ id: 'jar', doi: '10.67983/journaldialectica.v1i2.100', journal_key: 'JAR' },
    { id: 'jm', doi: '10.34218/jom_13_02_005', journal_key: 'JM' },
    { id: 'good', doi: '10.1177/01492063260000000', journal_key: 'JM' }], enrichmentState: { abstracts: {} } };
  const old = journalIdentityCorrection(previous, { policyVersion: 1 });
  const report = { removed: old.removed, stats: { removed: 1 } };
  assert.doesNotThrow(() => validateJournalIdentityCorrection(previous, old.papers, report, old.enrichmentState));
  const next = journalIdentityCorrection(previous), current = { removal_policy_version: 2, removed: next.removed, stats: { removed: 2 } };
  assert.doesNotThrow(() => validateJournalIdentityCorrection(previous, next.papers, current, next.enrichmentState));
  assert.throws(() => validateJournalIdentityCorrection(previous, [], current, next.enrichmentState));
  assert.throws(() => validateJournalIdentityCorrection(previous, next.papers, report, next.enrichmentState));
});
