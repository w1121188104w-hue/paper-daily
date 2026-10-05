import {validateReviewOutput} from '../../tools/browser-abstract-extension/review-core.js';
import {verdictOutput} from '../../tools/browser-abstract-extension/article-review.js';
import {reviewRecord} from '../../tools/browser-abstract-extension/review-decisions.js';
import {buildSourceTextHash,doiUrl,cleanText,cleanAbstract} from './paperModel.js';
import {sourceDate} from '../../tools/browser-abstract-extension/collection-policy.js';

export function sourceReviewProof(source){
  const proof=source.raw_dates?.content_review||source.raw_dates?.source_review;
  if(!proof?.input||!proof.verdict)return null;
  try{
    const checked=validateReviewOutput(proof.input,verdictOutput(proof.input,proof.verdict));
    // Compare the stored representation using the same deterministic decoding
    // and whitespace cleanup as normalizeSourceRecord; original spans stay intact.
    if(source.title!==cleanText(checked.fields.title) || source.abstract && source.abstract!==cleanAbstract(checked.fields.abstract))return null;
    return checked.status==='source_checked_candidate'?{...proof,verdict:checked}:null;
  }catch{return null;}
}
export function correctionAuthority(source,paper){
  const proof=sourceReviewProof(source);
  const prior=proof?.input.existing_records?.find(p=>p.id===paper.id);
  if(!prior||source.journal_key!==paper.journal_key||source.doi&&paper.doi&&source.doi!==paper.doi||
    !proof.verdict.record_matches?.some(r=>r.id===paper.id&&r.status==='same'))return null;
  const current=reviewRecord(paper);
  const applied=paper.source_records.some(r=>r.source===source.source&&r.source_id===source.source_id&&
    JSON.stringify(r.raw_dates?.content_review||r.raw_dates?.source_review)===JSON.stringify(proof));
  // Bind corrections to the old values actually presented to the reviewer.
  if(['title','abstract','doi','authors','url','published_online_date','published_print_date','publication_date','volume','issue','pages','affiliations'].some(f=>
    JSON.stringify(prior[f]||null)!==JSON.stringify(current[f]||null)&&!(applied&&JSON.stringify(source[f]||null)===JSON.stringify(current[f]||null))))return null;
  return proof;
}
export function applyReviewedSource(paper,source,{allowCorrection=false,checkedAt}={}){
  const next=structuredClone(paper),proof=allowCorrection?correctionAuthority(source,paper):null,changed=[];
  const seen=next.source_records.some(r=>JSON.stringify(r)===JSON.stringify(source)||r.source===source.source&&r.source_id===source.source_id&&
    JSON.stringify(r.raw_dates?.content_review||r.raw_dates?.source_review)===JSON.stringify(source.raw_dates?.content_review||source.raw_dates?.source_review));
  if(!seen)next.source_records.push(structuredClone(source));
  next.sources=[...new Set(next.source_records.map(r=>r.source))].sort();
  const selected=proof?.verdict;
  for(const field of ['title','abstract','authors','published_online_date','published_print_date','publication_date','volume','issue','pages','url','affiliations']){
    const key=['title','abstract'].includes(field)?field+'_original':field;
    const value=source[field],present=v=>Array.isArray(v)?v.length>0:!!v;
    if(!present(value)||JSON.stringify(next[key])===JSON.stringify(value))continue;
    const proven=field==='affiliations'?selected?.affiliations?.length:
      field==='authors'?selected?.fields.authors: field==='title'?cleanText(selected?.fields.title)===value:
      field==='abstract'?cleanAbstract(selected?.fields.abstract)===value:field.includes('date')?sourceDate(selected?.fields[field])===value:selected?.fields[field]===value;
    if(present(next[key])&&!proven)continue;
    next[key]=structuredClone(value);changed.push(key);
    if(field==='authors')next.provenance.authors=value.map(a=>({name:source.source,orcid:a.orcid?source.source:null}));
    else if(field!=='affiliations')next.provenance[key]={source:source.source,source_id:source.source_id};
  }
  if(!next.doi&&source.doi){next.doi=source.doi;next.doi_url=doiUrl(source.doi);next.provenance.doi=[{source:source.source,source_id:source.source_id}];changed.push('doi');}
  next.source_text_hash=buildSourceTextHash(next.title_original,next.abstract_original);
  for(const field of ['title','abstract'])if(next.source_text_hash[field]!==paper.source_text_hash[field])
    next[field+'_translation_status']=next[field+'_zh']?'outdated':'pending';
  if(changed.length)next.last_checked_at=checkedAt||source.last_checked_at;
  return {paper:next,changed,review_added:!seen,corrected:!!proof};
}
