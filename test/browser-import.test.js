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
import {pendingFields} from '../src/services/collectionFieldTasks.js';
import {buildDetailQueue} from '../tools/browser-abstract-extension/detail-queue.js';
import {ACTIVE_CATALOG_TASKS} from '../tools/browser-abstract-extension/catalog-core.js';
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
  const prior=await readJournalLibrary({root,config}),catalogData=await fixture(false);
  catalogData.records=[];catalogData.catalog.review_context={known_papers:prior.papers};
  catalogData.catalog.pages[0].issue_heading='Volume 55, Issue 9, September 2026';
  const catalogPlan=await prepareReviewPlan(makeReviewJobs(catalogData.catalog,null));
  for(const job of catalogPlan.jobs){
    const card=job.input.blocks.find(b=>b.text===title),heading=job.input.blocks.find(b=>b.text.includes('Volume 55'));
    catalogData.catalog_review_results[job.hash]={input:job.input,verdict:validateReviewOutput(job.input,{identity_match:true,
      record_matches:[{id:prior.papers[0].id,status:'same'}],fields:{title:{status:'confirmed',spans:[{block_id:card.id,quote:title}]},
        volume:{status:'confirmed',spans:[{block_id:heading.id,quote:'55'}]},issue:{status:'confirmed',spans:[{block_id:heading.id,quote:'9'}]}}})};
  }
  const membership=await prepareBrowserImport(catalogData,config);
  await importBrowserExport(config,{root,prepared:membership,save:true,now});
  const assigned=(await readJournalLibrary({root,config})).papers;
  assert.equal(assigned.length,1);assert.equal(assigned[0].id,prior.papers[0].id);assert.equal(assigned[0].volume,'55');assert.equal(assigned[0].issue,'9');
  assert.equal(assigned[0].abstract_original,abstract);assert.equal(assigned[0].abstract_zh,prior.papers[0].abstract_zh);assert.equal(assigned[0].abstract_translation_status,'done');
  assert.equal((await runTranslationAutomation(config, opts)).requested_this_run, 0); assert.equal(calls, 1);
  const site = await buildJournalSite(config, { root, outputRoot: path.join(temp, 'site'), now });
  const data = JSON.parse(await fs.readFile(path.join(site.directory, 'data.json'), 'utf8'));
  assert.equal(data.papers.length, 1); assert.equal(data.papers[0].title_zh, '信贷市场与企业投资');
  assert.equal(data.papers[0].abstract_original, abstract); assert.equal(data.papers[0].source_records, undefined);
  assert.ok(!JSON.stringify(data).includes('test-only-not-a-real-secret-key'));
  await fs.unlink(path.join(root, 'automation/translation-state.json'));
  await assert.rejects(initializeLocalLedger(root, config), /旧库缺失翻译账本/);
});

test('reviewed old title correction persists with abstract, keeps original evidence and replays without another write',async t=>{
  const {root}=await temporary(t),old=await prepareBrowserImport(await fixture(false),config);
  old.sources[0].title=title+'Get access';old.sources[0].raw_title=old.sources[0].title;
  delete old.sources[0].raw_dates.content_review;
  await importBrowserExport(config,{root,prepared:old,save:true,now});
  const before=await readJournalLibrary({root,config}),paper=before.papers[0];
  const data=await fixture();data.review_context={known_papers:[paper]};
  data.records[0].title=paper.title_original;data.catalog.pages[0].items[0].title=paper.title_original;
  data.catalog.pages[0].items[0].evidence.text=paper.title_original;
  const plan=await prepareReviewPlan(makeReviewJobs(null,data));
  const job=plan.jobs[0];assert.equal(job.input.existing_records[0].title,paper.title_original);
  const verdict=validateReviewOutput(job.input,{identity_match:true,record_matches:[{id:paper.id,status:'same',reason:'same DOI and publisher link; access button is not title'}],
    fields:{title:{status:'corrected',spans:[{block_id:'title',quote:title}]},doi:{status:'confirmed',spans:[{block_id:'doi',quote:paper.doi}]},abstract:{status:'confirmed',block_ids:['abstract']}}});
  data.ai_review_results={[job.hash]:{input:job.input,verdict,error:null}};
  const prepared=await prepareBrowserImport(data,config,undefined,{knownPapers:before.papers});
  assert.equal(prepared.sources.length,1);
  const result=await importBrowserExport(config,{root,prepared,save:true,now});assert.equal(result.stats.corrected,1);
  const after=await readJournalLibrary({root,config});assert.equal(after.papers[0].title_original,title);assert.equal(after.papers[0].abstract_original,abstract);
  assert.equal(after.papers[0].id,paper.id);assert.ok(after.papers[0].source_records.some(r=>r.title===paper.title_original));
  assert.equal((await importBrowserExport(config,{root,prepared,save:true,now})).committed,false);
});

