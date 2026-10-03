import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeWorkflowJson} from './workflowStorage.js';
import {assertLibrary} from './libraryValidation.js';
import {missingPaperFields} from './sourceReview.js';
import {classifyPaper} from './paperClassification.js';
import {applyAbstractAvailability} from '../../tools/browser-abstract-extension/abstract-availability.js';
export const FIELD_TASKS_PATH='data/collection-workflow/field-tasks.json';
export async function readFieldTasks(repo){
  try{const q=JSON.parse(await fs.readFile(path.join(repo,FIELD_TASKS_PATH),'utf8'));
    assertLibrary(q.version===1&&Array.isArray(q.papers)&&q.papers.every(p=>typeof p.id==='string'&&Array.isArray(p.missing_fields)),'字段待办格式无效');return q;
  }catch(e){if(e.code==='ENOENT')return {version:1,papers:[]};throw e;}
}
export function pendingFields(paper){
  if(classifyPaper(paper).kind==='other')return [];
  const absent=applyAbstractAvailability({doi:paper.doi,journal:paper.journal_key,title:paper.title_original}).abstract_status==='confirmed_absent';
  return missingPaperFields(paper).filter(f=>f!=='abstract'||!absent);
}
export async function reconcileFieldTasks(repo,papers,{paperIds=[],branch='browser',now=new Date()}={}){
  const q=await readFieldTasks(repo),selected=new Set([...paperIds,...q.papers.map(p=>p.id)]);
  for(const paper of papers.filter(p=>selected.has(p.id))){
    const missing_fields=pendingFields(paper),fingerprint=createHash('sha256').update(JSON.stringify([paper.source_text_hash,paper.authors,paper.publication_date,paper.published_online_date,paper.published_print_date,paper.affiliations])).digest('hex');
    const old=q.papers.find(p=>p.id===paper.id);
    if(old?.fingerprint===fingerprint)continue;
    const row={id:paper.id,doi:paper.doi,journal:paper.journal_key,title:paper.title_original,url:paper.url,
      missing_fields,status:missing_fields.length?'pending':'complete',fingerprint,branch,updated_at:now.toISOString(),
      next_retry_at:old?new Date(now.getTime()+7*86400000).toISOString():null};
    if(old)q.papers[q.papers.indexOf(old)]=row;else q.papers.push(row);
  }
  await writeWorkflowJson(path.join(repo,FIELD_TASKS_PATH),q);return q;
}
