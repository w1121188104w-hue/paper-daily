import test from 'node:test';
import assert from 'node:assert/strict';
import { protectTranslationNumbers, restoreTranslationNumbers } from '../src/services/translationNumbers.js';
import { translationQualityError } from '../src/services/translationImport.js';

test('数字传输：每次出现使用独立标记，完整还原千位、小数、年份、编号，不修改原文', () => {
  const source = '19 million; 1800s; 2015 to 2010; 40,000; 10.4; 4960 and 4960; 724B2030; doi:10.1287/x.2024.06477';
  const p = protectTranslationNumbers(source, 'abstract');
  assert.equal(restoreTranslationNumbers(p.encoded, p).text, source);
  assert.equal(new Set(p.tokens.map(t => t.marker)).size, p.tokens.length);
  assert.ok(p.tokens.some(t => t.value === '40,000'));
  assert.equal(p.tokens.filter(t => t.value === '4960').length, 2);
  assert.equal(protectTranslationNumbers('Big 4', 'title').encoded, 'Big ⟦PDN_T_0⟧');
});

test('数字传输：遗漏、重复、换字段、未知标记、半个标记均拒绝，不修补模型输出', () => {
  const p = protectTranslationNumbers('19 and 19 investors', 'abstract');
  for (const text of ['⟦PDN_A_0⟧名投资者', '⟦PDN_A_0⟧与⟦PDN_A_0⟧名投资者',
    '⟦PDN_A_0⟧与⟦PDN_T_1⟧名投资者', '⟦PDN_A_0⟧与⟦PDN_A_2⟧名投资者',
    '⟦PDN_A_0⟧与⟦PDN_A_1⟧名投资者 PDN_A_2', 'PDN_A_0 和 PDN_A_1'])
    assert.deepEqual(restoreTranslationNumbers(text, p), { text: null, error: 'NUMERIC_MARKER_MISMATCH' });
  assert.throws(() => protectTranslationNumbers('User says PDN_A_0', 'title'), { code: 'NUMERIC_MARKER_COLLISION' });
});

test('数字传输：还原后仍执行原有正文和数字检查，直接返回正确数字的译文可以通过', () => {
  const source = 'We study 19 million investors.', p = protectTranslationNumbers(source, 'abstract');
  const restored = restoreTranslationNumbers('我们研究⟦PDN_A_0⟧百万名投资者。', p);
  assert.equal(restored.text, '我们研究19百万名投资者。');
  assert.equal(translationQualityError(source, restored.text, 'abstract'), null);
  assert.equal(translationQualityError(source, restoreTranslationNumbers('我们研究1900万名投资者。', p).text, 'abstract'), 'MISSING_NUMBERS');
  assert.equal(translationQualityError(source, restoreTranslationNumbers('我们研究19百万名投资者。', p).text, 'abstract'), null);
});
