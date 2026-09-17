import test from 'node:test';
import assert from 'node:assert/strict';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { normalizeSourceRecord } from '../src/services/paperModel.js';
import { selectCarEnglish, carTitlePrefix } from '../src/services/carEnglish.js';
import { mergePapers } from '../src/services/paperMerge.js';
import { validatePapers, validateHistoryPreserved } from '../src/services/libraryValidation.js';
import { fetchCrossrefJournal } from '../src/services/crossref.js';

const config = await loadJournalConfig(), journal = findJournal(config, 'CAR');
const at = '2026-09-17T01:00:00.000Z', doi = '10.1111/1911-3846.70031';
const enTitle = 'The Value of Values: Does Focusing on Sustainability Provide a Competitive Advantage?';
const frTitle = 'La valeur des valeurs : mettre l’accent sur la durabilité';
const abstract = 'We identify sustainability-focused analysts using recent advances in text analysis. We find that analysts forecast earnings more accurately and provide timely information. These results document a competitive advantage.';
const french = 'Nous identifions les analystes qui se concentrent sur la durabilité. Ces résultats démontrent un avantage concurrentiel dans la prévision des résultats.';
function record(caption = false) {
  return normalizeSourceRecord({ source: 'crossref', source_id: doi, doi,
    journal_key: 'CAR', journal_name: journal.name, journal_category: journal.category, journal_category_zh: journal.category_zh,
    print_issn: journal.print_issn, electronic_issn: journal.electronic_issn,
    title: enTitle + frTitle, abstract: `ABSTRACT\n${abstract}\n\n${caption ? frTitle + '\n' : ''}RÉSUMÉ${french}`,
    publication_date: '2026-09', authors: [{ name: 'Alice Smith' }], type: 'journal-article', last_checked_at: at });
}

test('CAR用明确的法文标题段落拆分；不改写真实英文、不丢弃双语原文', () => {
  const r = record(true), out = selectCarEnglish(r);
  assert.equal(out.title, enTitle); assert.equal(out.abstract, abstract);
  assert.equal(out.raw_title, r.raw_title); assert.equal(out.raw_abstract, r.raw_abstract);
  assert.equal(out.text_selection.original_abstract, r.abstract);
  assert.equal(selectCarEnglish({ ...r, journal_key: 'JAR' }), null);
  assert.equal(selectCarEnglish({ ...r, raw_abstract: abstract }), null);
});

test('CAR标题无边界时不猜；同DOI可信英文标题到达后可继续修复', () => {
  const r = record(), out = selectCarEnglish(r);
  assert.equal(out.title, r.title); assert.equal(out.abstract, abstract);
  const peer = { ...r, title: enTitle, abstract, raw_abstract: abstract };
  assert.equal(selectCarEnglish(out, [peer]).title, enTitle);
  assert.equal(selectCarEnglish(r, [{ ...peer, doi: '10.1234/wrong' }]).title, r.title);
  assert.equal(selectCarEnglish(selectCarEnglish(out, [peer]), [peer]), null);
});

test('CAR仅忽略XML带来的空白差异，返回原文前缀；不忽略词语或标点改变', () => {
  const full = 'Is Tax Policy Associated With COVID‐19 Restrictions?La politique fiscale';
  assert.equal(carTitlePrefix(full, 'Is Tax Policy Associated With COVID ‐19 Restrictions?'), 'Is Tax Policy Associated With COVID‐19 Restrictions?');
  assert.equal(carTitlePrefix(full, 'Is Tax Policy NOT Associated With COVID‐19 Restrictions?'), '');
  assert.equal(carTitlePrefix("SEC Attention, A to ZL'attention de la SEC, de A à Z", 'SEC Attention, A to Z'), 'SEC Attention, A to Z');
  const frenchOnly = normalizeSourceRecord({ ...record(), abstract: `RÉSUMÉ ${french}`, raw_abstract: `RÉSUMÉ ${french}` });
  assert.equal(selectCarEnglish(frenchOnly), null); // No English section: never invent one.
});

