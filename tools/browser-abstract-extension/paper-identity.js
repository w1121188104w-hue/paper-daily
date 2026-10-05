import {normalizeDoi,normalizeTitle,safeSourceUrl} from './core.js';

export const journalOf=p=>p.journal||p.journal_key||'';
export const doiOf=p=>normalizeDoi(p.doi||(/^doi:/i.test(p.id||'')?p.id.slice(4):''));
// Keep historical DOI keys readable; official URLs identify tasks before a DOI is known.
export const taskIdentity=p=>p?.task_key||doiOf(p||{})||'url:'+identityUrl(p?.url||p?.source_url);
export function identityUrl(value){
  const safe=safeSourceUrl(value);if(!safe)return '';
  const u=new URL(safe);u.hostname=u.hostname.replace('link.springernature.com','link.springer.com');
  u.pathname=u.pathname.replace('/article-abstract/','/article/').replace('/advance-article-abstract/','/advance-article/')
    .replace('/science/article/abs/pii/','/science/article/pii/').replace(/\/doi\/(?:abs|full)\//,'/doi/');
  return u.href;
}
const urls=p=>[p.url,p.source_url,...(p.identity_urls||[]),...(p.source_records||[]).map(r=>r.url)].map(identityUrl).filter(Boolean);
export function samePaper(a,b){
  if(!journalOf(a)||journalOf(a)!==journalOf(b))return false;
  const da=doiOf(a),db=doiOf(b);
  if(da&&db)return da===db;
  if(a.id&&b.id&&a.id===b.id)return true;
  if((a.identity_aliases||[]).includes(b.id)||(b.identity_aliases||[]).includes(a.id))return true;
  const ua=urls(a),ub=urls(b);
  return ua.some(u=>ub.includes(u));
}
export function findPaper(p,rows){
  const matches=rows.filter(r=>samePaper(p,r));
  return matches.length===1?matches[0]:null;
}
// Similar titles are candidates for the existing review, never an automatic merge.
export function identityCandidates(p,rows){
  const title=normalizeTitle(p.title||p.title_original);
  return rows.filter(r=>journalOf(p)===journalOf(r)&&(samePaper(p,r)||
    title.length>=10&&normalizeTitle(r.title||r.title_original).length>=10&&(normalizeTitle(r.title||r.title_original).includes(title)||title.includes(normalizeTitle(r.title||r.title_original)))))
    .sort((a,b)=>Number(samePaper(p,b))-Number(samePaper(p,a)));
}
export function groupPaperIdentities(rows){
  const groups=[];
  // DOI-bearing rows first let an older DOI-less task resolve against the full set.
  for(const p of [...rows].sort((a,b)=>Number(!!doiOf(b))-Number(!!doiOf(a)))){
    const candidates=groups.filter(g=>g.some(q=>samePaper(p,q)));
    if(candidates.length===1)candidates[0].push(p);else groups.push([p]);
  }
  return groups;
}