test('DOI-less catalog entry enters review and imports the DOI and short abstract selected from source',async t=>{
  const {root}=await temporary(t),data=await fixture(),r=data.records[0],realDoi=r.doi;
  r.doi='';data.catalog.pages[0].items[0].doi='';r.evidence.find(b=>b.id==='abstract').text='We find that unions raise wages.';
  const queue=buildDetailQueue(data.catalog.pages[0].items);assert.equal(queue.papers.length,1);assert.ok(queue.papers[0].task_key);
  const plan=await prepareReviewPlan(makeReviewJobs(null,data)),job=plan.jobs[0];
  const verdict=validateReviewOutput(job.input,{identity_match:true,fields:{title:{status:'confirmed',spans:[{block_id:'title',quote:title}]},doi:{status:'confirmed',spans:[{block_id:'doi',quote:realDoi}]},abstract:{status:'confirmed',block_ids:['abstract']}}});
  data.ai_review_results={[job.hash]:{input:job.input,verdict}};
  const prepared=await prepareBrowserImport(data,config);assert.equal(prepared.sources.length,1);
  await importBrowserExport(config,{root,prepared,save:true,now});
  const saved=await readJournalLibrary({root,config});assert.equal(saved.papers[0].doi,realDoi);assert.equal(saved.papers[0].abstract_original,'We find that unions raise wages.');
});

test('already captured evidence can correct a known old online record, but cannot add it as a new paper',async t=>{
  const {root}=await temporary(t),seed=await prepareBrowserImport(await fixture(false),config);
  seed.sources[0].title=title+'Get access';delete seed.sources[0].raw_dates.content_review;
  await importBrowserExport(config,{root,prepared:seed,save:true,now});
  const before=await readJournalLibrary({root,config}),data=await fixture(),task=ACTIVE_CATALOG_TASKS.find(t=>t.journal==='RP'&&t.collection==='online');
  data.catalog.pages[0].task_id=task.id;data.catalog.pages[0].source_url=task.url;
  data.catalog.pages[0].items[0].evidence.catalog_url=task.url;data.catalog.pages[0].items[0].catalog_collection='online';
  data.catalog.pages[0].items[0].evidence.text+=' First online: 1 January 2025';
  data.review_context={known_papers:before.papers};
  const job=(await prepareReviewPlan(makeReviewJobs(null,data))).jobs[0];
  data.ai_review_results={[job.hash]:{input:job.input,verdict:validateReviewOutput(job.input,{identity_match:true,
    record_matches:[{id:before.papers[0].id,status:'same'}],fields:{title:{status:'corrected',spans:[{block_id:'title',quote:title}]},
      doi:{status:'confirmed',spans:[{block_id:'doi',quote:data.records[0].doi}]},abstract:{status:'confirmed',block_ids:['abstract']}}})}};
  assert.equal((await prepareBrowserImport(data,config)).sources.length,0);
  const prepared=await prepareBrowserImport(data,config,undefined,{knownPapers:before.papers});assert.equal(prepared.sources.length,1);
  assert.equal(planBrowserImport(prepared,{...before,papers:[]},config,now()).stats.added,0);
  await importBrowserExport(config,{root,prepared,save:true,now});
  const after=(await readJournalLibrary({root,config})).papers[0];assert.equal(after.id,before.papers[0].id);assert.equal(after.abstract_original,abstract);assert.equal(after.title_original,title);
  assert.equal((await importBrowserExport(config,{root,prepared,save:true,now})).committed,false);
});