test('CAR历史迁移保留原始版本与旧译文，原文指纹改变后自动排队重译，重复运行幂等', () => {
  const old = mergePapers([record(true)], { checkedAt: at, firstSeenDate: '2026-09-17' }).papers;
  old[0].title_zh = '旧标题'; old[0].abstract_zh = '旧双语摘要';
  old[0].title_translation_status = 'done'; old[0].abstract_translation_status = 'done';
  const result = mergePapers([], { existingPapers: old, normalizeCar: true, checkedAt: at, firstSeenDate: '2026-09-17' });
  validatePapers(result.papers, config); validateHistoryPreserved(old, result.papers);
  const p = result.papers[0];
  assert.equal(p.title_original, enTitle); assert.equal(p.abstract_original, abstract);
  assert.equal(p.abstract_zh, '旧双语摘要'); assert.equal(p.abstract_translation_status, 'outdated');
  assert.equal(p.title_translation_status, 'outdated'); assert.equal(p.source_records.length, 2);
  assert.equal(result.audit[0].type, 'car_english_selection');
  const repeated = mergePapers([], { existingPapers: result.papers, normalizeCar: true, checkedAt: at, firstSeenDate: '2026-09-17' });
  assert.deepEqual(repeated.papers, result.papers); assert.equal(repeated.stats.updated, 0);
});

test('CAR按已知DOI查英文标题，返回DOI和ISSN必须同时匹配；原始响应入审计', async () => {
  for (const correct of [true, false]) {
    const urls = [];
    const result = await fetchCrossrefJournal(journal, { fromDate: '2026-07-20', toDate: '2026-09-17', checkedAt: at,
      carBilingualPapers: [{ doi, title_original: enTitle + frTitle }],
      fetchImpl: async url => { urls.push(String(url)); return new Response(JSON.stringify(urls.length === 1 ?
        { status: 'ok', message: { items: [], 'total-results': 0 } } :
        { status: 'ok', message: { DOI: correct ? doi : '10.1234/wrong', ISSN: [journal.print_issn], title: [enTitle] } })); } });
    assert.equal(urls.length, 2); assert.equal(result.records.length, correct ? 1 : 0);
    assert.equal(result.raw_pages[1].purpose, 'car_existing_bilingual_title');
  }
});

test('CAR单篇404不阻断后续标题，主机429或403必须停止；保留部分失败状态', async () => {
  for (const status of [404, 403, 429]) {
    let calls = 0;
    const nextDoi = '10.1111/1911-3846.70032';
    const result = await fetchCrossrefJournal(journal, { fromDate: '2026-07-20', toDate: '2026-09-17', checkedAt: at,
      carBilingualPapers: [{ doi, title_original: enTitle + frTitle }, { doi: nextDoi, title_original: enTitle + frTitle }],
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return new Response(JSON.stringify({ status: 'ok', message: { items: [], 'total-results': 0 } }));
        if (calls === 2) return new Response('', { status });
        return new Response(JSON.stringify({ status: 'ok', message: { DOI: nextDoi, ISSN: [journal.print_issn], title: [enTitle] } }));
      } });
    assert.equal(calls, status === 404 ? 3 : 2);
    assert.equal(result.records.length, status === 404 ? 1 : 0);
    assert.equal(result.ok, false);
  }
});

test('CAR补查达到时间预算不能误报完成，也不提前访问剩余论文', async () => {
  let calls = 0, ticks = 0;
  const result = await fetchCrossrefJournal(journal, { fromDate: '2026-07-20', toDate: '2026-09-17', checkedAt: at,
    now: () => ticks++ === 0 ? 0 : 120000,
    carBilingualPapers: [{ doi, title_original: enTitle + frTitle }],
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ status: 'ok', message: { items: [], 'total-results': 0 } })); } });
  assert.equal(calls, 1); assert.equal(result.ok, false); assert.equal(result.error.code, 'CAR_TITLE_LOOKUP_FAILED');
});

test('CAR清单仍返回双语拼接标题时，不能当成已确认英文而跳过DOI核对', async () => {
  let calls = 0;
  const work = title => ({ DOI: doi, ISSN: [journal.print_issn], title: [title] });
  const result = await fetchCrossrefJournal(journal, { fromDate: '2026-07-20', toDate: '2026-09-17', checkedAt: at,
    carBilingualPapers: [{ doi, title_original: enTitle + frTitle }],
    fetchImpl: async () => { calls++; return new Response(JSON.stringify(calls === 1 ?
      { status: 'ok', message: { items: [work(enTitle + frTitle)], 'total-results': 1 } } :
      { status: 'ok', message: work(enTitle) })); } });
  assert.equal(calls, 2);
  assert.ok(result.records.some(r => r.title === enTitle));
});
