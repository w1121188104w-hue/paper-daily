import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { publisherRecord } from '../src/services/publisherParsers.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { titleConsensusFor, isSingleTitleTransposition } from '../src/services/titleConsensus.js';
import { repairPaperMetadata } from '../src/services/searchMetadata.js';
import { validateMetadataRepairOnlyChange } from '../src/services/metadataRepairValidation.js';
import { buildMasterList } from '../src/services/masterList.js';
import { metadataRepairIssue } from '../src/services/metadataRepairRun.js';
import { runMetadataRepair } from '../src/services/metadataRepairRun.js';
import { runCatalogDiscovery } from '../src/services/catalogDiscoveryRun.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const journal = findJournal(await loadJournalConfig(), 'QJE');
const at = '2026-09-14T08:00:00.000Z', doi = '10.1093/qje/qjag027';
const original = 'The Power of Proximity to Coworkres*', corrected = 'The Power of Proximity to Coworkers';
const url = 'https://academic.oup.com/qje/article/141/3/1/1234567';
const anchor = publisherRecord({ title: original, doi, url, authors: [], date: '',
  abstract: 'We investigate how proximity to coworkers affects learning and productivity using detailed evidence from employees working in different locations.',
  journal_confirmed: true, evidence: { url: 'https://academic.oup.com/rss/site_5504/3365.xml',
    scope_url: 'https://academic.oup.com/rss/site_5504/3365.xml', method: 'publisher_rss', fetched_at: at, body_sha256: 'a'.repeat(64) } }, journal);
function api(source) {
  const endpoint = source === 'crossref' ? `https://api.crossref.org/works/${encodeURIComponent(doi)}` : `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`;
  return normalizeSourceRecord({ ...anchor, source, source_id: source === 'crossref' ? doi : 'W123456789', title: corrected,
    authors: ['Natalia Emanuel', 'Emma Harrington', 'Amanda Pallais'], publication_date: '2026-05-12',
    source_evidence: { url: endpoint, scope_url: endpoint, method: `${source}_api`, fetched_at: at, body_sha256: 'b'.repeat(64) } });
}
function paper() {
  const p = mergePapers([anchor], { firstSeenDate: '2026-09-14', checkedAt: at }).papers[0];
  p.title_zh = '已有译文'; p.title_translation_status = 'done'; return p;
}
const absent = () => assert.fail('No further source or paid search should be called');

test('仅接受长标题中一个长单词的相邻字母对调', () => {
  assert.ok(isSingleTitleTransposition(original, corrected));
  for (const [a, b] of [['Short wrods', 'Short words'], [original, corrected + ' and productivity'],
    ['The Power of Proximity to Workers', corrected], ['The impact of policy in 2025', 'The impact of policy in 2052']]) {
    assert.equal(isSingleTitleTransposition(a, b), false);
  }
});

test('官网证据与两API的DOI、作者、月份、期刊一致才形成可重演证明', () => {
  assert.ok(titleConsensusFor(paper(), [api('crossref'), api('openalex')]));
  assert.equal(titleConsensusFor(paper(), [api('crossref')]), null);
  assert.equal(titleConsensusFor(paper(), [api('crossref'), api('crossref')]), null);
  const mutations = [r => { r.doi = '10.1093/qje/other'; }, r => { r.journal_key = 'AER'; },
    r => { r.authors[0].name = 'Another Person'; }, r => { r.publication_date = '2025-05-12'; },
    r => { r.print_issn = ''; r.electronic_issn = ''; }, r => { r.source_id = 'invalid'; },
    r => { r.title = corrected + ' Evidence'; }, r => { r.source_evidence.body_sha256 = ''; },
    r => { r.source_evidence.method = 'unverified'; }, r => { r.source_evidence.url = 'https://example.com/'; },
    r => { r.source_evidence.url += '?key=untrusted'; }, r => { r.source_evidence.scope_url += '/other'; }];
  for (const mutate of mutations) { const r = api('openalex'); mutate(r); assert.equal(titleConsensusFor(paper(), [api('crossref'), r]), null); }
  const p = paper(); p.source_records[0].source_evidence.url = 'https://example.com/feed';
  assert.equal(titleConsensusFor(p, [api('crossref'), api('openalex')]), null);
  const cr = api('crossref'), oa = api('openalex'); cr.authors[0].orcid = '0000-0001'; oa.authors[0].orcid = '0000-0002';
  assert.equal(titleConsensusFor(paper(), [cr, oa]), null);
});

