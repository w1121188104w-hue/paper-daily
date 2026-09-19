import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDeepseekSearch, deepseekSearchRequest, searchOneMissing } from '../scripts/deepseek-abstract-search-probe.js';
const paper = { doi: '10.1016/example', title_original: 'A research paper' };
const journal = { key: 'JFE', name: 'Journal of Financial Economics', electronic_issn: '1879-2774', print_issn: '0304-405X' };
test('DeepSeek uses native search and bounds search budget; requests evidence, not fabricated abstracts', () => {
  const body = deepseekSearchRequest(paper, journal);
  assert.equal(body.tools[0].type, 'web_search_20250305'); assert.equal(body.tools[0].max_uses, 3);
  assert.equal(body.model, 'deepseek-flash'); assert.match(body.messages[0].content[0].text, /Never generate/);
});
test('Model prose alone is not search evidence or a verified abstract', () => {
  const r = inspectDeepseekSearch({ content: [{ type: 'text', text: JSON.stringify({ abstract: 'A claimed abstract', source_url: 'https://example.org/paper' }) }] });
  assert.equal(r.search_result_blocks, 0); assert.deepEqual(r.sources, []); assert.equal(r.independently_verified, false);
});
test('Search URLs and citations come from structured provider fields; tool errors are retained', () => {
  const r = inspectDeepseekSearch({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.org/paper', title: 'Paper' }] },
    { type: 'web_search_tool_result', content: { error_code: 'max_uses_exceeded' } },
    { type: 'text', text: '{"abstract":null,"abstract_status":"partial_only"}', citations: [{ url: 'https://example.org/paper', cited_text: 'source text' }] }] });
  assert.equal(r.sources.length, 1); assert.equal(r.citations[0].cited_text, 'source text');
  assert.equal(r.model_status, 'partial_only'); assert.deepEqual(r.tool_errors, ['max_uses_exceeded']);
});
test('Key is header-only and errors do not leak provider body or credentials', async () => {
  let count = 0;
  const r = await searchOneMissing(paper, journal, 'secret-example', async (url, options) => {
    count++; assert.equal(new URL(url).hostname, 'api.deepseek.com'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-api-key'], 'secret-example'); assert.equal(options.body.includes('secret-example'), false);
    return new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'secret-example' } }), { status: 401 });
  });
  assert.equal(count, 1); assert.equal(r.http_status, 401); assert.equal(JSON.stringify(r).includes('secret-example'), false);
});
