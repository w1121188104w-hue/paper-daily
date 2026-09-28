// Reuse already paid probe evidence against persisted baselines. Never calls
// any API, advances a verified baseline, imports papers or publishes a site.
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readWorkflow,saveWorkflow,addDiscoverySignals,validateWorkflow} from '../src/services/collectionWorkflow.js';
import {baselineKnownPapers} from '../src/services/catalogBaseline.js';
import {assessDiscoveryLead} from '../src/services/discoveryLead.js';
import {ACTIVE_CATALOG_TASKS} from '../tools/browser-abstract-extension/catalog-core.js';
import {withLibraryLock} from '../src/services/journalLibrary.js';
import {assertLibrary} from '../src/services/libraryValidation.js';

export function replaySavedDiscovery(state,report,{now=new Date()}={}){
  validateWorkflow(state);
  assertLibrary(report?.mode==='live_search_only'&&!report.positive_control_only&&Array.isArray(report.requests)&&
    Number.isFinite(Date.parse(report.at))&&Date.parse(report.at)<=now.getTime()&&now.getTime()-Date.parse(report.at)<=7*86400000,
    '只复用七天内非对照组实测报告');
  const observations=[];
  for(const request of report.requests){
    if(!request.called||request.reason||request.provider!=='zhipu')continue;
    const journal=request.task_id?.split(':')[1],catalogs=ACTIVE_CATALOG_TASKS.filter(t=>t.journal===journal);
    if(!catalogs.length)continue;
    for(const lead of request.leads||[]){
      const result=assessDiscoveryLead(lead,{journal:{key:journal,name:catalogs[0].name},catalogs,
        state,papers:baselineKnownPapers(state),baselines:state.catalog_baselines||[],now});
      if(result.task)observations.push({catalog_id:result.task.id,source:'zhipu',title:lead.title,doi:result.doi,
        source_url:lead.url,catalog_url:result.catalog_url,change_key:result.rank?.join(':')||''});
    }
  }
  return observations.length?addDiscoverySignals(state,observations,{now}):structuredClone(state);
}
async function main(){
  const {values:v}=parseArgs({options:{input:{type:'string'},save:{type:'boolean'}}});
  assertLibrary(v.input&&(await fs.stat(v.input)).size<=10*1024*1024,'Usage: --input saved-report.json [--save]');
  const report=JSON.parse(await fs.readFile(v.input,'utf8')),repositoryRoot=fileURLToPath(new URL('../',import.meta.url));
  const apply=async()=>{
    const before=await readWorkflow(repositoryRoot),state=replaySavedDiscovery(before,report);
    if(v.save&&JSON.stringify(state)!==JSON.stringify(before))await saveWorkflow(repositoryRoot,state);
    console.log(JSON.stringify({saved:!!v.save,paid_calls:0,papers_changed:0,tasks:state.tasks.filter(t=>t.status==='pending').map(t=>({catalog_id:t.catalog_id,journal:t.journal,url:t.url,signals:t.signals.length}))}));
  };
  if(v.save)await withLibraryLock(path.join(repositoryRoot,'data/collection-workflow'),apply);else await apply();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{
  console.error('SAVED_DISCOVERY_REPLAY_FAILED: no API requests; original workflow retained.');process.exitCode=1;
});
