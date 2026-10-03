import path from 'node:path';
import {parseArgs} from 'node:util';
import {loadJournalConfig} from '../src/services/journals.js';
import {readJournalLibrary,withLibraryLock} from '../src/services/journalLibrary.js';
import {readWorkflow,saveWorkflow} from '../src/services/collectionWorkflow.js';
import {discoverIndexedCollectionTasks} from '../src/services/collectionDiscovery.js';
import {assertLibrary} from '../src/services/libraryValidation.js';
import {fileURLToPath} from 'node:url';
import {collectJournals} from '../src/services/collectJournals.js';
import {collectOfficialCatalogs} from '../src/services/officialCatalog.js';
import {enqueuePublication,publicationInputHash} from '../src/services/cloudPublication.js';
import {randomUUID} from 'node:crypto';
import {enqueueSourceReviews,processSourceReviews,REVIEW_PROVIDER_PATH} from '../src/services/sourceReviewQueue.js';
import {createSourceReviewer} from '../tools/browser-abstract-extension/review-provider.mjs';
import {makeSourceReviewCheckpoint} from '../src/services/sourceReviewGit.js';
import {safeProcess} from './collection-service.js';
const repositoryRoot=fileURLToPath(new URL('../',import.meta.url));
async function main(){
  const {values:v}=parseArgs({options:{run:{type:'boolean'},'save-sources':{type:'boolean'}}});
  assertLibrary(v.run,'必须明确指定 --run 才会请求外部来源');
  const config=await loadJournalConfig(),root=path.join(repositoryRoot,'data/journal-store');
  const library=await readJournalLibrary({root,config});
  await withLibraryLock(path.join(repositoryRoot,'data/collection-workflow'),async()=>{
    const sourceOptions={maxPages:10,timeoutMs:15000,pageDelayMs:3000,captureReviewEvidence:true,semanticScholarKey:process.env.SEMANTIC_SCHOLAR_API_KEY};
    const env={...process.env};delete env.DEEPSEEK_API_KEY;delete env.SEMANTIC_SCHOLAR_API_KEY;
    const checkpoint=process.env.GITHUB_ACTIONS==='true'?makeSourceReviewCheckpoint(repositoryRoot,
      (args,options={})=>safeProcess('git',args,{cwd:repositoryRoot,env,...options})):async()=>{};
    const provider=process.env.DEEPSEEK_API_KEY?createSourceReviewer({apiKey:process.env.DEEPSEEK_API_KEY,
      stateDir:path.join(repositoryRoot,REVIEW_PROVIDER_PATH),beforeRequest:checkpoint,afterRequest:checkpoint}):null;
    const request=provider?async(input,options={})=>{const r=await provider.review(input,{retryHeader:options.retryAttempt});return r.data;}:null;
    const collect=async(c,opts)=>{const result=await collectJournals(c,opts);
      if(v['save-sources'])await enqueueSourceReviews(repositoryRoot,result.source_results.flatMap(r=>r.records),{papers:library.papers});
      return result;};
    let state=await discoverIndexedCollectionTasks(config,await readWorkflow(repositoryRoot),library.papers,{collect,
      sourceOptions,
      onJournal:s=>saveWorkflow(repositoryRoot,s)});
    if(v['save-sources']){
      // Indexed metadata can complete this branch without waiting for a browser.
      await processSourceReviews(repositoryRoot,config,{root,request,checkpoint});
      const official=await collectOfficialCatalogs(config,state,{repositoryRoot,root,requestReview:request,reviewCheckpoint:checkpoint,
        reviewSources:async sources=>{await enqueueSourceReviews(repositoryRoot,sources,{papers:(await readJournalLibrary({root,config})).papers});
          await processSourceReviews(repositoryRoot,config,{root,request,checkpoint});return [];},
        onProgress:row=>console.log(JSON.stringify(row))});
      state=official.state;await saveWorkflow(repositoryRoot,state);
      const current=await readJournalLibrary({root,config});
      const changed=current.papers.filter(p=>{const old=library.papers.find(x=>x.id===p.id);return !old||!old.abstract_original&&p.abstract_original;}).map(p=>p.id);
      if(changed.length)await enqueuePublication(repositoryRoot,{id:randomUUID(),publicationId:randomUUID(),paperIds:changed,
        inputHash:publicationInputHash(current.papers.filter(p=>changed.includes(p.id)).map(p=>[p.id,p.title_original,p.abstract_original]))});
    }
    console.log(JSON.stringify({pending_catalogs:state.tasks.filter(t=>t.status==='pending').length,
      failed_checks:state.monitors.filter(m=>m.status!=='ok'&&m.status!=='disabled').length,paid_search_enabled:false,abstract_search:false}));
  });
}
main().catch(()=>{console.error('DISCOVERY_NOT_COMPLETE: previously saved signals retained; no credentials printed.');process.exitCode=1;});
