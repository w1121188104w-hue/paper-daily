import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeWorkflowJson} from './workflowStorage.js';
import {assertLibrary} from './libraryValidation.js';
import {missingPaperFields} from './sourceReview.js';
import {applyAbstractAvailability} from '../../tools/browser-abstract-extension/abstract-availability.js';
import {activeMissingFields,COLLECTION_POLICY_VERSION,confirmedAbstractAbsent} from '../../tools/browser-abstract-extension/collection-policy.js';
import {findPaper} from '../../tools/browser-abstract-extension/paper-identity.js';
export const FIELD_TASKS_PATH='data/collection-workflow/field-tasks.json';
export async function readFieldTasks(repo){
  try{const q=JSON.parse(await fs.readFile(path.join(repo,FIELD_TASKS_PATH),'utf8'));
    assertLibrary(q.version===1&&Array.isArray(q.papers)&&q.papers.every(p=>typeof p.id==='string'&&Array.isArray(p.missing_fields)),'字段待办格式无效');return q;
  }catch(e){if(e.code==='ENOENT')return {version:1,papers:[]};throw e;}
}
export function pendingFields(paper){
  const absent=confirmedAbstractAbsent(paper)||
    applyAbstractAvailability({doi:paper.doi,journal:paper.journal_key,title:paper.title_original}).abstract_status==='confirmed_absent';
  return absent?[]:activeMissingFields(missingPaperFields(paper));
}
export function projectFieldTasks(queue,papers,{paperIds=[],branch='browser',now=new Date()}={}){
  const q=structuredClone(queue),selected=new Set([...paperIds,...q.papers.map(p=>p.id)]);
  for(const old of q.papers){
    const canonical=papers.find(p=>p.id===old.id)||findPaper(old,papers);
    if(canonical)selected.add(canonical.id);
    if(canonical&&canonical.id!==old.id){old.status='resolved_alias';old.canonical_id=canonical.id;}
    else if(!activeMissingFields(old.missing_fields).length){old.status='inactive';old.reason='outside_active_supplement_scope';}
  }
  for(const paper of papers.filter(p=>selected.has(p.id))){
    const missing_fields=pendingFields(paper),fingerprint=createHash('sha256').update(JSON.stringify([COLLECTION_POLICY_VERSION,paper.source_text_hash,missing_fields])).digest('hex');
    const old=q.papers.find(p=>p.id===paper.id);
    if(old?.fingerprint===fingerprint)continue;
    const row={id:paper.id,doi:paper.doi,journal:paper.journal_key,title:paper.title_original,url:paper.url,
      missing_fields,status:missing_fields.length?'pending':'complete',fingerprint,branch,updated_at:now.toISOString(),
      next_retry_at:old?new Date(now.getTime()+7*86400000).toISOString():null};
    if(old)q.papers[q.papers.indexOf(old)]=row;else q.papers.push(row);
  }
  return q;
}
export async function reconcileFieldTasks(repo,papers,options={}){
  const q=projectFieldTasks(await readFieldTasks(repo),papers,options);
  await writeWorkflowJson(path.join(repo,FIELD_TASKS_PATH),q);return q;
}
