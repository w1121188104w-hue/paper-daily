import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadJournalConfig} from '../src/services/journals.js';
import {readJournalLibrary} from '../src/services/journalLibrary.js';
import {emptyWorkflow} from '../src/services/collectionWorkflow.js';
import {discoverCollectionTasks} from '../src/services/collectionDiscovery.js';
import {makeSearchSources} from '../src/services/searchSources.js';
import {makeDiscoveryTestBudget} from '../src/services/discoveryTestBudget.js';
import {makeSearchBudgetGitHub} from '../src/services/searchBudgetGitHub.js';
import {assertLibrary} from '../src/services/libraryValidation.js';
import {ACTIVE_CATALOG_TASKS} from '../tools/browser-abstract-extension/catalog-core.js';

export const PROBE_JOURNALS=['RP','JAR','QJE','MS','TAR','JM'];
export const PROBE_GROUPS={pilot:PROBE_JOURNALS,second:['AOS','JAE','CAR','RAS','AER','RES'],third:['JF','JFE','RFS','JCF','JIBS','JOM']};
export const PROBE_MODES=['general','issue','online','year_issue','year_online','url_issue','url_online','issn','native_issue','native_online','recent_issue','recent_online','doi_control'];
// Positive controls from the user's 2026-09-21 catalog export; NOT discovery queries.
export const DOI_CONTROLS={RP:'10.1016/j.respol.2026.105603',JAR:'10.1111/1475-679x.70085',QJE:'10.1093/qje/qjag047',MS:'10.1287/mnsc.2023.00580',TAR:'10.2308/tar-2024-0518',JM:'10.1177/01492063261480612'};
export function directedQuery(journal,catalogs,mode,now=new Date()){
  assertLibrary(PROBE_MODES.includes(mode)&&mode!=='general','Unsupported directed query');
  if(mode==='doi_control'){assertLibrary(!!DOI_CONTROLS[journal.key],'No positive control for journal');return DOI_CONTROLS[journal.key];}
  const collection=mode.includes('online')?'online':'issue';
  const task=catalogs.find(t=>t.collection===collection);
  assertLibrary(!!task,'Missing catalog target');
  const url=new URL(task.url);
  if(mode.startsWith('url_'))return task.url.slice(0,70);
  // The adapter turns a trailing host-only site operator into the provider's
  // domain filter. A path-prefixed operator is not reliably honored by Pro.
  const suffix=` site:${url.hostname.replace(/^www\./,'')}`;
  const name=journal.name.replace(/^The /,'');
  const online={RP:'in press',TAR:'Early Access',QJE:'Advance Articles',MS:'Articles in Advance',JM:'OnlineFirst',JAR:'Early View'};
  if(/^(native|recent)_/.test(mode))return `${name} ${now.getUTCFullYear()} ${collection==='issue'?'latest issue':online[journal.key]||task.label}`.slice(0,70);
  if(mode==='issn')return `${task.issns[0]} ${now.getUTCFullYear()} latest articles${suffix}`;
  const intent=(mode.startsWith('year_')?' '+now.getUTCFullYear():'')+(collection==='issue'?' issue':' '+(online[journal.key]||'online first'));
  const room=70-suffix.length;
  // Do not truncate the date or intent; the journal identity is checked later.
  return name.slice(0,room-intent.length)+intent+suffix;
}
export async function runDiscoveryProbe({env=process.env,local=false,now=new Date(),configLoader=loadJournalConfig,libraryLoader=readJournalLibrary,
  sourceFactory=makeSearchSources,ledgerFactory=makeSearchBudgetGitHub,save=async()=>{},log=console.log}={}){
  assertLibrary(local?env.PAPER_DISCOVERY_LOCAL_TEST==='1'&&!!env.LOCALAPPDATA:
    env.GITHUB_ACTIONS==='true'&&env.GITHUB_EVENT_NAME==='workflow_dispatch'&&env.GITHUB_REPOSITORY==='w1121188104w-hue/paper-daily','Explicit manual test only');
  assertLibrary(typeof env.ZHIPU_DISCOVERY_API_KEY==='string'&&env.ZHIPU_DISCOVERY_API_KEY.length>=8,'Missing discovery-only search credential');
  const queryMode=env.PROBE_QUERY_MODE||'general',group=env.PROBE_GROUP||'pilot';
  assertLibrary(Object.hasOwn(PROBE_GROUPS,group),'Invalid journal group');
  const journalKeys=PROBE_GROUPS[group];
  assertLibrary(PROBE_MODES.includes(queryMode),'Invalid query mode');
  assertLibrary(queryMode!=='doi_control'||group==='pilot','Controls limited to pilot journals');
  const config=await configLoader(),library=await libraryLoader({config});
  const sources=sourceFactory({zhipuKey:env.ZHIPU_DISCOVERY_API_KEY,serpapiKey:'',zhipuEngine:'search_pro',timeoutMs:25000});
  const ledger=ledgerFactory({token:env.GITHUB_TOKEN,repositoryName:'w1121188104w-hue/paper-daily',scope:'discovery-test-20260924'});
  const initialState=await ledger.read({initialize:true});
  if(!initialState.requests.length)await ledger.persist(initialState);
  const budget=makeDiscoveryTestBudget({initialState,persist:s=>ledger.persist(s),request:o=>sources.request(o)});
  const report={version:1,at:now.toISOString(),mode:'live_search_only',structured_sources:'intentionally_not_run',
    query_mode:queryMode,positive_control_only:queryMode==='doi_control',journal_group:group,journals:journalKeys,requests:[],lead_assessments:[],tasks:[],papers_changed:0,translation_calls:0,website_deployed:false};
  const seen=new Set();
  const search=async o=>{
    assertLibrary(o.provider==='zhipu'&&!seen.has(o.taskId+'|'+o.provider)&&seen.size<6,'Probe cap reached');seen.add(o.taskId+'|'+o.provider);
    const task=ACTIVE_CATALOG_TASKS.find(t=>t.journal===o.taskId.split(':')[1]);
    const filters=/^(native|recent)_/.test(queryMode)?{searchDomainFilter:new URL(task.url).hostname,searchRecencyFilter:queryMode.startsWith('recent_')?'oneMonth':'noLimit'}:{};
    const result=await budget.run({...o,...filters});
    report.requests.push({provider:o.provider,query:o.query,task_id:o.taskId,called:result.called,reason:result.reason||null,
      filters,diagnostic:result.diagnostic||null,leads:(result.result?.leads||[]).map(l=>({title:l.title,url:l.url,snippet:l.snippet}))});
    await checkpoint();return result;
  };
  async function checkpoint(){
    const encoded=JSON.stringify(report,null,2);
    for(const key of [env.ZHIPU_DISCOVERY_API_KEY,env.ZHIPU_API_KEY,env.SERPAPI_API_KEY,env.GITHUB_TOKEN])assertLibrary(!key||!encoded.includes(key),'Credential detected in report');
    await save(report);
  }
  const state=await discoverCollectionTasks({...config,journals:config.journals.filter(j=>journalKeys.includes(j.key))},emptyWorkflow(),library.papers,{
    now,collect:async()=>({source_results:[]}),search,searchProviders:['zhipu'],queryBuilder:queryMode==='general'?null:(j,c)=>directedQuery(j,c,queryMode,now),onLead:async a=>{report.lead_assessments.push(a);await checkpoint();}});
  report.tasks=state.tasks;report.search_monitors=state.monitors.filter(m=>m.source==='search');
  report.actual_search_calls=report.requests.filter(r=>r.called).length;
  report.test_allowance=budget.allowance();
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
