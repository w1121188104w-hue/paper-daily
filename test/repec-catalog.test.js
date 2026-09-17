import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { repecCatalogUrl, parseRepecCatalog, repecCatalogCandidates, prioritizeRepecCatalogPapers } from '../src/services/repecCatalog.js';
import { makeEnrichmentSources } from '../src/services/enrichmentSources.js';
import { parseRepecAbstract } from '../src/services/repecAbstract.js';
import { evidenceHash, EvidenceError } from '../src/services/evidenceHttp.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { repairPaperMetadata } from '../src/services/searchMetadata.js';
import { validateMetadataRepairOnlyChange } from '../src/services/metadataRepairValidation.js';
import { buildMasterList } from '../src/services/masterList.js';

const journal = findJournal(await loadJournalConfig(), 'JFE');
const at = '2026-09-18T01:00:00.000Z', doi = '10.1016/j.jfineco.2026.fixture';
const title = 'Liquidity regulation and banks: Evidence from firm data';
const abstract = 'We study liquidity regulation using a detailed panel of banks and firms. Our findings document changes in lending and liquidity provision following regulatory reforms.';
const articleUrl = 'https://ideas.repec.org/a/eee/jfinec/v183y2026ics0304405x26000001.html';
const expected = { doi, title_original: title, authors: [{ name: 'Alice Smith' }] };
const response = (body, url) => ({ body, url, fetched_at: at, sha256: evidenceHash(body) });
const link = (text = title, url = articleUrl) => `<li class="list-group-item"><b>S000 <a href="${url}">${text}</a></b></li>`;
const catalog = (links = link()) => response(`<h1>Elsevier</h1><h1>${journal.name}</h1><b>ISSN:</b> ${journal.print_issn}<br><ul>${links}</ul>`, repecCatalogUrl(journal));
function article(patch = {}, url = articleUrl) {
  const fields = { handle: 'RePEc:eee:jfinec:fixture', DOI: doi, citation_title: title, citation_journal_title: journal.name,
    citation_type: 'redif-article', citation_authors: 'Smith, Alice', citation_abstract: abstract, ...patch };
  return response(Object.entries(fields).map(([name, content]) => `<meta name="${name}" content="${content}">`).join('') +
    `<div id="abstract-body">${abstract}</div>`, url);
}
const missing = async () => { throw new EvidenceError('NOT_FOUND'); };

test('RePEc目录核对期刊名及ISSN，只取本期刊文章路径，去重且不读取目录摘要', () => {
  const links = link() + link() + link(title, articleUrl.replace('/a/', '/p/')) +
    link(title, articleUrl.replace('/jfinec/', '/respol/')) + link(title, articleUrl + '?token=x') +
    link(title, articleUrl.replace('ideas.repec.org', 'example.com'));
  const rows = parseRepecCatalog(catalog(links), journal);
  assert.deepEqual(rows, [{ title, url: articleUrl }]);
  for (const r of [ { ...catalog(), url: repecCatalogUrl(journal) + '?view=other' },
    { ...catalog(), body: catalog().body.replace(journal.print_issn, '0000-0000') },
    { ...catalog(), body: catalog().body.replace(journal.name, 'Wrong journal') },
    { ...catalog(), body: catalog().body + `<b>ISSN:</b> 0000-0000<br>` } ]) {
    assert.throws(() => parseRepecCatalog(r, journal), /UNVERIFIED_IDENTITY/);
  }
  assert.equal(repecCatalogUrl({ key: 'CAR' }), null);
  assert.throws(() => parseRepecCatalog(catalog(), { key: 'CAR' }));
});

test('RePEc目录标题标准化仅产生线索，无DOI不查；同名候选最多三篇不直接合并', () => {
  const rows = parseRepecCatalog(catalog(Array.from({ length: 5 }, (_, i) => link(title.toUpperCase().replace(':', ' — '), articleUrl.replace('.html', `-${i}.html`))).join('')), journal);
  assert.equal(rows.length, 5);
  assert.equal(repecCatalogCandidates(rows, expected).length, 3);
  assert.deepEqual(repecCatalogCandidates(rows, { ...expected, doi: '' }), []);
  assert.deepEqual(repecCatalogCandidates(rows, { ...expected, title_original: title + ' and another study' }), []);
});

test('目录每轮每刊只读一次，文章必须独立通过DOI、标题、作者和双处原始摘要核验', async () => {
  const calls = [], source = makeEnrichmentSources({ request: async (url, hosts) => {
    assert.deepEqual(hosts, ['ideas.repec.org']); calls.push(url);
    return url === repecCatalogUrl(journal) ? catalog() : article();
  } });
  assert.equal(await source.repecCatalogHasMatch(expected, journal), true);
  for (let i = 0; i < 2; i++) {
    const record = await source.repecCatalogArticle(expected, journal);
    assert.equal(record.abstract, abstract); assert.equal(record.source, 'repec');
    assert.equal(record.source_evidence.method, 'repec_journal_abstract');
  }
  assert.equal(calls.filter(url => url === repecCatalogUrl(journal)).length, 1);
  assert.equal(calls.filter(url => url === articleUrl).length, 2);
});

