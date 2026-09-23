import path from 'node:path';
import {parseArgs} from 'node:util';
import {loadJournalConfig} from '../src/services/journals.js';
import {readJournalLibrary,withLibraryLock} from '../src/services/journalLibrary.js';
import {readWorkflow,saveWorkflow} from '../src/services/collectionWorkflow.js';
import {discoverCollectionTasks} from '../src/services/collectionDiscovery.js';
import {makeSearchSources} from '../src/services/searchSources.js';
import {makeBudgetedSearch} from '../src/services/searchBudget.js';
import {makeSearchBudgetGitHub} from '../src/services/searchBudgetGitHub.js';
import {assertLibrary} from '../src/services/libraryValidation.js';
import {fileURLToPath} from 'node:url';
import {collectJournals} from '../src/services/collectJournals.js';
import {runJournalCollection} from '../src/services/journalRun.js';
const repositoryRoot=fileURLToPath(new URL('../',import.meta.url));
async function main(){
  const {values:v}=parseArgs({options:{run:{type:'boolean'},search:{type:'boolean'},'save-sources':{type:'boolean'}}});
  assertLibrary(v.run,'必须明确指定 --run 才会请求外部来源');
  const config=await loadJournalConfig(),root=path.join(repositoryRoot,'data/journal-store');
  const library=await readJournalLibrary({root,config});let search=null;
  if(v.search){
    const sources=makeSearchSources({zhipuKey:process.env.ZHIPU_API_KEY,serpapiKey:process.env.SERPAPI_API_KEY,zhipuEngine:'search_pro'});
    const ledger=makeSearchBudgetGitHub({token:process.env.GITHUB_TOKEN,repositoryName:'w1121188104w-hue/paper-daily'});
    const budget=makeBudgetedSearch({initialState:await ledger.read(),persist:s=>ledger.persist(s),request:o=>sources.request(o)});
    search=async o=>{let account=null;if(o.provider.startsWith('serpapi_')){try{account=await sources.account();}catch{return {called:false,reason:'account_unverified'};}}
      return budget.run({...o,zhipuMonthlyLimit:2000,account});};
  }
  await withLibraryLock(path.join(repositoryRoot,'data/collection-workflow'),async()=>{
    const collect=v['save-sources']?async(c,opts)=>{let result;
      await runJournalCollection(c,{...opts,root,collect:async(c,o)=>{result=await collectJournals(c,o);return result;}});
      return result;
    }:collectJournals;
    const state=await discoverCollectionTasks(config,await readWorkflow(repositoryRoot),library.papers,{search,collect,
      sourceOptions:{maxPages:10,timeoutMs:15000,pageDelayMs:1000,semanticScholarKey:process.env.SEMANTIC_SCHOLAR_API_KEY},
      onJournal:s=>saveWorkflow(repositoryRoot,s)});
    console.log(JSON.stringify({pending_catalogs:state.tasks.filter(t=>t.status==='pending').length,
      failed_checks:state.monitors.filter(m=>m.status!=='ok'&&m.status!=='disabled').length,paid_search_enabled:!!search,abstract_search:false}));
  });
}
main().catch(()=>{console.error('DISCOVERY_NOT_COMPLETE: previously saved signals retained; no credentials printed.');process.exitCode=1;});
