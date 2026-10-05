// Saved-source acceptance. All writes stay in data/acceptance; no publication or production writer.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadJournalConfig} from '../src/services/journals.js';
import {readJournalLibrary,libraryPath} from '../src/services/journalLibrary.js';
import {prepareBrowserImport,importBrowserExport,verifiedPages} from '../src/services/browserImport.js';
import {sourceReviewInput,reviewJob,reviewedSource} from '../src/services/sourceReview.js';
import {pendingFields,reconcileFieldTasks} from '../src/services/collectionFieldTasks.js';
import {createSourceReviewer} from '../tools/browser-abstract-extension/review-provider.mjs';
import {makeReviewJobs,reviewedCatalogCoverage,reviewedCatalogPapers} from '../tools/browser-abstract-extension/review-core.js';
import {prepareReviewPlan,reviewFingerprint} from '../tools/browser-abstract-extension/review-client.js';
import {ACTIVE_CATALOG_TASKS} from '../tools/browser-abstract-extension/catalog-core.js';
import {samePaper} from '../tools/browser-abstract-extension/paper-identity.js';
import {reviewRecord} from '../tools/browser-abstract-extension/review-decisions.js';
import {emptyWorkflow,applyCollectionReceipt} from '../src/services/collectionWorkflow.js';
import {catalogRepairJobs} from '../tools/browser-abstract-extension/catalog-engine.js';
import {cleanAbstract} from '../src/services/paperModel.js';
const repo=path.resolve(import.meta.dirname,'..'),dir=path.join(repo,'data/acceptance/2026-10-05-deepseek/batch');
const formalRoot=path.join(repo,'data/journal-store'),root=path.join(dir,'repo/data/journal-store');
const read=async(file,fallback)=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
await fs.mkdir(dir,{recursive:true});await fs.mkdir(path.join(dir,'results'),{recursive:true});
const save=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
const config=await loadJournalConfig(),formal=await readJournalLibrary({root:formalRoot,config}),formalHash=hash(formal.papers);
const inventory=await read(path.join(dir,'../problem-inventory.json')),catalogInventory=await read(path.join(dir,'../catalog-inventory.json'));
if(!await read(path.join(root,'current.json'))){
  const seen=new Set();let bytes=0;
  const visit=async value=>{
    if(!value||typeof value!=='object')return;
    if(typeof value.path==='string'&&/^[a-f0-9]{64}$/.test(value.sha256)&&value.path.startsWith('snapshots/')){
      if(seen.has(value.path))return;seen.add(value.path);
      const source=await libraryPath(formalRoot,value.path),dest=await libraryPath(root,value.path),raw=await fs.readFile(source);
      await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,raw);bytes+=raw.length;await visit(JSON.parse(raw));return;
    }
    for(const [key,v] of Object.entries(value))if(key!=='parent')await visit(v);
  };
  await visit(formal.pointer);await fs.writeFile(path.join(root,'current.json'),formal.pointerText);
  // Copy the immediately referenced parent only when current-snapshot validation requires it.
  if(formal.enrichments.some(r=>r.run_id===formal.manifest.run_id&&['duplicate_resolution','journal_identity_correction'].includes(r.kind)))await visit(formal.manifest.parent);
  await readJournalLibrary({root,config});console.log(JSON.stringify({stage:'isolated_library',files:seen.size,MB:Math.round(bytes/1048576)}));
}
let dataset=await read(path.join(dir,'cases.json'));
if(!dataset){
  const exportCache=new Map(),cases=[],jobs=[];
  const exported=async file=>{if(!exportCache.has(file))exportCache.set(file,await read(file));return exportCache.get(file);};
  for(const row of inventory.records){
    const paper=formal.papers.find(p=>p.id===row.id);let item={id:row.id,title:row.title,kind:'source'};
    try{
      if(row.capture){
        const data=await exported(row.capture.file),record=data.records.find(r=>samePaper(r,paper)&&r.evidence?.length);
        if(record){
          const fixture={kind:data.kind,records:[record],catalog:{pages:data.catalog.pages.filter(p=>p.journal===paper.journal_key)},review_context:{known_papers:[reviewRecord(paper)]},ai_review_results:{},catalog_review_results:{}};
          const plan=await prepareReviewPlan(makeReviewJobs(null,fixture));
          if(plan.jobs.length){item={...item,kind:'article',fixture,job:plan.jobs[0]};}
        }
      }
      if(!item.job){
        const source=[...paper.source_records].sort((a,b)=>Number(!!b.raw_abstract)-Number(!!a.raw_abstract)||Number(!!b.raw_dates?.source_capture)-Number(!!a.raw_dates?.source_capture)||Number(b.source==='crossref')-Number(a.source==='crossref')||String(b.last_checked_at).localeCompare(String(a.last_checked_at)))[0];
        const input=sourceReviewInput(source,{knownPapers:[paper]});item={...item,kind:'source',source,job:{input,hash:await reviewFingerprint(input)}};
      }
      jobs.push(item.job);
    }catch(e){item.error=e.message;}
    cases.push(item);
  }
  const catalogs=[];
  for(const task of ACTIVE_CATALOG_TASKS){
    const pages=verifiedPages({catalog:{pages:catalogInventory.pages.filter(r=>r.page.task_id===task.id).map(r=>r.page)}});
    const catalog={pages,review_context:{known_papers:formal.papers.filter(p=>p.journal_key===task.journal).map(reviewRecord)}};
    const plan=await prepareReviewPlan(makeReviewJobs(catalog,null));
    // One diagnostic card per acquired page plus every card with a problem record.
    const selected=plan.jobs.filter(j=>pages.some(p=>p.items?.[0]?.url===j.input.source_url)||inventory.records.some(r=>r.doi&&r.doi===j.input.identity.doi));
    jobs.push(...selected);catalogs.push({task,catalog,selected:selected.map(j=>j.hash),skipped:plan.skipped});
  }
  dataset={cases,catalogs,jobs:[...new Map(jobs.map(j=>[j.hash,j])).values()]};await save('cases.json',dataset);
}
if(process.argv.includes('--all-catalogs')){
  for(const c of dataset.catalogs){
    const plan=await prepareReviewPlan(makeReviewJobs(c.catalog,null));c.selected=plan.jobs.map(j=>j.hash);dataset.jobs.push(...plan.jobs);
  }
  dataset.jobs=[...new Map(dataset.jobs.map(j=>[j.hash,j])).values()];dataset.full_catalog_review=true;await save('cases.json',dataset);
}
console.log(JSON.stringify({stage:'plan',papers:dataset.cases.length,catalogs:dataset.catalogs.length,jobs:dataset.jobs.length,invalid:dataset.cases.filter(c=>c.error).map(c=>({title:c.title,error:c.error}))}));
if(!process.argv.includes('--run'))process.exit(0);
assert.ok(process.env.DEEPSEEK_API_KEY||process.argv.includes('--replay'),'SAVED_KEY_REQUIRED');
const callLog=path.join(dir,'calls.jsonl');let newCalls=0;
const auditedFetch=async(url,options)=>{assert.equal(url,'https://api.deepseek.com/chat/completions');newCalls++;
  await fs.appendFile(callLog,JSON.stringify({at:new Date().toISOString(),status:'started',model:JSON.parse(options.body).model})+'\n');return fetch(url,options);};