test('目录线索仅调整缺摘要批次顺序，不删除任何论文、不修改原始字段', async () => {
  const papers = ['absent', 'available', 'limited'].map(id => ({ ...expected, id, journal_key: 'JFE' }));
  papers.push({ ...papers[0], id: 'no-doi', doi: '' }, { ...papers[0], id: 'unsupported', journal_key: 'CAR' });
  const original = structuredClone(papers), calls = [];
  const result = await prioritizeRepecCatalogPapers(papers, { journalFor: key => ({ ...journal, key }), sources: {
    repecCatalogHasMatch: async p => { calls.push(p.id); if (p.id === 'limited') throw new EvidenceError('RATE_LIMITED'); return p.id === 'available'; }
  } });
  assert.deepEqual(result.map(p => p.id), ['available', 'absent', 'limited', 'no-doi', 'unsupported']);
  assert.deepEqual(calls, ['absent', 'available', 'limited']); assert.deepEqual(papers, original);
  assert.deepEqual(await prioritizeRepecCatalogPapers(papers, { sources: {}, journalFor: () => assert.fail() }), papers);
});

test('目录优先排队遵守截止时间；存储失败不掩盖，未尝试记录不丢失', async () => {
  const papers = ['one', 'two'].map(id => ({ ...expected, id, journal_key: 'JFE' }));
  let calls = 0;
  const options = { journalFor: () => journal, sources: { repecCatalogHasMatch: async () => { calls++; return true; } } };
  assert.deepEqual(await prioritizeRepecCatalogPapers(papers, { ...options, shouldContinue: () => calls === 0 }), papers);
  assert.equal(calls, 1);
  await assert.rejects(prioritizeRepecCatalogPapers(papers, { ...options, sources: {
    repecCatalogHasMatch: async () => { throw new EvidenceError('EVIDENCE_STORAGE_ERROR'); }
  } }), /EVIDENCE_STORAGE_ERROR/);
});

test('同名但DOI错误的文章不收，继续核验下一个；最多读取三条候选', async () => {
  const urls = Array.from({ length: 4 }, (_, i) => articleUrl.replace('.html', `-${i}.html`));
  let calls = 0;
  const source = makeEnrichmentSources({ request: async url => {
    if (url === repecCatalogUrl(journal)) return catalog(urls.map(u => link(title, u)).join(''));
    calls++; return article({ DOI: calls === 2 ? doi : '10.1016/wrong' }, url);
  } });
  assert.equal((await source.repecCatalogArticle(expected, journal)).doi, doi); assert.equal(calls, 2);
  calls = 0;
  const allWrong = makeEnrichmentSources({ request: async url => {
    if (url === repecCatalogUrl(journal)) return catalog(urls.map(u => link(title, u)).join(''));
    calls++; return article({ DOI: '10.1016/wrong' }, url);
  } });
  await assert.rejects(allWrong.repecCatalogArticle(expected, journal), /UNVERIFIED_IDENTITY/);
  assert.equal(calls, 3);
});

test('目录失败或空清单也缓存；限流不继续读文章，不支持期刊及无DOI不联网', async () => {
  for (const failure of [true, false]) {
    let calls = 0;
    const source = makeEnrichmentSources({ request: async () => { calls++; if (failure) throw new EvidenceError('RATE_LIMITED'); return catalog(''); } });
    for (let i = 0; i < 2; i++) await assert.rejects(source.repecCatalogArticle(expected, journal), failure ? /RATE_LIMITED/ : /NOT_FOUND/);
    assert.equal(calls, 1);
    await assert.rejects(source.repecCatalogArticle({ ...expected, doi: '' }, journal), /NO_REPEC_CATALOG/);
    await assert.rejects(source.repecCatalogArticle(expected, { key: 'CAR' }), /NO_REPEC_CATALOG/);
    assert.equal(calls, 1);
  }
});

test('目录补全在智谱前执行，保留原文来源、不冒充第四发现源；找不到仍进入智谱', async () => {
  const record = parseRepecAbstract(article(), journal, expected);
  const old = mergePapers([{ ...record, source: 'crossref', source_id: doi, source_evidence: undefined, abstract: '', raw_abstract: '' }],
    { firstSeenDate: '2026-09-18', checkedAt: at }).papers[0];
  const sources = { crossref: missing, openalex: missing, semanticscholar: missing, publisherArticle: missing,
    repecCatalogArticle: async () => record };
  const result = await repairPaperMetadata(old, journal, { sources, fields: ['abstract'], search: () => assert.fail('No paid search needed') });
  assert.equal(result.paper.abstract_original, abstract);
  assert.equal(result.paper.abstract_zh, ''); assert.equal(result.paper.abstract_translation_status, 'pending');
  validateMetadataRepairOnlyChange([old], [result.paper]);
  assert.deepEqual(buildMasterList([result.paper], { generatedAt: at, policyVersion: 5 }).entries[0].discovery_sources, ['crossref']);
  assert.ok(result.attempts.some(a => a.source === 'repec' && a.stage === 'journal_catalog' && a.status === 'filled'));
  const providers = [];
  const fallback = await repairPaperMetadata(old, journal, { sources: { ...sources, repecCatalogArticle: missing }, fields: ['abstract'],
    search: async ({ provider }) => { providers.push(provider); return { called: true, result: { leads: [] } }; } });
  assert.equal(providers[0], 'zhipu'); assert.equal(fallback.paper.abstract_original, '');
  await repairPaperMetadata(result.paper, journal, { sources: { ...sources, repecCatalogArticle: () => assert.fail('Complete paper must not be searched') }, fields: ['abstract'] });
  await assert.rejects(repairPaperMetadata(old, journal, { sources: { ...sources,
    repecCatalogArticle: async () => { throw new EvidenceError('EVIDENCE_STORAGE_ERROR'); } }, fields: ['abstract'] }), /EVIDENCE_STORAGE_ERROR/);
});
