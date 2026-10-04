import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
/** Supersede only byte-equivalent saved evidence, never by dates or counts. */
export function captureContains(newer,older){
  if(!newer.parent_run_id||newer.parent_run_id!==older.parent_run_id)return false;
  for(const field of ['ai_review_results','catalog_review_results']){
    for(const [key,value] of Object.entries(older[field]||{}))if(hash(value)!==hash(newer[field]?.[key]??null))return false;
  }
  for(const [a,b] of [[newer.records,older.records],[newer.catalog?.pages,older.catalog?.pages]]){
    if(!Array.isArray(a)||!Array.isArray(b))return false;
    const current=new Set(a.map(hash));if(b.some(row=>!current.has(hash(row))))return false;
  }
  return true;
}
