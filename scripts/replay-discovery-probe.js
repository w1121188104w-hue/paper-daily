// Read-only offline replay: no API calls, credentials or production writes.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assessDiscoveryLead} from '../src/services/discoveryLead.js';
import {ACTIVE_CATALOG_TASKS,cleanDoi} from '../tools/browser-abstract-extension/catalog-core.js';
import {emptyWorkflow} from '../src/services/collectionWorkflow.js';
export function replayDiscoveryProbe(catalog,report){
const baselines=[],papers=[];
for(const page of catalog.pages){
 const task=ACTIVE_CATALOG_TASKS.find(t=>t.id===page.task_id);
 if(!task||!page.items?.length)continue;
 if(task.collection==='issue'){
  const text=[page.issue_heading,page.page_title,...page.items.slice(0,1).map(i=>i.evidence?.text)].join(' ');
  let m=text.match(/Volume\s+(\d+)[,\s]+(?:Issue|Number)\s+(\d+)/i);
  // AAA places the verified issue numbers in its article route.
  if(!m&&task.journal==='TAR')m=page.items[0].url?.match(/\/article\/(\d+)\/(\d+)\//);
  if(m)baselines.push({catalog_id:task.id,rank:[+m[1],+m[2]],source_url:page.source_url});
 }
 for(const item of page.items)papers.push({journal_key:page.journal,title_original:item.title,url:item.url,
  doi:cleanDoi(item.doi||item.evidence?.text?.match(/10\.\d{4,9}\/[^\s]+?(?=Research|Erratum|Review|Editorial|\s|$)/)?.[0])});
}
const rows=report.requests.map(request=>{
 const key=request.task_id.split(':')[1],catalogs=ACTIVE_CATALOG_TASKS.filter(t=>t.journal===key);
 const context={journal:{key,name:catalogs[0].name},catalogs,papers,state:emptyWorkflow(),baselines,now:new Date(report.at)};
 const assessments=request.leads.map(l=>({title:l.title,url:l.url,...assessDiscoveryLead(l,context)}));
 return {journal:key,query:request.query,returned:request.leads.length,
  reasons:assessments.reduce((a,x)=>(a[x.reason]=(a[x.reason]||0)+1,a),{}),
  signals:assessments.filter(x=>x.task).map(({task,...a})=>({...a,catalog_id:task.id})),
  issue_evidence:assessments.filter(x=>x.rank).map(({task,...a})=>a)};
});
return {allowance:report.test_allowance,baseline_issues:baselines,rows};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [catalogFile,reportFile]=process.argv.slice(2);
 if(!catalogFile||!reportFile)throw Error('Usage: replay-discovery-probe.js catalog-export.json probe-report.json');
 console.log(JSON.stringify(replayDiscoveryProbe(JSON.parse(fs.readFileSync(catalogFile,'utf8')),JSON.parse(fs.readFileSync(reportFile,'utf8'))),null,2));
}
