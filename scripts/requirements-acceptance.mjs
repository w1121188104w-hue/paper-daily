// Explicit, bounded live acceptance against saved publisher evidence and an isolated library.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadJournalConfig} from '../src/services/journals.js';
import {readJournalLibrary} from '../src/services/journalLibrary.js';
import {prepareBrowserImport,importBrowserExport} from '../src/services/browserImport.js';
import {makeReviewJobs,reviewedCatalogPapers} from '../tools/browser-abstract-extension/review-core.js';
import {prepareReviewPlan} from '../tools/browser-abstract-extension/review-client.js';
import {reviewJob} from '../src/services/sourceReview.js';
import {createSourceReviewer} from '../tools/browser-abstract-extension/review-provider.mjs';
import {initializeLocalLedger} from './browser-import.js';
import {runTranslationAutomation} from '../src/services/translationAutomation.js';
import {reconcileFieldTasks,readFieldTasks} from '../src/services/collectionFieldTasks.js';
import {summarizePending} from '../tools/browser-abstract-extension/pending-summary.js';
import {collectionScope} from '../tools/browser-abstract-extension/collection-policy.js';

const repository=path.resolve(import.meta.dirname,'..'),dir=path.join(repository,'data/acceptance/2026-10-05-deepseek');
const root=path.join(dir,'repo/data/journal-store'),doi='10.1093/qje/qjag034';
const liveRoot=path.join(repository,'data/journal-store');
const read=async(file,fallback)=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const save=async(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
await fs.mkdir(dir,{recursive:true});
const config=await loadJournalConfig(),formal=await readJournalLibrary({root:liveRoot,config});
const formalHash=hash(formal.papers),before=formal.papers.find(p=>p.doi===doi);assert.ok(before);
let fixture=await read(path.join(dir,'capture.json'));
if(!fixture){
  const file='C:/Users/MSI/AppData/Local/PaperDailyWorkflow/7d1d7d6e-c2be-7c1c-ad01-2ef983571644/export.json';
  const saved=await read(file),records=saved.records.filter(r=>r.doi===doi),pages=saved.catalog.pages.filter(p=>p.journal==='QJE');
  assert.equal(records.length,1);assert.ok(records[0].abstract?.length>100);
  fixture={kind:saved.kind,records,catalog:{...saved.catalog,pages},ai_review_results:{},catalog_review_results:{}};
  await save('capture.json',fixture);await save('formal-before.json',before);
}
let isolated=await readJournalLibrary({root,config});
if(!isolated.papers.length){
  const sources=before.source_records;await importBrowserExport(config,{root,save:true,prepared:{input_sha256:hash(sources),sources,decisions:[],raw_record_count:sources.length}});
  isolated=await readJournalLibrary({root,config});await save('isolated-before.json',isolated.papers[0]);
}
const baseline=await read(path.join(dir,'isolated-before.json'));
fixture.review_context={known_papers:[baseline]};fixture.catalog.review_context=fixture.review_context;
const catalogPlan=await prepareReviewPlan(makeReviewJobs(fixture.catalog,null));
const catalogJob=catalogPlan.jobs.find(j=>j.input.identity.doi===doi);assert.ok(catalogJob);
const articlePlan=await prepareReviewPlan(makeReviewJobs(null,fixture));assert.equal(articlePlan.jobs.length,1);
await save('review-inputs.json',{catalog:catalogJob.input,article:articlePlan.jobs[0].input});
if(!process.argv.includes('--run')){
  console.log(JSON.stringify({prepared:true,directory:dir,title:baseline.title_original,catalog_chars:JSON.stringify(catalogJob.input).length,article_chars:JSON.stringify(articlePlan.jobs[0].input).length,max_live_requests:3}));
  process.exit(0);
}
assert.ok(process.env.DEEPSEEK_API_KEY,'SAVED_KEY_REQUIRED');
const ledgerFile=path.join(dir,'network-calls.json');let calls=await read(ledgerFile,[]);
const maximum=Math.min(3,Number(process.env.ACCEPTANCE_MAX_CALLS||3));
const boundedFetch=async(url,options)=>{
  assert.equal(url,'https://api.deepseek.com/chat/completions');assert.ok(calls.length<maximum,'ACCEPTANCE_CALL_LIMIT');
  const entry={at:new Date().toISOString(),model:JSON.parse(options.body).model,status:'reserved'};
  calls.push(entry);await fs.writeFile(ledgerFile,JSON.stringify(calls,null,2));
  try{const response=await fetch(url,options);entry.status=response.status;await fs.writeFile(ledgerFile,JSON.stringify(calls,null,2));return response;}
  catch(e){entry.status=e.name;await fs.writeFile(ledgerFile,JSON.stringify(calls,null,2));throw e;}
};
const provider=createSourceReviewer({apiKey:process.env.DEEPSEEK_API_KEY,stateDir:path.join(dir,'review-provider'),maxCalls:2,budgetFile:path.join(dir,'review-budget.json'),fetchImpl:boundedFetch});
const previousReport=await read(path.join(dir,'report.json'));
if(previousReport)await fs.appendFile(path.join(dir,'report-history.jsonl'),JSON.stringify(previousReport)+'\n');
const report={checks:[],calls:0};
const check=(name,ok,detail={})=>{report.checks=report.checks.filter(c=>c.name!==name);report.checks.push({name,ok,...detail});};
try{
  for(const [kind,job] of [['catalog',catalogJob],['article',articlePlan.jobs[0]]]){
    console.log(JSON.stringify({stage:kind,title:job.input.identity.title}));
    const {result}=await reviewJob(job.input,async input=>(await provider.review(input)).data);
    fixture[kind==='catalog'?'catalog_review_results':'ai_review_results'][job.hash]=result;
    await save(kind+'-result.json',result);
    check(kind+'_live_review',!result.error&&result.verdict?.status==='source_checked_candidate',{error:result.error||null,title:result.verdict?.fields.title,abstract_length:result.verdict?.fields.abstract?.length||0,record_matches:result.verdict?.record_matches});
    assert.ok(!result.error&&result.verdict?.status==='source_checked_candidate',kind+'_REVIEW_FAILED');
    const count=calls.length,again=await provider.review(job.input);check(kind+'_cache_reuse',again.data.cached===true&&calls.length===count);
  }
  await save('reviewed-export.json',fixture);
  const checked=reviewedCatalogPapers(fixture.catalog,catalogPlan,fixture.catalog_review_results).find(p=>p.doi===doi);
  const scope=collectionScope(checked,new Date());check('online_scope_not_assumed_recent',!scope.eligible&&['outside_online_window','online_date_missing','online_date_conflict','online_date_precision'].includes(scope.status),{scope});
  const prepared=await prepareBrowserImport(fixture,config,undefined,{knownPapers:isolated.papers});
  await save('prepared-import.json',prepared);
  check('reviewed_existing_record_importable',prepared.sources.length===1,{decisions:prepared.decisions});assert.equal(prepared.sources.length,1,'REVIEWED_CORRECTION_NOT_IMPORTABLE');
  const result=await importBrowserExport(config,{root,prepared,save:true});await save('import-result.json',result);
  const after=(await readJournalLibrary({root,config})).papers[0];
  check('title_corrected',after.title_original==='Who Pays for Unions?',{before:baseline.title_original,after:after.title_original});
  check('source_abstract_imported',after.abstract_original===fixture.records[0].abstract,{length:after.abstract_original.length});
  check('identity_retained',after.id===baseline.id);check('before_evidence_retained',after.source_records.some(r=>r.title===baseline.title_original));
  await reconcileFieldTasks(path.join(dir,'repo'),[after],{paperIds:[after.id],branch:'acceptance'});
  const tasks=await readFieldTasks(path.join(dir,'repo'));check('no_abstract_task_after_import',tasks.papers.length===1&&!tasks.papers.some(t=>t.status==='pending'&&t.missing_fields.includes('abstract')));
  const pending=summarizePending({pending_papers:[fixture.records[0],{...fixture.records[0],doi:null}],known_papers:[{...after,journal:after.journal_key,complete:true}]});
  check('stale_doi_and_url_pending_cleared',pending.abstracts===0&&pending.total===0);
  const repeat=await importBrowserExport(config,{root,prepared,save:true});check('import_idempotent',!repeat.committed);
  await initializeLocalLedger(root,config);
  const translated=await runTranslationAutomation(config,{root,apiKey:process.env.DEEPSEEK_API_KEY,maxRequests:1,paperIds:[after.id],publishCheckpoint:async()=>{},fetchImpl:boundedFetch});
  const final=(await readJournalLibrary({root,config})).papers[0];await save('isolated-after.json',final);
  check('live_translation_saved',!!final.abstract_zh&&final.abstract_translation_status==='done'&&final.title_translation_status==='done',{completed_fields:translated.completed_fields});
  const count=calls.length,translationReplay=await runTranslationAutomation(config,{root,apiKey:process.env.DEEPSEEK_API_KEY,maxRequests:1,paperIds:[after.id],publishCheckpoint:async()=>{},fetchImpl:boundedFetch});
  check('translation_not_rebilled',calls.length===count&&translationReplay.requested_this_run===0);
}catch(e){report.failure=e.message;process.exitCode=1;}
finally{
  check('production_library_unchanged',hash((await readJournalLibrary({root:liveRoot,config})).papers)===formalHash);
  report.calls=calls.length;report.updated_at=new Date().toISOString();report.passed=report.checks.every(c=>c.ok)&&!report.failure;
  await save('report.json',report);console.log(JSON.stringify(report));
}
