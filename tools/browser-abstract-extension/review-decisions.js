import {identityCandidates,journalOf,doiOf,identityUrl} from './paper-identity.js';
import {CATALOG_TASKS,sameCatalogList} from './catalog-core.js';

export function reviewRecord(p){
  return {id:p.id||null,journal:journalOf(p),doi:doiOf(p)||null,title:p.title_original||p.title||'',
    url:p.url||p.source_url||null,authors:p.authors||p.authors_raw||[],
    abstract:p.abstract_original||p.abstract||null,published_online_date:p.published_online_date||null,
    publication_date:p.publication_date||null,published_print_date:p.published_print_date||null,volume:p.volume||null,issue:p.issue||null,pages:p.pages||null,affiliations:p.affiliations||[],
    source_text_hash:p.source_text_hash||null,
    sources:[...new Map((p.source_records||p.sources||[]).filter(r=>r&&typeof r==='object')
      .map(r=>({source:r.source||null,source_id:r.source_id||null,url:r.url||null,title:r.title||null,doi:r.doi||null}))
      .map(r=>[JSON.stringify(r),r])).values()]};
}
export function attachReviewContext(input,known=[]){
  const candidates=identityCandidates(input.identity,known).slice(0,10).map(reviewRecord);
  return {...input,decision_version:1,...(candidates.length?{existing_records:candidates}:{})};
}
// This is part of each existing catalog review, not a second approval pass.
export function catalogContext(input,page,pages,item){
  const task=CATALOG_TASKS.find(t=>t.id===page.task_id);
  const group=pages.filter(p=>p.task_id===page.task_id&&(!task||p.source_url===page.source_url||sameCatalogList(page.source_url,p.source_url,task))),links=[];
  const blocks=[...input.blocks];
  for(const p of group){
    const text=[...new Set([p.page_title,p.issue_heading,...(p.identity_evidence?.headings||[])].filter(Boolean))].join('\n');
    if(text)blocks.push({id:'directory-'+blocks.length,kind:'context',text,context:'catalog_heading'});
  }
  // Assign diagnostics once per page. Other cards need only their own membership.
  if(page.items?.[0]?.url===item.url)for(const [i,url] of (page.unmatched_article_links||[]).entries()){
    const observed=(page.article_link_contexts||[]).find(x=>identityUrl(x.url)===identityUrl(url));
    const elsewhere=group.flatMap(p=>p.items||[]).find(p=>identityUrl(p.url)===identityUrl(url));
    const id='link-context-'+i;
    if(observed?.text)blocks.push({id,kind:'context',text:observed.text,context:'observed_article_link_section'});
    links.push({url,block_id:observed?.text?id:null,already_collected:!!elsewhere,
      collected_title:elsewhere?.title||null,section:observed?.section||null});
  }
  return {...input,blocks,catalog_context:{task_id:page.task_id,collection:task?.collection||item.catalog_collection||null,
    source_url:page.source_url,issue_heading:page.issue_heading||null,
    pages:group.map(p=>({url:p.source_url,next_links:p.next_links||[],loaded:!p.pagination_unresolved&&!p.more_controls?.length})),
    cards:group.flatMap(p=>(p.items||[]).map(i=>({url:i.url,title:i.title,doi:i.doi||null,section:i.evidence?.section||i.section||null,page_url:p.source_url}))),
    related_links:links}};
}
export function validateDecisions(input,output,quoteSpans){
  if(['record_matches','catalog_links'].some(k=>output[k]!==undefined&&!Array.isArray(output[k])))throw Error('PROVIDER_INVALID_REVIEW_SHAPE');
  const decisions={record_matches:[],catalog_links:[],catalog_membership:null,article_type:null,abstract_applicability:null};
  const proof=value=>{try{return quoteSpans(input.blocks,value.spans);}catch{return null;}};
  for(const match of output.record_matches||[]){
    if(!match||typeof match!=='object')throw Error('PROVIDER_INVALID_REVIEW_SHAPE');
    const old=input.existing_records?.find(p=>p.id&&p.id===match.id);
    if(!old||!['same','different','uncertain'].includes(match.status))continue;
    // Contradictory DOIs stay unresolved; a model must not join distinct records.
    const conflicts=old.doi&&input.identity.doi&&doiOf(old)!==doiOf(input.identity);
    decisions.record_matches.push({id:old.id,status:conflicts?'uncertain':match.status,
      reason:conflicts?'doi_conflict':String(match.reason||'').slice(0,1000)});
  }
  const membership=output.catalog_membership;
  if(input.catalog_context&&['in_scope','out_of_scope','uncertain'].includes(membership?.status)){
    const spans=proof(membership);
    if(spans)decisions.catalog_membership={status:membership.status,proofs:spans};
  }
  for(const value of output.catalog_links||[]){
    if(!value||typeof value!=='object')throw Error('PROVIDER_INVALID_REVIEW_SHAPE');
    const link=input.catalog_context?.related_links.find(l=>l.url===value.url);
    if(!link||!['out_of_scope','already_collected','missing','uncertain'].includes(value.status))continue;
    const spans=proof(value);
    if(value.status==='already_collected'&&!link.already_collected)continue;
    if(value.status==='out_of_scope'&&(!link.block_id||!spans?.some(s=>s.block_id===link.block_id)))continue;
    decisions.catalog_links.push({url:link.url,status:value.status,proofs:spans||[]});
  }
  const type=output.article_type;
  if(['research','correction','retraction','cover','editorial_policy','announcement','other','uncertain'].includes(type?.value)){
    const spans=proof(type);if(spans)decisions.article_type={value:type.value,proofs:spans};
  }
  const applicable=output.abstract_applicability;
  if(['applicable','not_applicable','uncertain'].includes(applicable?.status)){
    const spans=proof(applicable);
    if(spans)decisions.abstract_applicability={status:applicable.status,proofs:spans};
  }
  return decisions;
}
export function decisionOutput(verdict){
  const quoted=v=>v?{...v,spans:(v.proofs||[]).map(s=>({block_id:s.block_id,quote:s.text}))}:undefined;
  return {record_matches:verdict.record_matches||[],catalog_membership:quoted(verdict.catalog_membership),
    catalog_links:(verdict.catalog_links||[]).map(quoted),article_type:quoted(verdict.article_type),
    abstract_applicability:quoted(verdict.abstract_applicability)};
}
