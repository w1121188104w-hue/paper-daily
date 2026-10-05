// Promote the reviewed acceptance inputs through the normal formal-library writer.
// No API calls, test-library copying, deletion, or translation-ledger replacement.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadJournalConfig} from '../src/services/journals.js';
import {readJournalLibrary,withLibraryLock} from '../src/services/journalLibrary.js';
import {importBrowserExport} from '../src/services/browserImport.js';
import {readWorkflow,saveWorkflow,applyCollectionReceipt,addDiscoverySignals} from '../src/services/collectionWorkflow.js';
import {pendingFields,reconcileFieldTasks} from '../src/services/collectionFieldTasks.js';
import {enqueuePublication,readCloudQueue} from '../src/services/cloudPublication.js';
import {makeReviewJobs} from '../tools/browser-abstract-extension/review-core.js';
import {prepareReviewPlan} from '../tools/browser-abstract-extension/review-client.js';
const repo=path.resolve(import.meta.dirname,'..'),root=path.join(repo,'data/journal-store');
const acceptance=path.join(repo,'data/acceptance/2026-10-05-deepseek'),out=path.join(acceptance,'promotion');
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid=h=>[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20,32)].join('-');
const config=await loadJournalConfig(),report=await read(path.join(acceptance,'batch/report.json'));
assert.ok(report.passed&&report.production_unchanged,'Acceptance must have passed');
const sources=await read(path.join(acceptance,'batch/prepared-sources.json')),cases=await read(path.join(acceptance,'batch/cases.json'));
const prepared={sources,decisions:[],raw_record_count:cases.cases.length,input_sha256:sha(sources)};
const id=uuid(sha(['requirements-acceptance',prepared.input_sha256])),publicationId=uuid(sha(['requirements-publication',id]));
const before=await readJournalLibrary({root,config}),workflow=await readWorkflow(repo);
const plan=await importBrowserExport(config,{root,prepared});
assert.equal(plan.stats.added,0,'Acceptance must not invent new paper records');
assert.equal(plan.stats.pending_candidates,0,'Current formal records conflict with the reviewed inputs');
for(const expected of report.papers){
  const paper=plan.papers.find(p=>p.id===expected.id);assert.ok(paper,'Existing identity missing');
  assert.equal(paper.title_original,expected.after_title);assert.equal(paper.abstract_original.length,expected.after_abstract_length);
  assert.deepEqual(pendingFields(paper),expected.pending);
}
for(const old of before.papers){
  const paper=plan.papers.find(p=>p.id===old.id);assert.ok(paper);
  for(const field of ['title_zh','abstract_zh'])assert.equal(paper[field],old[field],'Existing translation changed');
  assert.ok(old.source_records.every(s=>paper.source_records.some(t=>JSON.stringify(s)===JSON.stringify(t))),'Original source evidence missing');
}
const pages=cases.catalogs.flatMap(c=>c.catalog.pages),known=[...new Map(cases.catalogs.flatMap(c=>c.catalog.review_context.known_papers).map(p=>[p.id,p])).values()];
const catalog={pages,queue:[],cursor:0,scope_task_ids:cases.catalogs.map(c=>c.task.id),review_context:{known_papers:known}};
const catalogPlan=await prepareReviewPlan(makeReviewJobs(catalog,null)),results={};
for(const job of catalogPlan.jobs){const r=await read(path.join(acceptance,'batch/results',job.hash+'.json'));assert.ok(!r.error&&r.verdict);results[job.hash]=r;}
const inputHash=sha({source_hash:prepared.input_sha256,catalog,review_hashes:catalogPlan.jobs.map(j=>j.hash)}),now=new Date();
const run={version:1,id,mode:'daily',scope:'catalog',created_at:now.toISOString(),direct_pages:pages,
  jobs:cases.catalogs.map(c=>({catalog_id:c.task.id,url:c.task.url})),known_papers:[],task_versions:workflow.tasks.map(t=>{
    const captured=pages.filter(p=>p.task_id===t.catalog_id).map(p=>Date.parse(p.captured_at));
    const cutoff=captured.length?Math.max(...captured):0;
    return {id:t.id,signals:t.signals.filter(s=>Date.parse(s.discovered_at)<=cutoff).map(s=>s.key)};
  })};
