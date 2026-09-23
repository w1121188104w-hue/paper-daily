import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareBrowserImport, importBrowserExport, planBrowserImport } from '../src/services/browserImport.js';
import { makeReviewJobs, validateReviewOutput } from '../tools/browser-abstract-extension/review-core.js';
import { prepareReviewPlan } from '../tools/browser-abstract-extension/review-client.js';
import { loadJournalConfig } from '../src/services/journals.js';
import { readJournalLibrary } from '../src/services/journalLibrary.js';
import { initializeLocalLedger } from '../scripts/browser-import.js';
import { runTranslationAutomation, readTranslationState } from '../src/services/translationAutomation.js';
import { DEEPSEEK_MODEL } from '../src/services/deepseekTranslation.js';
import { buildJournalSite } from '../src/services/journalSiteBuild.js';
const config = await loadJournalConfig(), at = '2026-09-23T08:00:00.000Z', now = () => new Date(at);
const title = 'Credit markets and firm investment';
const abstract = 'We study firm investment using evidence from financial markets. The results suggest that credit supply affects investment across firms and regions. This study provides new evidence on the information environment and the allocation of capital.';
async function fixture(withAbstract = true) {
  const doi = '10.1016/j.respol.2026.105555', url = 'https://www.sciencedirect.com/science/article/pii/S0048733326000555';
  const record = { doi, title, journal: 'RP', url, source_url: url, identity: { ok: true, method: 'exact_doi' },
    evidence_version: 2, extracted_at: at, abstract: withAbstract ? abstract : null,
    evidence: [{ id: 'title', kind: 'title', text: title }, { id: 'doi', kind: 'doi', text: doi },
      ...(withAbstract ? [{ id: 'abstract', kind: 'abstract', language: 'en', context: 'Abstract', text: abstract }] : [])] };
  const page = { task_id: 'catalog-1', journal: 'RP', source_url: 'https://www.sciencedirect.com/journal/research-policy/vol/55/issue/9',
    page_title: 'Research Policy | ScienceDirect', job_key: 'rp-test', captured_at: at,
    items: [{ title, doi, journal: 'RP', url, evidence: { version: 2, text: title, catalog_url: 'https://www.sciencedirect.com/journal/research-policy/vol/55/issue/9' } }] };
  const data = { kind: 'paper_catalog_sample_trial', records: [record], catalog: { pages: [page] }, ai_review_results: {}, catalog_review_results: {},
    // Derived content is deliberately malicious: the importer must ignore it.
    reviewed_records: [{ ...record, abstract: 'Invented summary' }], papers: [{ title: 'Uncollected candidate' }] };
  const plan = await prepareReviewPlan(makeReviewJobs(null, data));
  for (const job of plan.jobs) {
    const fields = { title: { status: 'confirmed', spans: [{ block_id: 'title', quote: title }] },
      doi: { status: 'confirmed', spans: [{ block_id: 'doi', quote: doi }] } };
    if (withAbstract) fields.abstract = { status: 'confirmed', block_ids: ['abstract'] };
    data.ai_review_results[job.hash] = { input: job.input, verdict: validateReviewOutput(job.input, { identity_match: true, fields }), error: null };
  }
  return data;
}
async function temporary(t) {
  const parent = path.resolve(os.tmpdir()), temp = await fs.mkdtemp(path.join(parent, 'browser-import-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(temp)), parent); assert.ok(path.basename(temp).startsWith('browser-import-test-')); await fs.rm(temp, { recursive: true, force: true }); });
  return { temp, root: path.join(temp, 'library') };
}
test('raw evidence + cached proof only; no derived summaries or uncaptured catalog candidates', async () => {
  const p = await prepareBrowserImport(await fixture(), config);
  assert.equal(p.sources.length, 1); assert.equal(p.sources[0].abstract, abstract);
  assert.equal(p.sources[0].publication_date, ''); assert.deepEqual(p.sources[0].authors, []);
});
test('reject wrong journal, mismatched review input, incomplete proof and highlights', async () => {
  for (const mutate of [
    d => d.catalog.pages[0].source_url = 'https://www.sciencedirect.com/journal/another-journal/latest',
    d => d.catalog.pages[0].identity_evidence = { observed_issns: ['0021-8456'] },
    d => Object.values(d.ai_review_results)[0].input.identity.journal = 'JFE',
    d => Object.values(d.ai_review_results)[0].verdict.proofs.title[0].text = 'Imagined title'
  ]) {
    const d = await fixture(); mutate(d); const p = await prepareBrowserImport(d, config); assert.equal(p.sources.length, 0);
  }
  const d = await fixture();
  Object.values(d.ai_review_results)[0].verdict.proofs.abstract[0].text = 'Imagined abstract';
  const p = await prepareBrowserImport(d, config); assert.equal(p.sources[0].abstract, '');
});
test('dry run writes nothing; atomic import; repeat keeps pointer and source evidence', async t => {
  const { root } = await temporary(t), p = await prepareBrowserImport(await fixture(), config);
  const dry = await importBrowserExport(config, { root, prepared: p, now });
  assert.equal(dry.committed, false); await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  const saved = await importBrowserExport(config, { root, prepared: p, save: true, now }); assert.equal(saved.stats.added, 1);
  const before = await readJournalLibrary({ root, config });
  const again = await importBrowserExport(config, { root, prepared: p, save: true, now });
  assert.equal(again.committed, false); assert.equal((await readJournalLibrary({ root, config })).pointerText, before.pointerText);
});
test('source URL cannot silently point to another article; excluded JPE cannot re-enter import', async () => {
  const d = await fixture(); d.records[0].source_url = 'https://www.sciencedirect.com/science/article/pii/S0048733326000999';
  const plan = await prepareReviewPlan(makeReviewJobs(null,d));
  const old = Object.values(d.ai_review_results)[0]; d.ai_review_results = { [plan.jobs[0].hash]: { ...old, input: plan.jobs[0].input } };
  assert.equal((await prepareBrowserImport(d, config)).sources.length, 0);
  const jpe = await fixture(); jpe.records[0].journal = 'JPE'; jpe.records[0].abstract = null; jpe.records[0].ocr = {status:'failed'};
  const p = await prepareBrowserImport(jpe, config); assert.equal(p.sources.length,0); assert.equal(p.decisions[0].reason,'excluded_by_user');
});
test('fill genuinely missing abstract, never replace existing abstract/title, conflicts retained', async t => {
  const { root } = await temporary(t);
  await importBrowserExport(config, { root, prepared: await prepareBrowserImport(await fixture(false), config), save: true, now });
  const p = await prepareBrowserImport(await fixture(), config);
  assert.equal((await importBrowserExport(config, { root, prepared: p, save: true, now })).stats.abstracts_filled, 1);
  const previous = await readJournalLibrary({ root, config });
  const different = structuredClone(p); different.sources[0].title = 'Completely different work';
  const conflict = planBrowserImport(different, previous, config, now());
  assert.equal(conflict.decisions.at(-1).action, 'conflict'); assert.deepEqual(conflict.papers, previous.papers);
  different.sources[0].title = title; different.sources[0].abstract += ' Another sentence.';
  assert.deepEqual(planBrowserImport(different, previous, config, now()).papers, previous.papers);
});
test('local import → existing translator → website; repeat makes no paid request; raw context stays private', async t => {
  const { root, temp } = await temporary(t), prepared = await prepareBrowserImport(await fixture(), config);
  await importBrowserExport(config, { root, prepared, save: true, now }); await initializeLocalLedger(root, config);
  let calls = 0;
  const opts = { root, apiKey: 'test-only-not-a-real-secret-key', maxRequests: 1, now,
    publishCheckpoint: async () => { assert.ok((await readTranslationState(root)).reservations.length); },
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ model: DEEPSEEK_MODEL,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ title_zh: '信贷市场与企业投资',
        abstract_zh: '我们利用金融市场的证据研究企业投资。结果表明，信贷供给会影响不同企业和地区的投资。本研究为信息环境和资本配置提供了新的证据。' }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })); } };
  const translated = await runTranslationAutomation(config, opts); assert.equal(translated.completed_fields, 2);
  await importBrowserExport(config, { root, prepared, save: true, now });
  assert.equal((await runTranslationAutomation(config, opts)).requested_this_run, 0); assert.equal(calls, 1);
  const site = await buildJournalSite(config, { root, outputRoot: path.join(temp, 'site'), now });
  const data = JSON.parse(await fs.readFile(path.join(site.directory, 'data.json'), 'utf8'));
  assert.equal(data.papers.length, 1); assert.equal(data.papers[0].title_zh, '信贷市场与企业投资');
  assert.equal(data.papers[0].abstract_original, abstract); assert.equal(data.papers[0].source_records, undefined);
  assert.ok(!JSON.stringify(data).includes('test-only-not-a-real-secret-key'));
  await fs.unlink(path.join(root, 'automation/translation-state.json'));
  await assert.rejects(initializeLocalLedger(root, config), /旧库缺失翻译账本/);
});
