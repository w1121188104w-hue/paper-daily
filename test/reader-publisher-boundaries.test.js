import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { originalAbstractSection } from '../src/services/searchExtraction.js';
import { cleanText } from '../src/services/paperModel.js';
const rows = JSON.parse(await fs.readFile(new URL('./fixtures/reader-publisher-boundaries.json', import.meta.url), 'utf8'));
test('真实Reader片段：Springer在访问提示前结束、AEA在下载区前结束，不混入订阅或注释', () => {
  for (const row of rows) {
    const before = row.content;
    const expected = cleanText(row.content.slice(row.content.indexOf('Abstract') + 8, row.content.indexOf(row.expected_end)));
    const actual = originalAbstractSection(row.content);
    assert.ok(actual.length > 500); assert.equal(actual, expected); assert.equal(row.content, before);
    assert.ok(!/Access this article|Subscribe and save|Downloads|Notes 1\./.test(actual));
  }
});
test('正文中的access this article和downloads不是边界，必须为独立标题行', () => {
  const text = 'We study how readers access this article and how downloads affect readership. We find that public access increases both readership and citations substantially.';
  assert.equal(originalAbstractSection('## Abstract\n\n' + text + '\n\n## Access this article\nLog in'), text);
});
