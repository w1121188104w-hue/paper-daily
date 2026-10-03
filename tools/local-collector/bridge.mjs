import fs from 'node:fs/promises';
import {ACTIVE_CATALOG_TASKS,assessCatalog,articleUrl,catalogUrl} from '../browser-abstract-extension/catalog-core.js';
import {assessCapture} from '../browser-abstract-extension/core.js';
import {excludedJpePaper} from '../browser-abstract-extension/collection-policy.js';
const [inputFile,outputFile]=process.argv.slice(2);
const {task,capture}=JSON.parse(await fs.readFile(inputFile,'utf8'));
let result,next=[];
if(task.kind==='catalog'){
  const configured=ACTIVE_CATALOG_TASKS.find(t=>t.id===task.catalog_id);
  if(!configured||configured.journal!==task.journal||!catalogUrl(task.url,configured))throw Error('INVALID_CATALOG_TASK');
  result={...assessCatalog(configured,capture),captured_at:capture.captured_at,requested_url:task.url,job_key:configured.id+'|'+task.url};
  for(const url of [...(result.next_links||[]),...(result.issue_target?[result.issue_target]:[])])if(catalogUrl(url,configured))
    next.push({kind:'catalog',catalog_id:configured.id,journal:configured.journal,url,depth:(task.depth||0)+1});
  for(const p of result.items||[])if(p.doi&&p.title&&p.type!=='other'&&!excludedJpePaper(p)&&articleUrl(p.url,configured))
    next.push({kind:'article',catalog_id:configured.id,journal:configured.journal,doi:p.doi,title:p.title,url:p.url});
}else{
  const configured=ACTIVE_CATALOG_TASKS.find(t=>t.id===task.catalog_id&&t.journal===task.journal);
  if(!configured||!articleUrl(task.url,configured))throw Error('INVALID_ARTICLE_TASK');
  result={...task,...assessCapture(task,capture),extracted_at:capture.captured_at,evidence:capture.evidence||[],
    evidence_version:capture.evidence_version,affiliation_candidates:capture.affiliation_candidates||[],affiliation_extraction_version:capture.affiliation_extraction_version};
}
await fs.writeFile(outputFile,JSON.stringify({result,next})+'\n');
