import {normalizeDoi,safeSourceUrl} from './core.js';
import {catalogOtherSource,detailOtherSource} from './article-type.js';
import {applyAbstractAvailability} from './abstract-availability.js';
import {excludedJpePaper} from './collection-policy.js';
export function applyDetailTypes(papers,records=[]){
  return papers.map(p=>{
    const record=records.find(r=>r.doi===p.doi&&r.journal===p.journal);
    const source=catalogOtherSource(p)||(record&&detailOtherSource(record));
    return source?{...p,type:'other',field_sources:{...p.field_sources,type:source}}:{...p};
  });
}
export const DETAIL_STATE_KEY='paper_catalog_details_v1';
export const SAMPLE_DETAIL_STATE_KEY='paper_catalog_sample_details_v1';
export const SUPPLEMENT_DETAIL_STATE_KEY='paper_catalog_supplement_details_v1';
// A separate, frozen replacement queue. JPE Just Accepted is retired.
// Never add to or overwrite the original sample.
export function buildSupplementSample(catalogPapers,base,runStartedAt){
  if(!base?.sampling?.coverage||!Array.isArray(base.sample_dois))throw Error('请先完成并保留原抽样测试。');
  const typed=applyDetailTypes(catalogPapers,base.records||[]),original=new Set(base.sample_dois),chosen=new Set(),papers=[],coverage=[];
  const member=(p,collection)=>p.catalog_memberships?.some(m=>m.collection===collection&&(!runStartedAt||m.captured_at>=runStartedAt));
  const usable=p=>p&&!excludedJpePaper(p)&&p.type!=='other'&&p.title&&normalizeDoi(p.doi)&&safeSourceUrl(p.url)&&applyAbstractAvailability(p).abstract_status!=='confirmed_absent';
  function select(journal,collection,needed,candidates,reason){
    const picked=[];
    for(const p of candidates){
      if(picked.length>=needed)break;
      if(!usable(p)||original.has(p.doi)||picked.includes(p.doi))continue;
      picked.push(p.doi);
      if(!chosen.has(p.doi)){chosen.add(p.doi);papers.push({doi:p.doi,title:p.title,journal:p.journal,url:safeSourceUrl(p.url)});}
    }
    coverage.push({journal,collection,reason,needed,selected:picked,shortfall:needed-picked.length});
  }
  for(const c of base.sampling.coverage){
    const removed=(c.selected||[]).filter(doi=>typed.some(p=>p.doi===doi&&p.journal===c.journal&&p.type==='other')).length;
    if(removed)select(c.journal,c.collection,removed,typed.filter(p=>p.journal===c.journal&&member(p,c.collection)),'replace_nonresearch');
  }
  return {papers,coverage,excluded:[],policy:'nonresearch_replacements_only_v2'};
}
// Browser storage may reorder object keys and older records can carry extra
// metadata. Validate identity/safety without rebuilding or filtering history.
export function validateFrozenDetailPapers(papers,max=500){
  if(!Array.isArray(papers)||papers.length>max)throw Error('旧队列数量或格式无效，未覆盖旧数据。');
  const seen=new Set();
  for(const p of papers){
    if(!p||typeof p.doi!=='string'||!normalizeDoi(p.doi)||normalizeDoi(p.doi)!==p.doi||seen.has(p.doi))
      throw Error('旧队列 DOI 无效或重复，未覆盖旧数据。');
    if(typeof p.title!=='string'||!p.title.trim()||p.title.length>1500||typeof p.journal!=='string'||!p.journal.trim())
      throw Error('旧队列标题或期刊无效，未覆盖旧数据。');
    if(typeof p.url!=='string'||!safeSourceUrl(p.url)||safeSourceUrl(p.url)!==p.url)
      throw Error('旧队列网址未通过安全校验，未覆盖旧数据。');
    seen.add(p.doi);
  }
  return papers;
}
// Separate, frozen sample queue: never append a full catalog on resume.
export function buildCatalogSample(catalogPapers,tasks,runStartedAt){
  catalogPapers=applyDetailTypes(catalogPapers);
  const papers=[],coverage=[],seen=new Set();
  for(const journal of [...new Set(tasks.map(t=>t.journal))])for(const collection of ['issue','online']){
    const candidates=catalogPapers.filter(p=>p.journal===journal&&!excludedJpePaper(p)&&p.type!=='other'&&normalizeDoi(p.doi)&&safeSourceUrl(p.url)&&p.title&&
      (p.catalog_memberships||[]).some(m=>m.collection===collection&&(!runStartedAt||m.captured_at>=runStartedAt)));
    const selected=candidates.slice(0,3);
    coverage.push({journal,collection,available:candidates.length,selected:selected.map(p=>normalizeDoi(p.doi)),shortfall:Math.max(0,3-selected.length)});
    for(const p of selected){const doi=normalizeDoi(p.doi);if(seen.has(doi))continue;seen.add(doi);
      papers.push({doi,title:p.title,journal:p.journal,url:safeSourceUrl(p.url)});}
  }
  return {papers,coverage,excluded:[],policy:'per_journal_issue_3_online_3_v1'};
}
export function reconcileDetailQueue(saved,current){
  if(!saved?.detail_papers)return {papers:current,saved};
  const prior=validateFrozenDetailPapers(saved.detail_papers);
  if(prior.length!==saved.detail_papers.length || JSON.stringify(prior.map(p=>p.doi))!==JSON.stringify(saved.sample_dois) || !Array.isArray(saved.queue))throw Error('详情进度不匹配，未覆盖旧记录。');
  const known=new Set(prior.map(p=>p.doi)),fresh=current.filter(p=>!known.has(p.doi));
  if(prior.length+fresh.length>500)throw Error('累计详情队列超过500条，请先导出；未删除旧记录。');
  const papers=[...prior,...fresh];
  return {papers,saved:{...saved,sample_dois:papers.map(p=>p.doi),detail_papers:papers,queue:[...saved.queue,...fresh.map(p=>p.doi)]}};
}
export function buildDetailQueue(catalogPapers,{preserveExisting=false}={}) {
  const papers=[],excluded=[],seen=new Set();
  for(const p of preserveExisting?catalogPapers:applyDetailTypes(catalogPapers)){
    const doi=normalizeDoi(p.doi),url=safeSourceUrl(p.url);
    let reason=!preserveExisting&&excludedJpePaper(p)?'excluded_by_user':!preserveExisting&&p.type==='other'?'other':!doi?'no_doi_yet':!url?'unsupported_url':!p.title?'missing_title':seen.has(doi)?'duplicate':null;
    if(reason){excluded.push({doi:doi||null,title:p.title,reason});continue;}
    if(papers.length>=500){excluded.push({doi,title:p.title,reason:'queue_limit_500'});continue;}
    seen.add(doi);papers.push({doi,title:p.title,journal:p.journal,url});
  }
  return {papers,excluded};
}
export function mergeDetailPapers(catalogPapers,records){
  return applyDetailTypes(catalogPapers,records).map(p=>{
    const r=records.find(x=>x.doi===p.doi && x.journal===p.journal);
    if(!r)return {...p};
    const out={...p,detail_status:r.review_status,affiliations:p.affiliations||[],affiliation_status:p.affiliation_status||r.affiliation_status,
      detail_source_url:r.source_url,field_sources:{...p.field_sources}};
    if(!out.abstract&&r.abstract_status==='confirmed_absent'){
      out.abstract=null;out.abstract_status='confirmed_absent';out.abstract_absence=r.abstract_absence;
      out.field_sources.abstract_absence=r.abstract_absence;
    }
    if(!['source_checked_candidate','needs_attention'].includes(r.review_status))return out;
    if(r.affiliations?.length){out.affiliations=r.affiliations;out.affiliation_status=r.affiliation_status;}
    if(r.abstract){out.abstract=r.abstract;out.abstract_status=r.abstract_status;out.abstract_source=r.abstract_source;out.abstract_source_url=r.abstract_source_url;
      delete out.abstract_absence;delete out.field_sources.abstract_absence;
      out.abstract_length=r.abstract_length;out.abstract_sha256=r.abstract_sha256;out.abstract_field=r.abstract_field;
      out.field_sources.abstract={method:r.abstract_provenance?'deepseek_checked_ocr':'deepseek_source_checked',source_url:r.source_url,proofs:r.field_proofs?.abstract,...(r.abstract_provenance?{ocr:r.abstract_provenance}:{})};}
    if(r.authors_raw){out.authors_raw=r.authors_raw;out.field_sources.authors_raw={method:'deepseek_source_checked',source_url:r.source_url,proofs:r.field_proofs?.authors};}
    if(r.publication_month){out.publication_month=r.publication_month;out.field_sources.publication_month={method:'deepseek_source_checked',source_url:r.source_url,proofs:r.field_proofs?.publication_date};}
    if(r.affiliations?.length)out.field_sources.affiliations={method:'deepseek_source_checked',source_url:r.source_url,proofs:r.affiliations.map(a=>a.proof)};
    return out;
  });
}
