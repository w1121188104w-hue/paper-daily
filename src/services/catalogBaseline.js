import {ACTIVE_CATALOG_TASKS,catalogUrl,articleUrl,cleanDoi,titleKey} from '../../tools/browser-abstract-extension/catalog-core.js';
import {catalogMembership} from '../../tools/browser-abstract-extension/catalog-scope.js';
import {issueRank} from './discoveryLead.js';
import {assertLibrary} from './libraryValidation.js';

const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x));
const compare=(a,b)=>a[0]-b[0]||a[1]-b[1];
export const AUDIT_INTERVAL_DAYS=14;
export const compareIssuePosition=(a,b)=>a.issue_year&&b.issue_year&&+a.issue_year!==+b.issue_year?+a.issue_year-+b.issue_year:compare(a.rank,b.rank);
export function catalogPagesForJob(pages,job,task){
  const candidates=pages.filter(p=>p.task_id===task.id),root=candidates.find(p=>[p.source_url,p.requested_url].includes(job.url));
  if(!root)return candidates;
  const selected=[root];
  for(let i=0;i<selected.length;i++)for(const p of candidates)if(!selected.includes(p)&&
    [...(selected[i].next_links||[]),selected[i].issue_target].filter(Boolean).some(u=>[p.source_url,p.requested_url].includes(u)))selected.push(p);
  return selected;
}
export function validateBaselines(rows=[]){
  assertLibrary(Array.isArray(rows)&&rows.length<=2000,'目录基线格式无效');
  const seen=new Set();
  for(const b of rows){
    const t=ACTIVE_CATALOG_TASKS.find(t=>t.id===b.catalog_id),key=b.catalog_id+'|'+b.url;
    assertLibrary(t&&b.journal===t.journal&&b.collection===t.collection&&catalogUrl(b.url,t)===b.url&&!seen.has(key)&&
      time(b.checked_at)&&typeof b.receipt_id==='string'&&/^[a-f0-9]{64}$/.test(b.input_sha256)&&
      Array.isArray(b.source_urls)&&b.source_urls.length>0&&b.source_urls.every(u=>catalogUrl(u,t)===u)&&
      (b.rank===null||(t.collection==='issue'&&Array.isArray(b.rank)&&b.rank.length===2&&b.rank.every(Number.isInteger)&&b.rank[0]>0&&b.rank[1]>=0))&&
      Array.isArray(b.papers)&&b.papers.length<=20000,'目录基线身份或证据无效');
    for(const p of b.papers)assertLibrary(typeof p.title==='string'&&p.title.trim()&&p.title.length<=1500&&
      articleUrl(p.url,t)===p.url&&(p.doi===null||!!p.doi&&cleanDoi(p.doi)===p.doi),'目录基线论文无效');
    seen.add(key);
  }
  return rows;
}
// Only page headings or allowlisted issue routes determine an issue, never card
// references, copyright years or the numeric ID of an AEA issue.
export function capturedIssueRank(pages,task){
  if(task.collection!=='issue')return null;
  const ranks=[];
  for(const p of pages){
    const route=issueRank(p.source_url,task);if(route)ranks.push(route);
    const text=[p.issue_heading,p.page_title].filter(Boolean).join(' ');
    for(const m of text.matchAll(/Vol(?:ume)?\.?\s+(\d+)[,\s]+(?:Issue|Number|No\.?)\s+(\d+)/gi))ranks.push([+m[1],+m[2]]);
  }
  const unique=[...new Map(ranks.map(r=>[r.join(':'),r])).values()];
  return unique.length===1?unique[0]:null;
}
export function recordCatalogBaseline(state,job,pages,checked,{receiptId,inputHash}){
  const task=ACTIVE_CATALOG_TASKS.find(t=>t.id===job.catalog_id);
  const captured=catalogPagesForJob(pages,job,task);
  const checkedAt=captured.map(p=>p.captured_at).filter(time).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1);
  if(!checkedAt)return;
  const rows=state.catalog_baselines||=[],old=rows.find(b=>b.catalog_id===task.id&&b.url===job.url);
  if(old&&Date.parse(old.checked_at)>=Date.parse(checkedAt))return;
  const rank=capturedIssueRank(captured,task);
  // A stale publisher cache must not roll a verified issue backwards or refresh
  // the current-catalog audit deadline using an older issue.
  const years=[...new Set(captured.map(p=>catalogMembership(p,task).issue_year).filter(Boolean))],issue_year=years.length===1?years[0]:null;
  if(old?.rank&&rank&&compareIssuePosition({rank,issue_year},old)<0)return;
  const papers=checked.filter(p=>p.review_status==='source_checked_candidate'&&p.journal===task.journal&&
    p.review_decisions?.catalog_membership?.status!=='out_of_scope'&&p.review_decisions?.catalog_membership?.status!=='uncertain'&&
    p.catalog_memberships?.some(m=>m.task_id===task.id&&captured.some(c=>c.source_url===m.catalog_url))).map(p=>({doi:cleanDoi(p.doi)||null,title:p.title,url:articleUrl(p.url,task)}))
    .filter(p=>p.url&&p.title?.trim()&&p.title.length<=1500);
  const value={catalog_id:task.id,journal:task.journal,collection:task.collection,url:job.url,
    source_urls:[...new Set(captured.map(p=>catalogUrl(p.source_url,task)).filter(Boolean))],checked_at:checkedAt,
    receipt_id:receiptId,input_sha256:inputHash,rank:rank||old?.rank||null,issue_year,complete:true,
    papers:[...new Map(papers.map(p=>[p.doi||titleKey(p.title),p])).values()]};
  state.catalog_baselines=[...rows.filter(b=>b!==old),value];validateBaselines(state.catalog_baselines);
}
export function mergeCatalogBaselines(state,rows){
  validateBaselines(rows);
  for(const b of rows){
    const current=state.catalog_baselines||[],old=current.find(x=>x.catalog_id===b.catalog_id&&x.url===b.url);
    if(old&&(Date.parse(old.checked_at)>=Date.parse(b.checked_at)||old.rank&&b.rank&&compareIssuePosition(b,old)<0))continue;
    state.catalog_baselines=[...current.filter(x=>x!==old),structuredClone({...b,rank:b.rank||old?.rank||null})];
  }
  validateBaselines(state.catalog_baselines);
}
export function baselineKnownPapers(state){
  return (state.catalog_baselines||[]).flatMap(b=>b.papers.map(p=>({journal_key:b.journal,title_original:p.title,doi:p.doi,url:p.url})));
}
export function catalogChecks(state,{now=new Date()}={}){
  const days=state.audit_interval_days||AUDIT_INTERVAL_DAYS;
  return ACTIVE_CATALOG_TASKS.map(t=>{
    // Checking a historical issue is not a check of the journal's latest issue.
    const b=(state.catalog_baselines||[]).find(b=>b.catalog_id===t.id&&b.url===t.url);
    const next=b?new Date(Date.parse(b.checked_at)+days*86400000).toISOString():null;
    return {catalog_id:t.id,journal:t.journal,collection:t.collection,url:t.url,
      checked_at:b?.checked_at||null,next_audit_at:next,rank:b?.rank||null,issue_year:b?.issue_year||null,complete:!!b,
      current_status:state.tasks.some(j=>j.catalog_id===t.id&&j.status==='pending')?'incomplete':b?'complete':'unknown',paper_count:b?.papers.length||0,
      status:!b?'baseline_missing':Date.parse(next)<=now.getTime()?'audit_due':'recently_checked'};
  });
}