test('DeepSeek absence decision persists even when no ordinary field changes, and clears missing-abstract work',async t=>{
  const {root}=await temporary(t),data=await fixture(false);
  await importBrowserExport(config,{root,prepared:await prepareBrowserImport(data,config),save:true,now});
  const before=await readJournalLibrary({root,config});assert.deepEqual(pendingFields(before.papers[0]),['abstract']);
  data.review_context={known_papers:before.papers};
  data.records[0].evidence.push({id:'absence',kind:'context',text:'Editorial policy. This notice has no abstract.'});
  const job=(await prepareReviewPlan(makeReviewJobs(null,data))).jobs[0];
  const verdict=validateReviewOutput(job.input,{identity_match:true,record_matches:[{id:before.papers[0].id,status:'same'}],fields:{title:{status:'confirmed',spans:[{block_id:'title',quote:title}]},doi:{status:'confirmed',spans:[{block_id:'doi',quote:data.records[0].doi}]}},
    article_type:{value:'editorial_policy',spans:[{block_id:'absence',quote:'Editorial policy.'}]},abstract_applicability:{status:'not_applicable',spans:[{block_id:'absence',quote:'This notice has no abstract.'}]}});
  data.ai_review_results={[job.hash]:{input:job.input,verdict}};
  const prepared=await prepareBrowserImport(data,config),result=await importBrowserExport(config,{root,prepared,save:true,now});
  assert.equal(result.stats.review_recorded,1);assert.equal(result.committed,true);
  const saved=await readJournalLibrary({root,config});assert.deepEqual(pendingFields(saved.papers[0]),[]);
  assert.equal((await importBrowserExport(config,{root,prepared,save:true,now})).committed,false);
});

test('confirmed existing DOI record accepts its publisher redirect without relying on the old URL spelling',async t=>{
  const {root}=await temporary(t),seed=await prepareBrowserImport(await fixture(false),config);
  await importBrowserExport(config,{root,prepared:seed,save:true,now});
  const before=await readJournalLibrary({root,config}),data=await fixture(),raw=data.records[0];
  raw.url='https://doi.org/'+raw.doi;data.catalog.pages=[];data.review_context={known_papers:before.papers};
  const job=(await prepareReviewPlan(makeReviewJobs(null,data))).jobs[0];
  const output={identity_match:true,record_matches:[{id:before.papers[0].id,status:'same'}],fields:{
    title:{status:'confirmed',spans:[{block_id:'title',quote:title}]},doi:{status:'confirmed',spans:[{block_id:'doi',quote:raw.doi}]},
    abstract:{status:'confirmed',block_ids:['abstract']}}};
  const review=()=>{data.ai_review_results={[job.hash]:{input:job.input,verdict:validateReviewOutput(job.input,output)}};};
  review();const prepared=await prepareBrowserImport(data,config,undefined,{knownPapers:before.papers});
  assert.equal(prepared.sources.length,1);
  await importBrowserExport(config,{root,prepared,save:true,now});
  const after=await readJournalLibrary({root,config});assert.equal(after.papers.length,1);
  assert.equal(after.papers[0].id,before.papers[0].id);assert.equal(after.papers[0].abstract_original,abstract);
  output.record_matches[0].status='uncertain';review();
  assert.equal((await prepareBrowserImport(data,config,undefined,{knownPapers:before.papers})).sources.length,0);
});