const data={kind:'paper_project',workflow_run_id:id,records:[],catalog,catalog_review_results:results};
let next=await applyCollectionReceipt(workflow,run,data,{...prepared,input_sha256:inputHash},{papers:plan.papers},{now});
const receipt=next.receipts.find(r=>r.id===id);
assert.equal(receipt.completed_catalogs,30);assert.equal(receipt.pending_catalogs,8);
receipt.publication_id=publicationId;receipt.evidence_scope='saved_capture_acceptance';
next=addDiscoverySignals(next,receipt.pending_catalog_details.map(p=>({catalog_id:p.catalog_id,catalog_url:p.url,source_url:p.url,
  source:'manual',title:'验收确认目录完整性仍待核实',change_key:id})),{now});
const paperIds=report.papers.map(p=>p.id);
await fs.mkdir(out,{recursive:true});
const save=(name,value)=>fs.writeFile(path.join(out,name),JSON.stringify(value,null,2));
const summary={id,publication_id:publicationId,input_sha256:inputHash,save:process.argv.includes('--save'),
  before_pointer:before.pointer,stats:plan.stats,papers:plan.papers.length,catalogs_completed:30,catalogs_pending:8,
  abstract_added:report.summary.abstracts_saved,abstract_not_applicable:report.summary.no_longer_missing-report.summary.abstracts_saved,
  titles_corrected:report.summary.titles_corrected,abstract_pending:report.summary.remaining_abstract_tasks,
  preserved_existing_translations:true,preserved_original_evidence:true,paid_calls:0};
await save('preflight.json',summary);
if(!summary.save){console.log(JSON.stringify(summary));process.exit(0);}
for(const relative of ['data/journal-store/current.json','data/journal-store/automation/translation-state.json',
  'data/collection-workflow/state.json','data/collection-workflow/field-tasks.json','data/collection-workflow/publication-queue.json']){
  const dest=path.join(out,'before',relative);await fs.mkdir(path.dirname(dest),{recursive:true});
  try{await fs.writeFile(dest,await fs.readFile(path.join(repo,relative)),{flag:'wx'});}catch(e){if(e.code!=='EEXIST'&&e.code!=='ENOENT')throw e;}
}
assert.equal((await readJournalLibrary({root,config})).pointerText,before.pointerText,'Formal library changed during preflight');
const imported=await importBrowserExport(config,{root,prepared,save:true}),after=await readJournalLibrary({root,config});
assert.equal(sha(after.papers.map(p=>[p.id,p.title_original,p.abstract_original,p.title_zh,p.abstract_zh])),
  sha(plan.papers.map(p=>[p.id,p.title_original,p.abstract_original,p.title_zh,p.abstract_zh]).sort((a,b)=>a[0].localeCompare(b[0]))));
await withLibraryLock(path.join(repo,'data/collection-workflow'),async()=>{
  assert.equal(sha(await readWorkflow(repo)),sha(workflow),'Workflow changed during preflight; library update retained');
  await saveWorkflow(repo,next);
  await reconcileFieldTasks(repo,after.papers,{paperIds,branch:'reviewed_acceptance'});
  await enqueuePublication(repo,{id,inputHash,publicationId,paperIds,maxRequests:100});
});
const finalWorkflow=await readWorkflow(repo),request=(await readCloudQueue(repo)).requests.find(r=>r.id===id);
assert.ok(finalWorkflow.receipts.some(r=>r.id===id)&&request,'Formal receipt or publication queue missing');
const result={...summary,committed:imported.committed,run_id:imported.run_id,after_pointer:after.pointer,verified:true,publication_status:request.status};
await save('result.json',result);console.log(JSON.stringify(result));
