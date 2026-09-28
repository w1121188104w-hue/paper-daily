import test from 'node:test';
import assert from 'node:assert/strict';
import { originalAbstractSection, extractionEvidence, extractSearchRecord, verifiedSearchRecord } from '../src/services/searchExtraction.js';
import { searchWithFallback, abstractSearchQueries } from '../src/services/searchSources.js';
import { searchAllowance, emptySearchBudget } from '../src/services/searchBudget.js';
import { dueRepairIssues } from '../src/services/repairState.js';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';

const journal = findJournal(await loadJournalConfig(), 'AER');
const paper = { title_original: 'International trade and the allocation of resources', doi: '10.1257/example' };
const abstract = 'We study international trade using administrative firm data. We find that market access improves resource allocation and increases productivity across firms.';
const lead = { title: paper.title_original, url: 'https://www.aeaweb.org/articles?id=10.1257/example',
  content: `${paper.title_original}\nDOI: ${paper.doi}\nAbstract\n${abstract}\nKeywords: trade, productivity` };
const extracted = { record: { source_index: 0, title: paper.title_original, doi: paper.doi, abstract } };

test('有唯一完整检索原文时机械复制，不依赖模型改写；冲突、缺身份或只有片段时不采纳', () => {
  const at = '2026-09-17T01:00:00Z';
  assert.equal(verifiedSearchRecord([lead], paper, journal, at).abstract, abstract);
  assert.equal(verifiedSearchRecord([{ ...lead, content: '', snippet: abstract }], paper, journal, at), null);
  assert.equal(verifiedSearchRecord([{ ...lead, title: 'Wrong title', content: lead.content.replace(paper.title_original, 'Wrong title') }], paper, journal, at), null);
  const conflict = { ...lead, url: lead.url + '&view=full', content: lead.content.replace(abstract, abstract + ' Additional claim.') };
  assert.throws(() => verifiedSearchRecord([lead, conflict], paper, journal, at), /CONFLICTING_ABSTRACT_EVIDENCE/);
  assert.equal(verifiedSearchRecord([lead, { ...lead, url: lead.url + '&view=full' }], paper, journal, at).abstract, abstract);
});

test('长标题摘要检索：保留标题检索路径，不全部退化为DOI，查询均符合70字限制', () => {
  const item = { title_original: 'Can ChatGPT forecast stock price movements? Return predictability and large language models', doi: '10.1016/j.jfineco.2026.104335' };
  const before = structuredClone(item), queries = abstractSearchQueries(item, journal);
  assert.ok(queries.includes(item.doi));
  assert.ok(queries.some(q => q.startsWith('Can ChatGPT forecast stock price movements?') && !q.includes('site:')));
  assert.ok(queries.some(q => q.startsWith('Can ChatGPT') && q.endsWith('site:ideas.repec.org')));
  assert.ok(queries.every(q => [...q].length <= 70));
  assert.equal(queries.length, new Set(queries).size);
  assert.deepEqual(item, before);
  const unicode = abstractSearchQueries({ title: '😀研究'.repeat(50) }, journal);
  assert.ok(unicode.every(q => [...q].length <= 70));
});

test('摘要优先定向对应出版社：ScienceDirect不串到Wiley，长DOI不截断冒充完整DOI', async () => {
  const config = await loadJournalConfig();
  const expected = { JFE: 'sciencedirect.com', CAR: 'onlinelibrary.wiley.com', JPE: 'journals.uchicago.edu', QJE: 'academic.oup.com' };
  for (const [key, host] of Object.entries(expected)) {
    const queries = abstractSearchQueries(paper, findJournal(config, key));
    assert.equal(queries[0], `${paper.doi} site:${host}`);
    assert.ok(queries[1].endsWith(` site:${host}`));
    assert.ok(queries.some(q => !q.includes('site:')));
    assert.ok(queries.every(q => [...q].length <= 70));
    assert.equal(queries.length, new Set(queries).size);
  }
  const long = { ...paper, doi: '10.1234/' + 'x'.repeat(70) };
  const queries = abstractSearchQueries(long, findJournal(config, 'JFE'));
  assert.ok(queries[0].endsWith(' site:sciencedirect.com'));
  assert.ok(!queries.filter(q => q.includes('site:sciencedirect.com')).some(q => q.startsWith('10.1234/')));
});