test('storage whitespace and entity decoding retain correction authority and original abstract proof',async t=>{
  const {root}=await temporary(t),seed=await prepareBrowserImport(await fixture(false),config);
  seed.sources[0].title=title+'Get access';delete seed.sources[0].raw_dates.content_review;
  await importBrowserExport(config,{root,prepared:seed,save:true,now});
  const before=await readJournalLibrary({root,config}),data=await fixture();data.review_context={known_papers:before.papers};
  const sourceAbstract='We study A &amp; B.\n\nThe study finds\u00a0positive effects.';
  data.records[0].evidence.find(b=>b.id==='abstract').text=sourceAbstract;
  const job=(await prepareReviewPlan(makeReviewJobs(null,data))).jobs[0];
  data.ai_review_results={[job.hash]:{input:job.input,verdict:validateReviewOutput(job.input,{identity_match:true,
    record_matches:[{id:before.papers[0].id,status:'same'}],fields:{title:{status:'corrected',spans:[{block_id:'title',quote:title}]},
      doi:{status:'confirmed',spans:[{block_id:'doi',quote:data.records[0].doi}]},abstract:{status:'confirmed',block_ids:['abstract']}}})}};
  const prepared=await prepareBrowserImport(data,config,undefined,{knownPapers:before.papers});
  assert.equal(prepared.sources[0].raw_dates.content_review.verdict.fields.abstract,sourceAbstract);
  await importBrowserExport(config,{root,prepared,save:true,now});const after=(await readJournalLibrary({root,config})).papers[0];
  assert.equal(after.title_original,title);assert.equal(after.abstract_original,'We study A & B. The study finds positive effects.');
  assert.equal((await importBrowserExport(config,{root,prepared,save:true,now})).committed,false);
});

test('DeepSeek joins multiple DOI-less dirty titles to the DOI record and archives every before-image',async t=>{
  const {root}=await temporary(t),seed=await prepareBrowserImport(await fixture(false),config);
  const original=structuredClone(seed.sources[0]);original.doi='';original.title=title+'Get access';original.raw_title=original.title;original.source_id='old-directory-card';delete original.raw_dates.content_review;
  const duplicate={...structuredClone(original),source_id:'another-old-directory-card',title:title+' Open access'};
  seed.sources.unshift(original,duplicate);await importBrowserExport(config,{root,prepared:seed,save:true,now});
  const before=await readJournalLibrary({root,config});assert.equal(before.papers.length,3);
  const data=await fixture();data.review_context={known_papers:before.papers};
  const job=(await prepareReviewPlan(makeReviewJobs(null,data))).jobs[0];assert.equal(job.input.existing_records.length,3);
  const verdict=validateReviewOutput(job.input,{identity_match:true,record_matches:before.papers.map(p=>({id:p.id,status:'same',reason:'Same article URL and publisher DOI, old label contains a button.'})),
    fields:{title:{status:'confirmed',spans:[{block_id:'title',quote:title}]},doi:{status:'confirmed',spans:[{block_id:'doi',quote:data.records[0].doi}]},abstract:{status:'confirmed',block_ids:['abstract']}}});
  data.ai_review_results={[job.hash]:{input:job.input,verdict}};
  const prepared=await prepareBrowserImport(data,config),result=await importBrowserExport(config,{root,prepared,save:true,now});
  assert.equal(result.stats.merged,2);
  const saved=await readJournalLibrary({root,config});assert.equal(saved.papers.length,1);assert.equal(saved.papers[0].abstract_original,abstract);
  const report=saved.enrichmentReports.find(r=>r.stage==='duplicate_resolution');assert.equal(report.merges.length,2);assert.ok(report.merges.some(m=>m.original.title_original===original.title));assert.equal(report.merges[0].target_before.abstract_original,'');
  assert.equal((await importBrowserExport(config,{root,prepared,save:true,now})).committed,false);
});
