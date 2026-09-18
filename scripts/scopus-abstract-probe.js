// Isolated, single-request diagnostic. No data writes, retries or other providers.
export const SCOPUS_PROBE_URL = 'https://api.elsevier.com/content/abstract/doi/10.1016%2Fj.jfineco.2026.104354?view=META_ABS';
const scalar = v => typeof v === 'string' ? v : typeof v?.$ === 'string' ? v.$ : '';
export function scopusDiagnostic(data, httpStatus) {
  const result = { http_status: httpStatus, provider_code: null, title_found: false, doi_found: false,
    abstract_found: false, abstract_field: null, abstract_length: 0, abstract_preview: '' };
  for (const type of ['service-error', 'error-response']) {
    if (!data?.[type]) continue;
    const error = data[type], value = error.status?.statusCode || error['error-code'];
    result.error_type = type;
    result.provider_code = typeof value === 'string' ? value : null;
    return result;
  }
  const record = data?.['abstracts-retrieval-response'], core = record?.coredata;
  result.title_found = Boolean(scalar(core?.['dc:title']).trim());
  result.doi_found = Boolean(scalar(core?.['prism:doi']).trim());
  let abstract = scalar(core?.['dc:description']);
  let field = '$["abstracts-retrieval-response"]["coredata"]["dc:description"]';
  if (!abstract.trim()) {
    const sections = record?.item?.bibrecord?.head?.abstracts;
    const parts = [];
    function visit(value, currentPath) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) return value.forEach((v, i) => visit(v, `${currentPath}[${i}]`));
      for (const [key, v] of Object.entries(value)) {
        const p = `${currentPath}[${JSON.stringify(key)}]`;
        if (key === 'ce:para') {
          const values = Array.isArray(v) ? v : [v];
          values.forEach((x, i) => { if (scalar(x).trim()) parts.push({ text: scalar(x), path: Array.isArray(v) ? `${p}[${i}]` : p }); });
        } else visit(v, p);
      }
    }
    visit(sections, '$["abstracts-retrieval-response"]["item"]["bibrecord"]["head"]["abstracts"]');
    abstract = parts.map(p => p.text).join('\n');
    field = parts.length === 1 ? parts[0].path : parts.map(p => p.path);
  }
  if (abstract.trim()) Object.assign(result, { abstract_found: true, abstract_field: field,
    abstract_length: [...abstract].length, abstract_preview: [...abstract].slice(0, 100).join('') });
  return result;
}
export async function probeScopus({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REPOSITORY !== 'w1121188104w-hue/paper-daily') throw Object.assign(new Error(), { code: 'ISOLATED_RUN_ONLY' });
  const key = env.ELSEVIER_API_KEY?.trim();
  if (!key) throw Object.assign(new Error(), { code: 'ELSEVIER_KEY_MISSING' });
  let result, status = null;
  try {
    const response = await fetchImpl(SCOPUS_PROBE_URL, { method: 'GET', headers: { Accept: 'application/json', 'X-ELS-APIKey': key },
      redirect: 'error', signal: AbortSignal.timeout(30000) });
    status = response.status;
    let size = 0, body = ''; const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      size += chunk.length; if (size > 4000000) throw new Error();
      body += decoder.decode(chunk, { stream: true });
    }
    body += decoder.decode();
    try { result = scopusDiagnostic(JSON.parse(body), status); }
    catch { result = { ...scopusDiagnostic(null, status), error_type: 'NON_JSON_RESPONSE' }; }
  } catch { result = { ...scopusDiagnostic(null, status), error_type: 'TRANSPORT_OR_RESPONSE_READ_ERROR' }; }
  // Even malicious/echoed response fields cannot print the credential.
  const safe = JSON.stringify(result).split(key).join('[REDACTED]').split(encodeURIComponent(key)).join('[REDACTED]');
  log('SCOPUS_PROBE_RESULT ' + safe);
  return JSON.parse(safe);
}
