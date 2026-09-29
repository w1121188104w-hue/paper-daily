import path from 'node:path';
import {parseArgs} from 'node:util';
import {loadJournalConfig} from '../src/services/journals.js';
import {readJournalLibrary,withLibraryLock} from '../src/services/journalLibrary.js';
import {readWorkflow,saveWorkflow} from '../src/services/collectionWorkflow.js';
import {discoverIndexedCollectionTasks} from '../src/services/collectionDiscovery.js';
import {assertLibrary} from '../src/services/libraryValidation.js';
import {fileURLToPath} from 'node:url';
import {collectJournals} from '../src/services/collectJournals.js';
import {runJournalCollection} from '../src/services/journalRun.js';
import {collectOfficialCatalogs} from '../src/services/officialCatalog.js';
import {enqueuePublication,publicationInputHash} from '../src/services/cloudPublication.js';
import {randomUUID} from 'node:crypto';
const repositoryRoot=fileURLToPath(new URL('../',import.meta.url));
async function main(){
  const {values:v}=parseArgs({options:{run:{type:'boolean'},'save-sources':{type:'boolean'}}});
  assertLibrary(v.run,'必须明确指定 --run 才会请求外部来源');
  const config=await loadJournalConfig(),root=path.join(repositoryRoot,'data/journal-store');
  const library=await readJournalLibrary({root,config});
  await withLibraryLock(path.join(repositoryRoot,'data/collection-workflow'),async()=>{
    const sourceOptions={maxPages:10,timeoutMs:15000,pageDelayMs:1000,semanticScholarKey:process.env.SEMANTIC_SCHOLAR_API_KEY};
    // One validated snapshot per run, not nineteen copies of the entire library.
    const indexed=v['save-sources']?await runJournalCollection(config,{...sourceOptions,root,withSemanticScholar:true}):null;
    const collect=indexed?async(_c,opts)=>({source_results:indexed.source_results.filter(r=>r.journal_key===opts.journalKey)}):collectJournals;
    let state=await discoverIndexedCollectionTasks(config,await readWorkflow(repositoryRoot),library.papers,{collect,
      sourceOptions,
      onJournal:s=>saveWorkflow(repositoryRoot,s)});
    if(v['save-sources']){
      const official=await collectOfficialCatalogs(config,state,{repositoryRoot,root,onProgress:row=>console.log(JSON.stringify(row))});
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
