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
const repositoryRoot=fileURLToPath(new URL('../',import.meta.url));
async function main(){
  const {values:v}=parseArgs({options:{run:{type:'boolean'},'save-sources':{type:'boolean'}}});
  assertLibrary(v.run,'必须明确指定 --run 才会请求外部来源');
  const config=await loadJournalConfig(),root=path.join(repositoryRoot,'data/journal-store');
  const library=await readJournalLibrary({root,config});
  await withLibraryLock(path.join(repositoryRoot,'data/collection-workflow'),async()=>{
    const collect=v['save-sources']?async(c,opts)=>{let result;
      await runJournalCollection(c,{...opts,root,collect:async(c,o)=>{result=await collectJournals(c,o);return result;}});
      return result;
    }:collectJournals;
    const state=await discoverIndexedCollectionTasks(config,await readWorkflow(repositoryRoot),library.papers,{collect,
      sourceOptions:{maxPages:10,timeoutMs:15000,pageDelayMs:1000,semanticScholarKey:process.env.SEMANTIC_SCHOLAR_API_KEY},
      onJournal:s=>saveWorkflow(repositoryRoot,s)});
    console.log(JSON.stringify({pending_catalogs:state.tasks.filter(t=>t.status==='pending').length,
      failed_checks:state.monitors.filter(m=>m.status!=='ok'&&m.status!=='disabled').length,paid_search_enabled:false,abstract_search:false}));
  });
}
main().catch(()=>{console.error('DISCOVERY_NOT_COMPLETE: previously saved signals retained; no credentials printed.');process.exitCode=1;});
