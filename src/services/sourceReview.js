import {createHash} from 'node:crypto';
import {normalizeSourceRecord,cleanText,normalizePartialDate} from './paperModel.js';
import {knownJournalMismatch} from './journalIdentity.js';
import {compactArticleInput,verdictOutput,canonicalEvidence} from '../../tools/browser-abstract-extension/article-review.js';
import {validateReviewInput,validateReviewOutput,SOURCE_REVIEW_FIELDS} from '../../tools/browser-abstract-extension/review-core.js';
import {checkedResponse,reviewFingerprint,canRetryReview} from '../../tools/browser-abstract-extension/review-client.js';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dateFields=['publication_date','published_online_date','published_print_date'];
function sourceUrl(r){
  if(r.source==='crossref')return 'https://api.crossref.org/works/'+encodeURIComponent(r.source_id);
  if(r.source==='openalex')return 'https://api.openalex.org/works/'+r.source_id.replace(/^https:\/\/openalex.org\//,'');
  if(r.source==='semanticscholar')return 'https://api.semanticscholar.org/graph/v1/paper/'+r.source_id;
  return r.url;
}
/** Evidence is captured BEFORE field selection, never assembled from model output. */
export function sourceReviewInput(value){
  const record=normalizeSourceRecord(value);
  if(knownJournalMismatch(record))throw Error('WRONG_JOURNAL');
  const blocks=[],put=(id,kind,text,context)=>{if(text)blocks.push({id,kind,text,context});};
  put('title','title',record.title,'source:title');
  put('doi','doi',record.doi,'source:doi');
  put('authors','context',record.authors.map(a=>a.name).join('; '),'source:authors; preserve original array boundaries');
  put('abstract','abstract',record.abstract,'source:abstract; candidate extracted from raw_abstract');
  for(const f of [...dateFields,'volume','issue','pages','type'])put(f.replaceAll('_','-'),'context',record[f],`source:${f}`);
  const {last_checked_at,source_created_at,source_updated_at,source_evidence,...original}=record;
  // Fetch times / body hashes are retained by the queue, but not part of the
  // semantic input: another identical download must reuse the paid verdict.
  put('original-record','context',JSON.stringify(original),'original_record: complete captured source record');
  const proposed=Object.fromEntries(['title','doi','abstract',...dateFields,'volume','issue','pages','type'].map(f=>[f,record[f]||null]));
  proposed.authors=record.authors.map(a=>a.name).join('; ')||null;
  const input=compactArticleInput({kind:'article',source_url:sourceUrl(record),source_kind:record.source,source_record_review_version:1,
    identity:{title:record.title,doi:record.doi||null,journal:record.journal_key},blocks,proposed});
  return validateReviewInput(input);
}
export async function reviewJob(input,request,{retry=false,cached}={}){
  const hash=await reviewFingerprint(input);
  let result=cached;
  const unbilled=result&&!result.fingerprint&&['SESSION_LIMIT','BUSY'].includes(result.error);
  if(!result||unbilled||retry&&canRetryReview(result)){
    const response=await request(input,result&&!unbilled?{retryAttempt:result.attempt}:{});
    result=checkedResponse(input,response);
  }
  return {hash,result};
}
/** Only model-selected exact spans enter the accepted record; missing is partial success. */
export function reviewedSource(value,input,result){
  const original=normalizeSourceRecord(value);
  if(!result?.input||canonicalEvidence(result.input)!==canonicalEvidence(input))return null;
  if(!result?.verdict||(result.error&&result.error!=='PROVIDER_ABSTRACT_NOT_EXTRACTED'))return null;
  const checked=validateReviewOutput(input,verdictOutput(input,result.verdict));
  if(checked.status!=='source_checked_candidate'||!checked.fields.title||cleanText(checked.fields.title)!==original.title||
    original.doi&&checked.fields.doi!==original.doi)return null;
  const selected={...original,abstract:checked.fields.abstract||'',authors:[],publication_date:'',published_online_date:'',published_print_date:'',volume:'',issue:'',pages:'',type:'',
    ...(original.affiliations!==undefined?{affiliations:checked.affiliations||[]}:{})};
  if(checked.fields.authors===original.authors.map(a=>a.name).join('; '))selected.authors=original.authors;
  for(const f of [...dateFields,...SOURCE_REVIEW_FIELDS]){
    const v=checked.fields[f];if(v&&v===original[f])selected[f]=dateFields.includes(f)?normalizePartialDate(v):v;
  }
  // Unselected raw text is retained as evidence, not materialized paper content.
  selected.raw_dates={...original.raw_dates,source_review:{version:1,input_sha256:sha(input),input,
    verdict:checked,checked_at:result.checked_at,provider_fingerprint:result.fingerprint||null,
    field_states:checked.states,missing_fields:['abstract','authors','publication_date'].filter(f=>!checked.fields[f])}};
  return normalizeSourceRecord(selected);
}
export function missingPaperFields(paper){
  return ['abstract','authors','publication_date','affiliations'].filter(f=>f==='abstract'?!paper.abstract_original:
    f==='publication_date'?!paper.publication_date&&!paper.published_online_date&&!paper.published_print_date:!paper[f]?.length);
}
export function hasNewSourceFields(record,papers){
  const old=papers.find(p=>p.journal_key===record.journal_key&&(record.doi?p.doi===record.doi:p.source_records.some(r=>r.source===record.source&&r.source_id===record.source_id)));
  if(!old)return true;
  return !old.abstract_original&&!!record.abstract||!old.authors.length&&!!record.authors.length||
    dateFields.some(f=>!old[f]&&!!record[f])||!old.affiliations?.length&&!!record.affiliations?.length;
}
