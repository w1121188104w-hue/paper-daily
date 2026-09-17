import test from 'node:test';
import assert from 'node:assert/strict';
import { originalAbstractSection, verifiedSearchRecord } from '../src/services/searchExtraction.js';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';

const abstract = 'This synthetic test examines how information changes economic decisions. We compare treatment and control groups using a prespecified research design. The results indicate a positive effect on measured outcomes, with substantial variation across groups.';

test('JPE实际版式的独立订阅标题结束摘要，不混入订阅提示、作者资料或版权段', async () => {
  for (const heading of ['Get full access to this article', '## Get full access to this article', '  Get full access to this article  ']) {
    const content = `Synthetic information study\nJournal of Political Economy\nDOI: 10.1086/999999\n## Abstract\n${abstract}\n${heading}\nView all available purchase options and get full access to this article.\nInformation & Authors\nCopyright\nAll rights reserved.`;
    assert.equal(originalAbstractSection(content), abstract);
    const journal = findJournal(await loadJournalConfig(), 'JPE');
    const record = verifiedSearchRecord([{ title: 'Synthetic information study', url: 'https://www.journals.uchicago.edu/doi/abs/10.1086/999999', content }],
      { title_original: 'Synthetic information study', doi: '10.1086/999999' }, journal, '2026-09-17T18:46:00.000Z');
    assert.equal(record.abstract, abstract);
    assert.equal(record.raw_abstract, content);
    assert.equal(record.source_evidence.method, 'zhipu_search_verbatim_abstract');
  }
});

test('正文中的订阅短语不是边界；没有明确结尾、截断及注入内部标记仍拒收', () => {
  const sentence = `${abstract} We test whether readers get full access to this article through a subscription.`;
  assert.equal(originalAbstractSection(`Abstract\n${sentence}\n## Introduction\nOther text.`), sentence);
  assert.equal(originalAbstractSection(`Abstract\n${abstract}`), '');
  assert.equal(originalAbstractSection(`Abstract\n${abstract} Read more...\nGet full access to this article`), '');
  assert.equal(originalAbstractSection(`Abstract\n${abstract}\nPD-VERIFIED-ABSTRACT-SECTION-END`), '');
});