const providers=Array.from({length:6},(_,i)=>createSourceReviewer({apiKey:process.env.DEEPSEEK_API_KEY||'isolated-offline-replay-only',stateDir:path.join(dir,'../review-provider'),fetchImpl:auditedFetch,maxCalls:2000,budgetFile:path.join(dir,'budget-'+i+'.json')}));
let cursor=0,done=0;const results={};
await Promise.all(providers.map(async provider=>{
  while(cursor<dataset.jobs.length){
    const job=dataset.jobs[cursor++],file=path.join(dir,'results',job.hash+'.json');
    const old=await read(file);
    if(process.argv.includes('--replay'))assert.ok(old,'Missing saved review: '+job.hash);
    const {result}=await reviewJob(job.input,async input=>(await provider.review(input)).data,{cached:old});results[job.hash]=result;
    await fs.writeFile(file,JSON.stringify(result));done++;
    if(done%100===0||done===dataset.jobs.length)console.log(JSON.stringify({stage:'review',done,total:dataset.jobs.length,new_calls:newCalls,errors:Object.values(results).filter(r=>r.error).length}));
    if(result.global_failure)throw Error(result.error);
  }
}));
const paperResults=[],sources=[];
for(const item of dataset.cases){
  const row={id:item.id,title:item.title,kind:item.kind};
  try{
    assert.ok(item.job,item.error);const result=results[item.job.hash];row.error=result?.error||null;
    row.identity=result?.verdict?.status;row.type=result?.verdict?.article_type?.value;row.applicability=result?.verdict?.abstract_applicability?.status;
    if(item.kind==='article'){
      const data={...item.fixture,ai_review_results:{[item.job.hash]:result}};
      const prepared=await prepareBrowserImport(data,config,undefined,{knownPapers:formal.papers});sources.push(...prepared.sources);row.decisions=prepared.decisions;row.sources=prepared.sources.length;
    }else{
      const source=reviewedSource(item.source,item.job.input,result);if(source)sources.push(source);row.sources=source?1:0;
    }
  }catch(e){row.error=e.message;}
  paperResults.push(row);
}
await save('prepared-sources.json',sources);
let imported,importError;
try{imported=await importBrowserExport(config,{root,save:true,prepared:{sources,decisions:[],raw_record_count:dataset.cases.length,input_sha256:hash(sources)}});await save('import-result.json',imported);}
catch(e){importError=e.message;}
const after=await readJournalLibrary({root,config});
for(const row of paperResults){const old=formal.papers.find(p=>p.id===row.id),paper=after.papers.find(p=>p.id===row.id);
  row.after_title=paper?.title_original;row.after_abstract_length=paper?.abstract_original.length||0;row.pending=paper?pendingFields(paper):['identity'];
  row.before_evidence_retained=!!paper&&old.source_records.every(r=>paper.source_records.some(s=>JSON.stringify(s)===JSON.stringify(r)));
}
await reconcileFieldTasks(path.join(dir,'repo'),after.papers,{paperIds:inventory.records.map(p=>p.id),branch:'acceptance'});
const catalogResults=[];let queuedReceiptCheck;
for(const c of dataset.catalogs){
  try{
    const plan=await prepareReviewPlan(makeReviewJobs(c.catalog,null)),coverage=reviewedCatalogCoverage(c.catalog,plan,results),checked=reviewedCatalogPapers(c.catalog,plan,results);
    // Submit original evidence. The receipt derives coverage itself; feeding
    // derived pages back as evidence changes review fingerprints unnecessarily.
    const runId='00000000-0000-4000-8000-000000000001',data={kind:'paper_project',workflow_run_id:runId,records:[],catalog:{...c.catalog,scope_task_ids:[c.task.id],queue:[],cursor:0},catalog_review_results:results};
    const run={version:1,id:runId,mode:'daily',scope:'catalog',created_at:'2020-01-01T00:00:00Z',jobs:[{catalog_id:c.task.id,url:c.task.url}],known_papers:[],task_versions:[]};
    const receipt=await applyCollectionReceipt(emptyWorkflow(),run,data,{input_sha256:hash(c.catalog),sources:[]},after);
    if(queuedReceiptCheck===undefined&&receipt.receipts.at(-1).completed_catalogs===1){
      const queued={...data,catalog:{...data.catalog,queue:[{task_id:c.task.id,url:c.task.url}],cursor:0}};
      const pending=await applyCollectionReceipt(emptyWorkflow(),run,queued,{input_sha256:hash(queued),sources:[]},after);
      queuedReceiptCheck=pending.receipts.at(-1).completed_catalogs===0&&pending.receipts.at(-1).pending_catalog_details[0]?.reason==='pagination_missing';
    }
    catalogResults.push({journal:c.task.journal,collection:c.task.collection,pages:coverage.length,cards:checked.length,
      model_reviewed:checked.filter(p=>p.review_status==='source_checked_candidate').length,selected_reviews:c.selected.length,
      out_of_scope:checked.filter(p=>p.review_decisions?.catalog_membership?.status==='out_of_scope').length,
      uncertain_membership:checked.filter(p=>p.review_decisions?.catalog_membership?.status==='uncertain').length,
      unmatched_links:coverage.reduce((n,p)=>n+(p.unmatched_article_links?.length||0),0),repairs:catalogRepairJobs({...c.catalog,pages:coverage,scope_task_ids:[c.task.id]}).length,
      receipt:receipt.receipts.at(-1),oversize_skips:c.skipped.length});
  }catch(e){catalogResults.push({journal:c.task.journal,collection:c.task.collection,error:e.message});}
}
const productionUnchanged=hash((await readJournalLibrary({root:formalRoot,config})).papers)===formalHash;
const selectedAbstracts=dataset.cases.filter(c=>results[c.job?.hash]?.verdict?.fields.abstract);
const checks={production_library_unchanged:productionUnchanged,original_evidence_retained:paperResults.every(r=>r.before_evidence_retained),
  no_new_duplicate_papers:after.papers.length===formal.papers.length,
  selected_abstracts_persisted:selectedAbstracts.every(c=>after.papers.find(p=>p.id===c.id)?.abstract_original===cleanAbstract(results[c.job.hash].verdict.fields.abstract)),
  unreviewed_queue_keeps_catalog_pending:queuedReceiptCheck===true,
  large_catalog_evidence_not_skipped:dataset.full_catalog_review&&catalogResults.every(c=>c.oversize_skips===0),
  unresolved_catalog_links_keep_pending:catalogResults.every(c=>!c.unmatched_links||c.receipt?.pending_catalogs===1),
  uncertain_membership_keeps_pending:catalogResults.every(c=>!c.uncertain_membership||c.receipt?.pending_catalogs===1),
  all_reviews_returned_without_error:Object.values(results).every(r=>!r.error)};
const report={at:new Date().toISOString(),checks,passed:Object.values(checks).every(Boolean)&&!importError,new_calls:newCalls,total_jobs:dataset.jobs.length,production_unchanged:productionUnchanged,import_stats:imported?.stats,import_error:importError,
  papers:paperResults,catalogs:catalogResults,summary:{papers:paperResults.length,abstracts_saved:paperResults.filter(r=>r.after_abstract_length>0).length,
    no_longer_missing:paperResults.filter(r=>r.pending.length===0).length,titles_corrected:paperResults.filter(r=>r.after_title!==r.title).length,
    review_errors:paperResults.filter(r=>r.error).length,remaining_abstract_tasks:paperResults.filter(r=>r.pending.includes('abstract')).length,
    catalogs:catalogResults.length,catalogs_with_errors:catalogResults.filter(c=>c.error).length}};
await fs.appendFile(path.join(dir,'report-history.jsonl'),JSON.stringify(report)+'\n');
await save('report.json',report);console.log(JSON.stringify({stage:'complete',...report.summary,new_calls:newCalls,import_error:importError,production_unchanged:productionUnchanged}));
