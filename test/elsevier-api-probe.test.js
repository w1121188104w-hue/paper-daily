import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectElsevier, requestElsevier, authenticationReason } from '../scripts/elsevier-api-probe.js';
const paper = { doi: '10.1016/j.respol.2026.105586', title: 'A sample research paper' };
const journal = { print_issn: '0048-7333', electronic_issn: '1873-7625' };
const abstract = 'This study examines the relationship between firm innovation and economic outcomes using a longitudinal dataset.';
const payload = (changes = {}) => ({ 'full-text-retrieval-response': { coredata: { 'prism:doi': paper.doi,
  'dc:title': paper.title, 'prism:issn': '00487333', 'dc:description': abstract, ...changes } } });
test('Elsevier classifies authentication reasons without printing provider text', () => {
  const reason = s => authenticationReason({ 'service-error': { status: { statusText: s } } });
  assert.equal(reason('Invalid API Key'), 'invalid_api_key');
  assert.equal(reason('Request from an invalid IP address'), 'institution_or_ip_restriction');
  assert.equal(reason('Not entitled for this resource'), 'insufficient_entitlement');
  assert.equal(reason('secret-example'), 'unspecified');
});
test('Elsevier verifies DOI title ISSN and existing abstract without returning original text', () => {
  const r = inspectElsevier(payload(), { ...paper, abstract_original: abstract }, journal);
  assert.equal(r.status, 'verified_abstract'); assert.equal(r.matches_existing, true);
  assert.equal(JSON.stringify(r).includes(abstract), false);
});
test('Elsevier refuses incorrect DOI title or journal, and cannot invent missing abstracts', () => {
  for (const change of [{ 'prism:doi': '10.1016/wrong' }, { 'dc:title': 'Other title' }, { 'prism:issn': '00218456' }]) {
    assert.equal(inspectElsevier(payload(change), paper, journal).status, 'identity_not_verified');
  }
  assert.equal(inspectElsevier(payload({ 'dc:description': null }), paper, journal).status, 'metadata_without_abstract');
  assert.equal(inspectElsevier(payload({ 'dc:description': 'Access denied' }), paper, journal).status, 'metadata_without_abstract');
});
test('Elsevier keeps key only in header, refuses redirects and redacts failure body', async () => {
  const result = await requestElsevier(paper.doi, 'secret-example', 'META_ABS', async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.elsevier.com'); assert.equal(url.includes('secret-example'), false);
    assert.equal(options.headers['X-ELS-APIKey'], 'secret-example'); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ 'service-error': { status: { statusCode: 'AUTHENTICATION_ERROR', statusText: 'secret-example' } } }), { status: 401 });
  });
  assert.equal(result.provider_code, 'AUTHENTICATION_ERROR'); assert.equal(JSON.stringify(result).includes('secret-example'), false);
  const failed = await requestElsevier(paper.doi, 'secret-example', 'META_ABS', async () => { throw new Error('secret-example'); });
  assert.equal(failed.error, 'TRANSPORT_FAILURE');
});