test('端到端补齐作者月份而不改标题译文；保存两份原始证据，禁止单份证据冒充共识', async () => {
  const before = paper(), calls = [];
  const result = await repairPaperMetadata(before, journal, { sources: {
    crossref: async () => { calls.push('crossref'); return api('crossref'); },
    openalex: async () => { calls.push('openalex'); return api('openalex'); }, semanticscholar: absent, publisherArticle: absent }, search: absent });
  assert.equal(result.status, 'resolved'); assert.deepEqual(calls, ['crossref', 'openalex']);
  assert.equal(result.paper.authors.length, 3); assert.equal(result.paper.publication_date, '2026-05-12');
  for (const field of ['id', 'discovered_at', 'title_original', 'title_zh', 'abstract_original', 'abstract_zh']) assert.equal(result.paper[field], before[field]);
  assert.equal(result.paper.source_records.length, 3); assert.equal(result.identity_resolution.status, 'corroborated_minor_typo');
  validateMetadataRepairOnlyChange([before], [result.paper]);
  const broken = structuredClone(result.paper); broken.source_records.pop();
  assert.throws(() => validateMetadataRepairOnlyChange([before], [broken]));
  const changed = structuredClone(result.paper); changed.title_original = corrected;
  assert.throws(() => validateMetadataRepairOnlyChange([before], [changed]));
  for (const version of [1, 2, 3]) {
    const master = buildMasterList([result.paper], { generatedAt: at, policyVersion: version });
    assert.equal(master.entries[0].conflicts.includes('title_conflict'), version < 3);
    assert.equal(master.entries[0].title, original);
  }
});

test('自动队列处理标题冲突和单源确认，未实现的重复合并不能冒充字段补齐', () => {
  assert.ok(metadataRepairIssue({ field: 'identity', reason: 'title_conflict' }));
  assert.equal(metadataRepairIssue({ field: 'identity', reason: 'single_source_confirmation' }), true);
  assert.equal(metadataRepairIssue({ field: 'identity', reason: 'possible_duplicate' }), false);
});

test('真实保存路径：证据可重读、标题冲突自动关闭、再次运行不联网', async t => {
  const config = await loadJournalConfig(), parent = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'title-consensus-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), parent); assert.ok(path.basename(root).startsWith('title-consensus-test-')); await fs.rm(root, { recursive: true, force: true }); });
  await runCatalogDiscovery(config, { root, journalKey: 'QJE', now: () => new Date(at), http: { request: absent },
    discover: async () => ({ leads: [{ title: original, doi, url, authors: [], date: '', abstract: anchor.abstract,
      journal_confirmed: true, evidence: anchor.source_evidence }], attempts: [] }),
    search: async () => ({ called: false, reason: 'quota_exhausted' }) });
  const before = await readJournalLibrary({ root, config });
  const sources = { crossref: async () => api('crossref'), openalex: async () => api('openalex'), semanticscholar: absent, publisherArticle: absent };
  const result = await runMetadataRepair(config, { root, journalKey: 'QJE', now: () => new Date(at), sources, search: absent });
  assert.equal(result.status, 'success');
  const after = await readJournalLibrary({ root, config });
  assert.equal(after.papers[0].id, before.papers[0].id);
  assert.equal(after.papers[0].source_records.length, 3);
  assert.equal(after.masterList.entries[0].identity_resolution.status, 'corroborated_minor_typo');
  assert.ok(Object.values(after.repairState.issues).every(issue => issue.status === 'resolved'));
  const repeat = await runMetadataRepair(config, { root, journalKey: 'QJE', now: () => new Date(at),
    sources: { crossref: absent, openalex: absent, semanticscholar: absent, publisherArticle: absent }, search: absent });
  assert.equal(repeat.status, 'skipped');
});
