// Compact, reproducible local audit. Does not write the library or call any API.
import fs from 'node:fs';
import path from 'node:path';
import {replayDiscoveryProbe} from './replay-discovery-probe.js';
import {titleKey} from '../tools/browser-abstract-extension/catalog-core.js';
const [catalogFile,reportDirectory]=process.argv.slice(2);
const catalog=JSON.parse(fs.readFileSync(catalogFile,'utf8'));
const files=fs.readdirSync(reportDirectory).filter(f=>/^discovery-v2-result-\d+\.json$/.test(f));
for(const file of files){
 const report=JSON.parse(fs.readFileSync(path.join(reportDirectory,file),'utf8'));
 if(!report.test_allowance)continue;
 const replay=replayDiscoveryProbe(catalog,report);
 console.log(JSON.stringify({run:file.match(/result-(\d+)/)[1],mode:report.query_mode||'general',group:report.journal_group||'pilot',used:report.test_allowance.used,
 rows:replay.rows.map((r,i)=>{
  const leadText=titleKey(report.requests[i].leads.map(l=>l.title+' '+l.snippet).join(' '));
  const online=catalog.pages.filter(p=>p.journal===r.journal).flatMap(p=>p.items||[]).filter(p=>p.catalog_collection==='online');
  const knownMatches=[...new Set(online.filter(p=>titleKey(p.title).length>30&&leadText.includes(titleKey(p.title))).map(p=>p.title))];
  return {journal:r.journal,returned:r.returned,currentIssueMatched:r.issue_evidence.some(x=>x.baseline&&x.rank.every((v,i)=>v===x.baseline[i])),knownOnlineTitles:knownMatches.length,
    signals:r.signals.map(s=>({title:s.title,url:s.url,reason:s.reason})),reasons:r.reasons};
 })}));
}
