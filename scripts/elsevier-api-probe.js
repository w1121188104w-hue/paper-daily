import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { classifyPaper } from '../src/services/paperClassification.js';
import { knownJournalMismatch, matchesJournalIssn } from '../src/services/journalIdentity.js';
import { missingOriginalAbstract } from '../src/services/carAbstractLanguage.js';
import { normalizeDoi, normalizeTitleForMatch, cleanText } from '../src/services/paperModel.js';
import { authenticAbstract } from '../src/services/publisherParsers.js';
import { evidenceHash } from '../src/services/evidenceHttp.js';
import { assertLibrary } from '../src/services/libraryValidation.js';

const KEYS = ['AOS', 'JAE', 'JFE', 'JCF', 'RP'];
const scalar = value => typeof value === 'string' ? value : typeof value?.$ === 'string' ? value.$ : '';
const code = value => /^[A-Z_0-9:-]{1,80}$/.test(value || '') ? value : null;
export function authenticationReason(data) {
  const message = String(data?.['service-error']?.status?.statusText || data?.['error-response']?.['error-message'] || '');
  if (/invalid.{0,30}api.?key|api.?key.{0,30}(?:invalid|not found|not recognized)|unrecognized.{0,30}key/i.test(message)) return 'invalid_api_key';
  if (/ip address|institution|institutional|outside.{0,30}network/i.test(message)) return 'institution_or_ip_restriction';
  if (/not authorized|not entitled|insufficient|subscription|entitlement/i.test(message)) return 'insufficient_entitlement';
  if (/quota|rate limit/i.test(message)) return 'quota_or_rate_limit';
  if (/missing.{0,30}api.?key|api.?key.{0,30}required/i.test(message)) return 'api_key_not_received';
  return 'unspecified';
}
export function selectElsevierSamples(papers) {
  return KEYS.flatMap(key => {
    const pool = papers.filter(p => p.journal_key === key && p.doi && !knownJournalMismatch(p) && classifyPaper(p).kind === 'candidate')
      .sort((a, b) => String(b.publication_date || '').localeCompare(String(a.publication_date || '')) || a.id.localeCompare(b.id));
    return [pool.find(missingOriginalAbstract), pool.find(p => !missingOriginalAbstract(p))].filter(Boolean);
  });
}
export function inspectElsevier(data, paper, journal) {
  const core = data?.['full-text-retrieval-response']?.coredata;
  if (!core) return { status: 'unexpected_response', provider_code: code(data?.['service-error']?.status?.statusCode) };
  const doi = normalizeDoi(scalar(core['prism:doi'])), title = cleanText(scalar(core['dc:title']));
  const issns = [core['prism:issn'], core['prism:eIssn']].flat().map(scalar).filter(Boolean);
  const identity = { doi: doi === normalizeDoi(paper.doi), title: normalizeTitleForMatch(title) === normalizeTitleForMatch(paper.title),
    journal_issn: matchesJournalIssn(issns, journal) };
  const abstract = authenticAbstract(scalar(core['dc:description']));
  const verified = identity.doi && identity.title && identity.journal_issn;
  return { status: !verified ? 'identity_not_verified' : abstract ? 'verified_abstract' : 'metadata_without_abstract',
    identity, returned_doi: doi, returned_title: title, returned_issns: issns,
    abstract_length: abstract.length, ...(verified && abstract ? { abstract_sha256: evidenceHash(abstract),
      matches_existing: paper.abstract_original ? cleanText(abstract) === cleanText(paper.abstract_original) : null } : {}) };
}
export async function requestElsevier(doi, key, view = 'META_ABS', fetchImpl = fetch) {
  assertLibrary(/^10\.1016\/[a-z0-9._()/;-]+$/i.test(doi), 'DOI不在测试范围');
  assertLibrary(['META_ABS', 'META'].includes(view), '不允许全文请求');
  const url = `https://api.elsevier.com/content/article/doi/${encodeURIComponent(doi)}?view=${view}`;
  try {
    const response = await fetchImpl(url, { headers: { 'X-ELS-APIKey': key, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(25000) });
    let text = '', size = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1000000) return { http_status: response.status, error: 'RESPONSE_TOO_LARGE' };
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    let data; try { data = JSON.parse(text); } catch { return { http_status: response.status, error: 'NON_JSON_RESPONSE' }; }
    return { http_status: response.status, provider_code: code(data?.['service-error']?.status?.statusCode),
      ...(!response.ok ? { provider_reason: authenticationReason(data) } : {}),
      data: response.ok ? data : null };
  } catch { return { http_status: null, error: 'TRANSPORT_FAILURE' }; }
}
export async function probeElsevier({ env = process.env, log = console.log } = {}) {
  assertLibrary(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REPOSITORY === 'w1121188104w-hue/paper-daily', '仅允许隔离测试');
  if (!env.ELSEVIER_API_KEY?.trim()) { const e = new Error(); e.code = 'ELSEVIER_KEY_MISSING'; throw e; }
  const config = await loadJournalConfig(), root = path.resolve('production-baseline/data/journal-store');
  const before = await readJournalLibrary({ root, config }), samples = selectElsevierSamples(before.papers).slice(0, env.ELSEVIER_DIAGNOSTIC_ONLY === 'true' ? 1 : 10), records = [];
  assertLibrary(samples.length > 0 && samples.length <= 10, '样本数量异常');
  let calls = 0, stopped = null;
  for (const paper of samples) {
    await sleep(1100);
    const answer = await requestElsevier(paper.doi, env.ELSEVIER_API_KEY.trim()); calls++;
    const { data, ...diagnostic } = answer;
    const row = { journal: paper.journal_key, doi: paper.doi, control: !missingOriginalAbstract(paper), view: 'META_ABS', ...diagnostic,
      ...(data ? inspectElsevier(data, paper, findJournal(config, paper.journal_key)) : { status: 'request_failed' }) };
    // One META diagnostic distinguishes abstract-view restrictions from complete access denial.
    if (env.ELSEVIER_DIAGNOSTIC_ONLY !== 'true' && answer.http_status === 403 && !records.some(r => r.meta_diagnostic)) {
      await sleep(1100);
      const diagnosticAnswer = await requestElsevier(paper.doi, env.ELSEVIER_API_KEY.trim(), 'META'); calls++;
      row.meta_diagnostic = { http_status: diagnosticAnswer.http_status, provider_code: diagnosticAnswer.provider_code,
        ...(diagnosticAnswer.data ? inspectElsevier(diagnosticAnswer.data, paper, findJournal(config, paper.journal_key)) : {}) };
      if ([401, 429].includes(diagnosticAnswer.http_status)) stopped = `HTTP_${diagnosticAnswer.http_status}`;
    }
    records.push(row); log('ELSEVIER_PROBE_ROW ' + JSON.stringify(row));
    if ([401, 429].includes(answer.http_status)) stopped = `HTTP_${answer.http_status}`;
    if (stopped) break;
  }
  assertLibrary(before.pointerText === (await readJournalLibrary({ root, config })).pointerText, '正式库不得变化');
  log('ELSEVIER_PROBE_RESULT ' + JSON.stringify({ tested_at: new Date().toISOString(), planned: samples.length, calls, stopped,
    verified: records.filter(r => r.status === 'verified_abstract').length,
    newly_available: records.filter(r => !r.control && r.status === 'verified_abstract').length, records, production_writes: 0 }));
}
