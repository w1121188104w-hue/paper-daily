// User opted out of JPE Just Accepted / image-preview collection, 2026-09-23.
export function disabledCatalogUrl(value){
  try{const u=new URL(value);return u.hostname==='www.journals.uchicago.edu'&&/^\/toc\/jpe\/0\/ja\/?$/.test(u.pathname);}catch{return false;}
}
export function excludedJpePaper(p){
  if(p?.journal!=='JPE')return false;
  const memberships=p.catalog_memberships||[];
  return memberships.length>0&&memberships.every(m=>disabledCatalogUrl(m.catalog_url));
}
export function excludedJpeRecord(r){
  return r?.journal==='JPE'&&!r.abstract&&(!!r.ocr||r.collection_status==='excluded_by_user');
}

export const COLLECTION_POLICY_VERSION=2;
export function onlineWindow(now=new Date()){
  const to=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const [year,month,day]=to.split('-').map(Number),target=new Date(Date.UTC(year,month-3,1));
  const last=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
  target.setUTCDate(Math.min(day,last));
  return {from:target.toISOString().slice(0,10),to};
}
export function sourceDate(value){
  const s=String(value||'').trim();
  if(/^\d{4}-\d{2}(?:-\d{2})?$/.test(s)){
    const d=new Date(s.length===7?s+'-01T00:00:00Z':s+'T00:00:00Z');
    return Number.isFinite(+d)&&d.toISOString().startsWith(s)?s:null;
  }
  if(!/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(s)||!/^\d|^[A-Za-z]/.test(s))return null;
  const d=new Date(s+' UTC');
  if(!Number.isFinite(+d))return null;
  return /\b\d{1,2}\b/.test(s)?d.toISOString().slice(0,10):d.toISOString().slice(0,7);
}
export function firstOnlineDates(p){
  const reviewed=p.field_sources?.published_online_date?.method==='deepseek_source_checked'||
    ['confirmed','corrected'].includes(p.review_field_states?.published_online_date)||
    (p.raw_dates?.content_review||p.raw_dates?.source_review)?.verdict?.fields?.published_online_date;
  if(reviewed)return [sourceDate(p.published_online_date)].filter(Boolean);
  const values=[p.published_online_date,p.first_online_date,p.online_publication_date];
  const text=p.evidence?.text||'';
  const pattern=/(?:First published(?: online)?|First online|Available online|Version of Record online)\s*:?\s*((?:\d{4}-\d{2}(?:-\d{2})?)|(?:(?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2},?\s+)?\d{4}))/gi;
  for(const m of text.matchAll(pattern))values.push(m[1]);
  return [...new Set(values.map(sourceDate).filter(Boolean))];
}
export function collectionScope(p,now=new Date()){
  const decision=p.review_decisions?.catalog_membership?.status;
  if(decision==='out_of_scope')return {status:'outside_catalog_scope',eligible:false};
  if(decision==='uncertain')return {status:'catalog_membership_pending',eligible:false,needs_review:true};
  const members=p.catalog_memberships||[];
  if(members.some(m=>m.collection==='issue')||p.catalog_collection==='issue'||p.volume&&p.issue)return {status:'issue',eligible:true};
  if(!members.some(m=>m.collection==='online')&&p.catalog_collection!=='online')return {status:'existing',eligible:true};
  const dates=firstOnlineDates(p),window=onlineWindow(now);
  if(dates.length!==1)return {status:dates.length?'online_date_conflict':'online_date_missing',eligible:false,needs_review:true,...window};
  const date=dates[0],lo=date.length===7?date+'-01':date;
  const hi=date.length===7?new Date(Date.UTC(+date.slice(0,4),+date.slice(5),0)).toISOString().slice(0,10):date;
  if(hi<window.from||lo>window.to)return {status:'outside_online_window',eligible:false,date,...window};
  if(lo<window.from||hi>window.to)return {status:'online_date_precision',eligible:false,needs_review:true,date,...window};
  return {status:'recent_online',eligible:true,date,...window};
}
export function confirmedAbstractAbsent(p){
  if(p.abstract||p.abstract_original)return false;
  const latest=[...(p.source_records||[])].reverse().find(r=>r.raw_dates?.content_review?.verdict?.abstract_applicability||r.raw_dates?.source_review?.verdict?.abstract_applicability||r.raw_dates?.browser_import?.abstract_state==='confirmed_absent');
  const decision=latest?.raw_dates?.content_review?.verdict?.abstract_applicability||latest?.raw_dates?.source_review?.verdict?.abstract_applicability;
  return decision?decision.status==='not_applicable':latest?true:p.abstract_status==='confirmed_absent';
}
export const needsAbstract=p=>!p.abstract&&!p.abstract_original&&!confirmedAbstractAbsent(p);
export const activeMissingFields=fields=>(fields||[]).filter(f=>f==='abstract');
export function onlinePaginationStop(page,task,now=new Date()){
  if(task.collection!=='online'||page.sort_order!=='first_online_desc'||!page.items?.length)return false;
  const dates=page.items.map(p=>firstOnlineDates(p));
  if(dates.some(d=>d.length!==1||d[0].length!==10))return false;
  const values=dates.map(d=>d[0]);
  return values.every((d,i)=>!i||d<=values[i-1])&&values.every(d=>d<onlineWindow(now).from);
}
