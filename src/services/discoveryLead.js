import {catalogUrl,articleUrl,titleKey,cleanDoi} from '../../tools/browser-abstract-extension/catalog-core.js';

// Compare only within a journal's allowlisted catalog route, never URL digits
// belonging to another publisher or an article ID.
export function issueRank(value,task){
  const safe=catalogUrl(value,task);if(!safe)return null;
  const p=new URL(safe).pathname;let m;
  if((m=p.match(/\/volumes-and-issues\/(\d+)-(\d+)(?:-\d+)?\/?$/)))return [+m[1],+m[2]];
  if((m=p.match(/\/vol\/(\d+)(?:\/issue\/(\d+))?\/?$/)))return [+m[1],+(m[2]||0)];
  if((m=p.match(/\/toc\/[^/]+\/(?:\d{4}\/)?(\d+)\/(\d+)\/?$/))&&+m[1]>0)return [+m[1],+m[2]];
  if((m=p.match(/\/issue\/(\d+)\/(\d+)\/?$/)))return [+m[1],+m[2]];
  return null;
}
const compare=(a,b)=>a[0]-b[0]||a[1]-b[1];
export function assessDiscoveryLead(lead,{journal,catalogs,papers,state}){
  let url;try{url=new URL(lead.url);}catch{return {reason:'invalid_url'};}
  const exact=catalogs.find(t=>catalogUrl(lead.url,t)===catalogUrl(t.url,t));
  if(exact)return {reason:exact.collection==='online'?'online_directory_without_change_evidence':'generic_directory_without_change_evidence',collection:exact.collection};
  const issue=catalogs.find(t=>t.collection==='issue'&&issueRank(lead.url,t));
  if(issue){
    const rank=issueRank(lead.url,issue),baselines=[];
    for(const t of state.tasks.filter(t=>t.catalog_id===issue.id&&t.status==='processed'))baselines.push(issueRank(t.url,issue));
    for(const p of papers.filter(p=>p.journal_key===journal.key))for(const m of p.catalog_memberships||[])
      if(m.task_id===issue.id)baselines.push(issueRank(m.catalog_url,issue));
    const baseline=baselines.filter(Boolean).sort(compare).at(-1);
    if(!baseline)return {reason:'issue_baseline_missing',collection:'issue'};
    if(compare(rank,baseline)<=0)return {reason:'known_or_older_issue',collection:'issue'};
    return {reason:'newer_issue_candidate',task:issue,catalog_url:catalogUrl(lead.url,issue),doi:null};
  }
  // Non-concrete catalog pages are not article evidence.
  if(catalogs.some(t=>catalogUrl(lead.url,t)))return {reason:'unresolved_catalog_route'};
  let decoded;try{decoded=decodeURI(lead.url);}catch{return {reason:'invalid_encoding'};}
  const doi=cleanDoi(decoded.match(/10\.\d{4,9}\/[^?#\s]+/i)?.[0]);
  const task=catalogs.find(t=>t.collection==='online'&&articleUrl(lead.url,t)&&titleKey(lead.snippet||'').includes(titleKey(journal.name)));
  if(!task)return {reason:'not_verified_journal_article'};
  if(papers.some(p=>p.journal_key===journal.key&&((doi&&cleanDoi(p.doi)===doi)||titleKey(p.title_original)===titleKey(lead.title))))return {reason:'known_article'};
  return {reason:'new_article_candidate',task,doi,catalog_url:task.url};
}