test('智谱原文提取：只接受有完整边界的Abstract，不采纳摘要片段', () => {
  assert.equal(originalAbstractSection(lead.content), abstract);
  assert.equal(originalAbstractSection(`## Abstract\n${abstract}\n## Keywords: trade`), abstract);
  assert.equal(originalAbstractSection(`**Abstract**\n${abstract}\n**Keywords**: trade`), abstract);
  for (const text of [abstract, `Abstract ${abstract}`, `Abstract ${abstract}… Keywords: trade`,
    `Abstract We study... trade and resource allocation across firms and countries. Keywords: trade`]) assert.equal(originalAbstractSection(text), '');
});

test('出版社明确的语言标签和编号章节不污染英文摘要，也不合并CAR法文摘要', () => {
  const french = 'Les résultats de notre étude concernent les informations publiées et les décisions des investisseurs.';
  assert.equal(originalAbstractSection(`## RÉSUMÉ\nfr\n${french}\n## ABSTRACT\nen\n${abstract}\n## 1 Introduction\nBody text`), abstract);
  assert.equal(originalAbstractSection(`**Abstract**\nEnglish\n${abstract}\n1. Introduction\nBody text`), abstract);
  assert.equal(originalAbstractSection(`Abstract\n${abstract}\nRÉSUMÉ\n${french}\n1 Introduction\nBody text`), abstract);
  assert.equal(originalAbstractSection(`Abstract\n${abstract}…\n1 Introduction\nBody text`), '');
  assert.equal(originalAbstractSection(`RÉSUMÉ\n${french}\n1 Introduction\nBody text`), '');
});
test('智谱原文提取：标题和DOI必须在检索证据中，不用模型自证', () => {
  assert.equal(extractionEvidence([lead], paper, journal).length, 1);
  for (const changed of [{ ...lead, url: 'https://evil.example/paper' },
    { ...lead, content: lead.content.replaceAll(paper.doi, '10.1257/other'), url: 'https://www.aeaweb.org/articles?id=10.1257/other' },
    { ...lead, content: lead.content.replaceAll(paper.doi, paper.doi + 'more'), url: 'https://www.aeaweb.org/articles?id=10.1257/examplemore' },
    { ...lead, title: 'Different title', content: lead.content.replace(paper.title_original, 'Different title') }]) {
    assert.equal(extractionEvidence([changed], paper, journal).length, 0);
  }
});
test('智谱原文提取：模型逐字摘录才入库，保留原文、URL、哈希和检索来源', async () => {
  const record = await extractSearchRecord([lead], paper, journal, async () => extracted, '2026-09-17T01:00:00Z');
  assert.equal(record.abstract, abstract);
  assert.equal(record.raw_abstract, lead.content);
  assert.equal(record.source_evidence.method, 'zhipu_search_verbatim_abstract');
  assert.equal(record.source_evidence.url, lead.url);
  for (const row of [{ ...extracted.record, abstract: 'An invented summary of this research and its interesting findings.' },
    { ...extracted.record, doi: '10.1257/wrong' }, { ...extracted.record, title: 'Another paper' }]) {
    await assert.rejects(extractSearchRecord([lead], paper, journal, async () => ({ record: row }), '2026-09-17T01:00:00Z'), /UNVERIFIED_EXTRACTION/);
  }
  assert.equal(await extractSearchRecord([lead], paper, journal, async () => ({ record: null }), '2026-09-17T01:00:00Z'), null);
});
test('智谱多查询先于SerpAPI，结构化提取解决后立即停止', async () => {
  const calls = [];
  const result = await searchWithFallback({ queryFor: p => p === 'zhipu' ? ['title', 'DOI Abstract'] : 'other',
    search: async q => { calls.push(q); return { called: true, result: { leads: q.query === 'title' ? [] : [lead] } }; },
    verifyResult: async leads => leads.length ? { title: paper.title_original, source_evidence: {} } : null,
    verifyLead: () => assert.fail('No extra page fetch after verified extraction') });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(calls.map(x => x.provider), ['zhipu', 'zhipu']);
});



test('历史SerpAPI整月阻塞自动恢复，新的每日冷却不被跳过', () => {
  const issue = { field: 'abstract', id: 'test', status: 'quota_exhausted', created_at: '2026-09-17T01:00:00Z',
    updated_at: '2026-09-17T01:00:00Z', next_retry_at: '2026-10-14T00:00:00Z', attempt_count: 1,
    attempts: [{ source: 'serpapi_scholar' }] };
  assert.equal(dueRepairIssues({ issues: { test: issue } }, new Date('2026-09-17T02:00:00Z')).length, 1);
  issue.next_retry_at = '2026-09-18T01:00:00Z';
  assert.equal(dueRepairIssues({ issues: { test: issue } }, new Date('2026-09-17T02:00:00Z')).length, 0);
});
