import test from 'node:test';
import assert from 'node:assert/strict';
import { scopusDiagnostic, probeScopus, SCOPUS_PROBE_URL } from '../scripts/scopus-abstract-probe.js';
test('Scopus detects the actual abstract field and limits preview to 100 characters', () => {
  const r = scopusDiagnostic({ 'abstracts-retrieval-response': { coredata: { 'dc:title': 'Title', 'prism:doi': '10.1016/test', 'dc:description': 'a'.repeat(130) } } }, 200);
  assert.equal(r.abstract_length, 130); assert.equal(r.abstract_preview.length, 100);
  assert.equal(r.abstract_field, '$["abstracts-retrieval-response"]["coredata"]["dc:description"]');
  assert.equal(r.title_found, true); assert.equal(r.doi_found, true);
});
test('Scopus keeps provider error code and original error wrapper, not a classified reason', () => {
  const r = scopusDiagnostic({ 'service-error': { status: { statusCode: 'AUTHENTICATION_ERROR', statusText: 'Insufficient privileges' } } }, 403);
  assert.equal(r.provider_code, 'AUTHENTICATION_ERROR'); assert.equal(r.error_type, 'service-error'); assert.equal(r.abstract_found, false);
});
test('Scopus makes exactly the prescribed request without extra credentials or retries', async () => {
  let calls = 0, logged = '';
  await probeScopus({ env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'w1121188104w-hue/paper-daily', ELSEVIER_API_KEY: 'secret-test' },
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url, SCOPUS_PROBE_URL); assert.equal(new URL(url).searchParams.get('view'), 'META_ABS');
      assert.deepEqual(options.headers, { Accept: 'application/json', 'X-ELS-APIKey': 'secret-test' });
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ 'error-response': { 'error-code': 'secret-test' } }), { status: 403 });
    }, log: value => { logged = value; } });
  assert.equal(calls, 1); assert.equal(logged.includes('secret-test'), false);
});
