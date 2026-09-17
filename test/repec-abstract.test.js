import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { parseRepecAbstract, supportedRepecUrl, repecJournalUrl } from '../src/services/repecAbstract.js';
import { evidenceHash } from '../src/services/evidenceHttp.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { repairPaperMetadata } from '../src/services/searchMetadata.js';
import { validateMetadataRepairOnlyChange } from '../src/services/metadataRepairValidation.js';
import { buildMasterList } from '../src/services/masterList.js';
const journal = findJournal(await loadJournalConfig(), 'JPE');
const at = '2026-09-14T13:00:00.000Z', doi = '10.1086/740222';
const title = 'Do Mergers and Acquisitions Improve Efficiency? Evidence from Power Plants';
const abstract = 'We investigate changes in firm productivity following acquisitions using detailed records of output and ownership transitions across markets.';
const url = 'https://ideas.repec.org/a/ucp/jpolec/doi10.1086-740222.html';
const expected = { doi, title_original: title, authors: [{ name: 'Mert Demirer' }] };
function response(patch = {}) {
  const fields = { handle: `RePEc:ucp:jpolec:doi:${doi}`, citation_title: title, citation_journal_title: journal.name,
    citation_type: 'redif-article', citation_publisher: 'University of Chicago Press', citation_authors: 'Mert Demirer; Ömer Karaduman', citation_abstract: abstract, ...patch };
  const body = Object.entries(fields).map(([name, content]) => `<meta name="${name}" content="${content}">`).join('') + `<div id="abstract-body">${abstract}</div>`;
  return { body, url, fetched_at: at, sha256: evidenceHash(body) };
}
test('RePEc仅正式JPE记录，核对DOI标题期刊及双处原始摘要，不接受工作论文', () => {
  assert.equal(repecJournalUrl(doi, journal), url);
  assert.equal(repecJournalUrl('10.1234/other', journal), null);
  assert.equal(repecJournalUrl(doi, { key: 'QJE' }), null);
  const record = parseRepecAbstract(response(), journal, expected);
  assert.equal(record.source, 'repec'); assert.equal(record.abstract, abstract); assert.equal(record.publication_date, '');
  for (const patch of [{ handle: 'RePEc:other:doi:10.1086/740222' }, { citation_title: 'Similar paper' },
    { citation_journal_title: 'Another Journal' }, { citation_abstract: 'Invented summary' }, { citation_authors: 'Other Person' },
    { citation_type: 'redif-paper' }, { citation_publisher: 'Unknown' }]) assert.throws(() => parseRepecAbstract(response(patch), journal, expected));
  for (const value of [url.replace('/a/', '/p/'), url + '?token=secret', url.replace('ideas.repec.org', 'example.com')]) assert.equal(supportedRepecUrl(value, journal), false);
  assert.throws(() => parseRepecAbstract(response(), journal, { ...expected, doi: '10.1086/999999' }));
});
test('先直接核验RePEc原文补摘要，不消耗搜索，保留来源且不冒充独立发现', async () => {
  const record = parseRepecAbstract(response(), journal, expected);
  const old = mergePapers([{ ...record, source: 'crossref', source_id: doi, source_evidence: undefined, abstract: '', raw_abstract: '' }], { firstSeenDate: '2026-09-14', checkedAt: at }).papers[0];
  const absent = async () => { throw Object.assign(new Error(), { code: 'NOT_FOUND' }); };
  let calls = 0;
  const result = await repairPaperMetadata(old, journal, { sources: { crossref: absent, openalex: absent, semanticscholar: absent,
    repecArticle: async () => record, publisherArticle: absent }, fields: ['abstract'], search: async ({ provider }) => {
      assert.equal(provider, 'zhipu'); calls++; return { called: true, result: { leads: [
        ...Array.from({ length: 11 }, () => ({ url: 'https://example.com/irrelevant' })), { url, snippet: 'Invented summary' }] } };
    } });
  assert.equal(result.status, 'resolved'); assert.equal(calls, 0); assert.equal(result.paper.abstract_original, abstract);
  assert.equal(result.paper.abstract_zh, ''); assert.equal(result.paper.abstract_translation_status, 'pending');
  validateMetadataRepairOnlyChange([old], [result.paper]);
  const entry = buildMasterList([result.paper], { generatedAt: at, policyVersion: 3 }).entries[0];
  assert.equal(entry.abstract_source, 'repec'); assert.equal(entry.abstract_source_url, url);
  assert.deepEqual(entry.discovery_sources, ['crossref']);
  let repecCalls = 0;
  const retried = await repairPaperMetadata(old, journal, { sources: { crossref: absent, openalex: absent, semanticscholar: absent,
    publisherArticle: absent, repecArticle: async () => { if (++repecCalls === 1) return absent(); return record; } }, fields: ['abstract'],
    search: async () => ({ called: true, result: { leads: [...Array.from({ length: 11 }, () => ({ url: 'https://example.com/irrelevant' })), { url }] } }) });
  assert.equal(retried.status, 'resolved'); assert.equal(repecCalls, 2);
  assert.equal(retried.attempts.find(a => a.source === 'zhipu').leads_checked, 12);
});
