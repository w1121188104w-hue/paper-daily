import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadJournalConfig} from '../src/services/journals.js';
import {readJournalLibrary} from '../src/services/journalLibrary.js';
import {emptyWorkflow} from '../src/services/collectionWorkflow.js';
import {discoverCollectionTasks} from '../src/services/collectionDiscovery.js';
import {makeSearchSources} from '../src/services/searchSources.js';
import {makeBudgetedSearch,searchAllowance} from '../src/services/searchBudget.js';
import {makeSearchBudgetGitHub} from '../src/services/searchBudgetGitHub.js';
import {assertLibrary} from '../src/services/libraryValidation.js';

export const PROBE_JOURNALS=['RP','JAR','QJE','MS','TAR','JM'];
export async function runDiscoveryProbe({env=process.env,local=false,now=new Date(),configLoader=loadJournalConfig,libraryLoader=readJournalLibrary,
  sourceFactory=makeSearchSources,ledgerFactory=makeSearchBudgetGitHub,save=async()=>{},log=console.log}={}){
  assertLibrary(local?env.PAPER_DISCOVERY_LOCAL_TEST==='1'&&!!env.LOCALAPPDATA:
    env.GITHUB_ACTIONS==='true'&&env.GITHUB_EVENT_NAME==='workflow_dispatch'&&env.GITHUB_REPOSITORY==='w1121188104w-hue/paper-daily','Explicit manual test only');
  assertLibrary(typeof env.ZHIPU_DISCOVERY_API_KEY==='string'&&env.ZHIPU_DISCOVERY_API_KEY.length>=8,'Missing discovery-only search credential');
  const config=await configLoader(),library=await libraryLoader({config});
  const sources=sourceFactory({zhipuKey:env.ZHIPU_DISCOVERY_API_KEY,serpapiKey:'',zhipuEngine:'search_pro',timeoutMs:25000});
  const ledger=ledgerFactory({token:env.GITHUB_TOKEN,repositoryName:'w1121188104w-hue/paper-daily'});
  const budget=makeBudgetedSearch({initialState:await ledger.read(),persist:s=>ledger.persist(s),request:o=>sources.request(o)});
  const report={version:1,at:now.toISOString(),mode:'live_search_only',structured_sources:'intentionally_not_run',
    journals:PROBE_JOURNALS,requests:[],lead_assessments:[],tasks:[],papers_changed:0,translation_calls:0,website_deployed:false};
  const seen=new Set();
  const search=async o=>{
    assertLibrary(o.provider==='zhipu'&&!seen.has(o.taskId+'|'+o.provider)&&seen.size<6,'Probe cap reached');seen.add(o.taskId+'|'+o.provider);
    const result=await budget.run({...o,zhipuMonthlyLimit:2000});
    report.requests.push({provider:o.provider,query:o.query,task_id:o.taskId,called:result.called,reason:result.reason||null,
      diagnostic:result.diagnostic||null,leads:(result.result?.leads||[]).map(l=>({title:l.title,url:l.url,snippet:l.snippet.slice(0,1000)}))});
    await checkpoint();return result;
  };
  async function checkpoint(){
    const encoded=JSON.stringify(report,null,2);
    for(const key of [env.ZHIPU_DISCOVERY_API_KEY,env.ZHIPU_API_KEY,env.SERPAPI_API_KEY,env.GITHUB_TOKEN])assertLibrary(!key||!encoded.includes(key),'Credential detected in report');
    await save(report);
  }
  const state=await discoverCollectionTasks({...config,journals:config.journals.filter(j=>PROBE_JOURNALS.includes(j.key))},emptyWorkflow(),library.papers,{
    now,collect:async()=>({source_results:[]}),search,searchProviders:['zhipu'],onLead:async a=>{report.lead_assessments.push(a);await checkpoint();}});
  report.tasks=state.tasks;report.search_monitors=state.monitors.filter(m=>m.source==='search');
  report.actual_search_calls=report.requests.filter(r=>r.called).length;
  report.zhipu_allowance=searchAllowance(budget.state(),{provider:'zhipu',zhipuMonthlyLimit:2000});
  await checkpoint();log(JSON.stringify({actual_search_calls:report.actual_search_calls,proposed_catalog_tasks:report.tasks.length,papers_changed:0}));
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const option=process.argv.slice(2).join(' ');if(!['--run','--run-local'].includes(option))throw Error('Explicit run mode required');
  const local=option==='--run-local';
  const file=local?path.join(process.env.LOCALAPPDATA||'.','PaperDailySearchProbe','report.json'):path.join(process.env.RUNNER_TEMP||'.','discovery-search-probe','report.json');
  runDiscoveryProbe({local,save:async report=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(report,null,2));}})
    .catch(()=>{console.error('DISCOVERY_PROBE_INCOMPLETE: no credentials or provider error body printed.');process.exitCode=1;});
}
