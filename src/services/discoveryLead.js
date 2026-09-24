import {catalogUrl,articleUrl,titleKey,cleanDoi} from '../../tools/browser-abstract-extension/catalog-core.js';

export function discoveryCatalogEvidenceUrl(value,task){
  try{
    const u=new URL(value),expected=new URL(task.url);
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.origin!==expected.origin)return null;
    if(task.journal==='JM'&&/^\/toc\/JOM\//.test(u.pathname)){
      const alias=new URL(u);alias.pathname=alias.pathname.replace('/toc/JOM/','/toc/joma/');
      if(!catalogUrl(alias.href,task))return null;
    }else if(!/\/issue\/?$/.test(expected.pathname)||u.pathname!==expected.pathname.replace(/\/issue\/?$/,''))return null;
    u.search='';u.hash='';return u.href;
  }catch{return null;}
}

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
export function assessDiscoveryLead(lead,{journal,catalogs,papers,state,baselines:verifiedBaselines=[],now=new Date()}){
  let url;try{url=new URL(lead.url);}catch{return {reason:'invalid_url'};}
  // SAGE search indexes the historical JOM alias; never broaden other journals.
  if(journal.key==='JM'&&url.hostname==='journals.sagepub.com'&&/^\/toc\/JOM\//.test(url.pathname)){
    url.pathname=url.pathname.replace('/toc/JOM/','/toc/joma/');lead={...lead,url:url.href};
  }
  const exact=catalogs.find(t=>catalogUrl(lead.url,t)===catalogUrl(t.url,t));
  let textRank=null;
  const issueSurface=exact?.collection==='issue'?exact:catalogs.find(t=>t.collection==='issue'&&
    url.origin===new URL(t.url).origin&&url.pathname===new URL(t.url).pathname.replace(/\/issue\/?$/,'')&&
    titleKey(lead.title).includes(titleKey(journal.name)));
  if(issueSurface){
    const matches=[...(lead.title+' '+lead.snippet).matchAll(/Vol(?:ume)?\.?\s+(\d+)[,\s]+(?:Issue|Number|No\.?)\s+(\d+)/gi)];
    const ranks=[...new Set(matches.map(m=>m[1]+','+m[2]))];
    if(ranks.length===1)textRank=ranks[0].split(',').map(Number);
  }
  if(exact&&!textRank)return {reason:exact.collection==='online'?'online_directory_without_change_evidence':'generic_directory_without_change_evidence',collection:exact.collection};
  const issue=textRank?issueSurface:catalogs.find(t=>t.collection==='issue'&&issueRank(lead.url,t));
  if(issue){
    const rank=textRank||issueRank(lead.url,issue),baselines=verifiedBaselines.filter(b=>b.catalog_id===issue.id&&Array.isArray(b.rank)&&b.rank.length===2&&b.rank.every(n=>Number.isInteger(n)&&n>0)).map(b=>b.rank);
    for(const t of state.tasks.filter(t=>t.catalog_id===issue.id&&t.status==='processed'))baselines.push(issueRank(t.url,issue));
    for(const p of papers.filter(p=>p.journal_key===journal.key))for(const m of p.catalog_memberships||[])
      if(m.task_id===issue.id)baselines.push(issueRank(m.catalog_url,issue));
    const baseline=baselines.filter(Boolean).sort(compare).at(-1);
    if(!baseline)return {reason:'issue_baseline_missing',collection:'issue',rank};
    if(compare(rank,baseline)<=0)return {reason:'known_or_older_issue',collection:'issue',rank,baseline};
    return {reason:'newer_issue_candidate',task:issue,catalog_url:catalogUrl(lead.url,issue)||issue.url,doi:null,rank,baseline};
  }
  // Non-concrete catalog pages are not article evidence.
  if(catalogs.some(t=>catalogUrl(lead.url,t)))return {reason:'unresolved_catalog_route'};
  let decoded;try{decoded=decodeURIComponent(decodeURIComponent(lead.url));}catch{return {reason:'invalid_encoding'};}
  const doi=cleanDoi(decoded.match(/10\.\d{4,9}\/(?:qje\/)?[^/?#\s]+/i)?.[0]);
  const task=catalogs.find(t=>t.collection==='online'&&articleUrl(lead.url,t)&&titleKey(lead.snippet||'').includes(titleKey(journal.name)));
  if(!task)return {reason:'not_verified_journal_article'};
  const journalDoi={JAR:/^10\.1111\/(?:j\.)?1475-679x\./,JM:/^10\.1177\/01492063/,MS:/^10\.1287\/mnsc\./,RP:/^10\.1016\/j\.respol\./,
    JF:/^10\.1111\/jofi\./,CAR:/^10\.1111\/1911-3846\./,JOM:/^10\.1002\/joom\./,
    AOS:/^10\.1016\/j\.aos\./,JAE:/^10\.1016\/j\.jacceco\./,JFE:/^10\.1016\/j\.jfineco\./,JCF:/^10\.1016\/j\.jcorpfin\./,
    RAS:/^10\.1007\/s11142-/,JIBS:/^10\.1057\/s41267-/};
  // A reference to the target journal in another journal's bibliography is not identity.
  if(journalDoi[journal.key]&&!journalDoi[journal.key].test(doi||''))return {reason:'article_identity_unconfirmed'};
  if(papers.some(p=>p.journal_key===journal.key&&((doi&&cleanDoi(p.doi)===doi)||p.url===lead.url||titleKey(p.title_original)===titleKey(lead.title))))return {reason:'known_article'};
  const dateMatch=(lead.snippet||'').slice(0,1600).match(/(?:First published(?: online)?|Published(?: Online)?|Available online|Version of Record online)\s*:?\s*((?:\d{1,2}\s+[A-Za-z]+\s+\d{4})|(?:[A-Za-z]+\s+\d{1,2},?\s+\d{4})|(?:\d{4}-\d{2}-\d{2}))/i);
  const published=dateMatch?Date.parse(dateMatch[1]+' UTC'):NaN;
  if(!Number.isFinite(published))return {reason:'article_recency_unconfirmed'};
  const age=now.getTime()-published;
  if(age< -86400000||age>60*86400000)return {reason:'old_or_future_article'};
  return {reason:'new_article_candidate',task,doi,catalog_url:task.url};
}
