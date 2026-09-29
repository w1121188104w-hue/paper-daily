import fs from 'node:fs/promises';
import path from 'node:path';
import {load} from 'cheerio';
import {ACTIVE_CATALOG_TASKS,assessCatalog,catalogUrl,articleUrl,sameCatalogList,cleanDoi,titleKey,mergeCatalog} from '../../tools/browser-abstract-extension/catalog-core.js';
import {makeEvidenceHttp,evidenceHash} from './evidenceHttp.js';
import {doiFromPublisherUrl,parsePublisherArticle,publisherRecord} from './publisherParsers.js';
import {writeWorkflowJson} from './workflowStorage.js';
import {assertLibrary} from './libraryValidation.js';
import {importBrowserExport} from './browserImport.js';
import {readJournalLibrary} from './journalLibrary.js';
import {addDiscoverySignals} from './collectionWorkflow.js';
import {recordCatalogBaseline} from './catalogBaseline.js';
import {readOfficialFeeds,knownFeedSource} from './officialFeeds.js';

export const OFFICIAL_CACHE_PATH='data/collection-workflow/official-catalogs.json';
const cardSelector='.js-article-list-item,.article-list-item,.issue-item,.toc-item,.toc__item,.table-of-content__item,.al-article-item,.al-article-list-item,.c-listing__item,.c-card,.journal-article,article.journal-article';
const titleSelector='h2 a[href],h3 a[href],h4 a[href],h5 a[href],.al-title a[href],a.al-title[href],.article-content-title[href],.issue-item__title a[href],.hlFld-Title a[href]';
const text=($,n)=>$(n).text().replace(/\s+/g,' ').trim();
const excluded='nav,footer,aside,[hidden],[aria-hidden="true"],.related-articles,.recommendations,[class*="most-read"],[class*="most-cited"]';
const cleanCode=e=>/^[A-Z_]{3,50}$/.test(e?.code||'')?e.code:'READ_FAILED';

/** Static HTML only: no browser impersonation, JS execution, CAPTCHA handling,
 * hidden API calls, or inference from search snippets. Same identity/URL rules as
 * the extension; incomplete or dynamic lists remain a browser task. */
export function parseOfficialCatalog(response,task){
  const $=load(response.body),url=response.url;
  const href=n=>{try{return new URL($(n).attr('href'),url).href;}catch{return '';}};
  const titleOf=n=>{const copy=$(n).clone();copy.find('.free,.free-access,.open-access,.access-label,.access-icon,.badge,sup').each((i,e)=>{if(/^(free|open access|free access)$/i.test(text($,e)))$(e).remove();});return text($,copy);};
  const allowed=n=>!$(n).closest(excluded).length;
  const links=$(titleSelector).toArray().filter(n=>allowed(n)&&articleUrl(href(n),task)&&titleOf(n).length>8);
  const items=[],seen=new Set();let unscoped=0;
  for(const a of links){
    const article=articleUrl(href(a),task);if(seen.has(article))continue;seen.add(article);
    let card=$(a).closest(cardSelector);
    if(!card.length){card=$(a).closest('article,li');if(!card.length){unscoped++;continue;}}
    const titles=card.find(titleSelector).toArray().filter(n=>articleUrl(href(n),task));
    if(new Set(titles.map(n=>articleUrl(href(n),task))).size!==1){unscoped++;continue;}
    const title=titleOf(a),doi=cleanDoi(card.attr('data-doi')||card.find('[data-doi]').first().attr('data-doi'))||
      card.find('a[href]').toArray().map(n=>doiFromPublisherUrl(href(n))).find(Boolean)||doiFromPublisherUrl(article)||null;
    const copy=card.clone();copy.find('script,style,form,input,textarea,select,nav,aside').remove();
    const evidence_text=text($,copy);
    if(!titleKey(evidence_text).includes(titleKey(title))){unscoped++;continue;}
    items.push({title,doi,url:article,selector:'official_static_card',evidence_text,evidence_version:2,
      authors_raw:text($,card.find('.authors,.author-group,.author-list,.article-item-authors,.al-authors-list,.c-author-list,.hlFld-ContribAuthor,.loa'))||null,
      date_raw:text($,card.find('time,.article-date,.publication-date,.al-pub-date'))||null,
      section:text($,card.find('.article-type,.issue-item__type,.subType,.articleType,.content-type'))||null});
  }
  // Catch title links outside recognized cards, rather than silently declaring
  // the subset found by the selectors to be a complete catalog.
  for(const a of $('a[href]').toArray())if(allowed(a)&&text($,a).length>20&&!/^(https?:|10\.|full text|download|view|add to|open the)/i.test(text($,a))){const u=articleUrl(href(a),task);if(u)seen.add(u);}
  const headings=[$('title').text(),...$('h1,.journal-title,.journal-name,.journal-header,meta[name="citation_journal_title"]').toArray().map(n=>$(n).attr('content')||text($,n))];
  for(const a of $('a[href]').toArray()){
    const u=new URL(href(a)||url),code=new URL(task.url).pathname.split('/')[1];
    if(u.origin===new URL(url).origin&&[`/${code}`,`/${code}/`,`/${code}/issue`].includes(u.pathname))
      headings.push(...$(a).find('img[alt]').toArray().map(n=>$(n).attr('alt')));
  }
  const issns=$('meta[name="citation_issn"],meta[name="prism.issn"],meta[property="prism.issn"]').toArray().flatMap(n=>($(n).attr('content')||'').match(/\d{4}-[\dXx]{4}/g)||[]);
  if(task.host==='publications.aaahq.org')for(const m of text($,$('footer,[role="contentinfo"],.site-footer,.footer')).matchAll(/\b(?:Print |Online )?ISSN\s*:?\s*(\d{4}-[\dXx]{4})/gi))issns.push(m[1]);
  const next_links=[],issue_links=[],more_controls=[];let pagination_unresolved=false;
  for(const a of $('a[href],button,[role="button"]').toArray()){
    if(!allowed(a)||$(a).is('[disabled],[aria-disabled="true"],.disabled'))continue;
    const label=($(a).attr('aria-label')||text($,a)).trim(),link=href(a);
    if(/^current issue$/i.test(label)||/\/volumes-and-issues\/\d+-[\d-]+$/.test(link))issue_links.push({url:link,label});
    if(($(a).attr('rel')==='next'||/^(next(?: page)?|›|»|→)$/i.test(label))&&!/issue|article/i.test(label)){
      if(sameCatalogList(url,link,task))next_links.push(link);else pagination_unresolved=true;
    }
    if(/^\d+$/.test(label)&&$(a).closest('[class*="pagination"]').length){
      const here=new URL(url),current=Number(here.searchParams.get('page')||here.searchParams.get('pageNumber')||Number(here.searchParams.get('startPage')||0)+1);
      if(+label>current){if(sameCatalogList(url,link,task))next_links.push(link);else pagination_unresolved=true;}
    }
    if(/^(load more|show more|view more|show all|view all)( articles| results)?$/i.test(label))more_controls.push(label);
  }
  const body=text($,$('body')),page_title=$('title').text();
  const capture={url,page_title,headings,issns,items,raw_card_count:items.length,adapter:'official_static_html',
    challenge:/just a moment|access denied|verify (?:you are|that you)|checking your browser|error 500|internal server error/i.test(page_title+' '+body.slice(0,1600)),
    page_not_found:/^(404|page not found|not found)/i.test(page_title),
    issue_heading:$('h1,h2,.volume-issue,.issue-header,.issue-info').toArray().map(n=>text($,n)).filter(s=>/volume|issue|ahead|early|press|\bvol\.|\bno\./i.test(s)).join(' | ').slice(0,1500),
    issue_links,next_links:[...new Set(next_links)],more_controls,pagination_unresolved,
    observed_article_links:[...seen],unmatched_article_links:[...seen].filter(u=>!items.some(i=>i.url===u)),
    empty_message:body.match(/this journal currently does not have articles in press|there are currently no articles|no articles (?:are )?(?:currently )?available/i)?.[0]||null,
    warnings:unscoped?[`unmatched_article_links:${unscoped}`]:[]};
  return {...assessCatalog(task,capture),captured_at:response.fetched_at,requested_url:response.requested_url,
    job_key:task.id+'|'+response.requested_url,body_sha256:response.sha256,direct_read:true};
}
export async function readOfficialCatalog(task,http,{maxPages=6}={}){
  const queue=[task.url],pages=[],seen=new Set(),contents=new Set();let code=null;
  try{
    while(queue.length){
      if(pages.length>=maxPages){code='PAGE_LIMIT';break;}
      const url=queue.shift();if(seen.has(url))continue;seen.add(url);
      const response=await http.request(url,task.hosts||[task.host]);
      const page=parseOfficialCatalog(response,task);pages.push(page);
      const signature=page.items?.length?JSON.stringify(page.items.map(p=>p.url).sort()):null;
      if(signature&&contents.has(signature)){code='REPEATED_PAGE';break;}
      if(signature)contents.add(signature);
      if(!['catalog_candidates','catalog_empty','catalog_landing'].includes(page.status)){code=page.status.toUpperCase();break;}
      if(page.more_controls?.length||page.pagination_unresolved||page.unmatched_article_links?.length){code='DYNAMIC_OR_PARTIAL_LIST';break;}
      for(const next of [...(page.next_links||[]),...(page.issue_target?[page.issue_target]:[])])if(!seen.has(next))queue.push(next);
    }
  }catch(e){code=cleanCode(e);}
  return {catalog_id:task.id,url:task.url,checked_at:new Date().toISOString(),complete:!code&&pages.length>0&&!queue.length,
    code,pages,papers:mergeCatalog(pages)};
}
export async function readOfficialCache(repo){
  try{const value=JSON.parse(await fs.readFile(path.join(repo,OFFICIAL_CACHE_PATH),'utf8'));
    assertLibrary(value.schema_version===1&&Array.isArray(value.catalogs),'官网读取缓存无效');
    for(const c of value.catalogs){const task=ACTIVE_CATALOG_TASKS.find(t=>t.id===c.catalog_id);
      assertLibrary(task&&c.url===task.url&&Array.isArray(c.pages)&&c.pages.every(p=>p.task_id===task.id&&catalogUrl(p.source_url,task)),'官网缓存身份无效');}
    return value;
  }catch(e){if(e.code==='ENOENT')return {schema_version:1,catalogs:[]};throw e;}
}
export async function hydrateRunFromOfficial(repo,run,{now=Date.now()}={}){
  const cache=await readOfficialCache(repo),pages=[];
  for(const job of run.jobs){
    const c=cache.catalogs.find(c=>c.catalog_id===job.catalog_id&&c.url===job.url&&c.complete&&now-Date.parse(c.checked_at)<24*3600000&&(!job.signal_at||c.checked_at>=job.signal_at));
    if(c)pages.push(...c.pages);
  }
  // These are real catalog captures, not fabricated AI verdicts. The plugin
  // reviews their exact source spans without opening the catalog a second time.
  return {...run,direct_pages:pages};
}
export async function collectOfficialCatalogs(config,state,{repositoryRoot,root,tasks=ACTIVE_CATALOG_TASKS,
  http=makeEvidenceHttp({maxRequests:240,timeoutMs:15000,intervalMs:2000}),maxDetails=80,onProgress=()=>{}}){
  const cache={schema_version:1,catalogs:[],feeds:[]},sources=[],blocked=new Set();let detailCount=0;
  let library=await readJournalLibrary({root,config}),next=structuredClone(state);
  for(const key of new Set(tasks.map(t=>t.journal))){
    const journal=config.journals.find(j=>j.enabled&&j.key===key);if(!journal)continue;
    const feed=await readOfficialFeeds(journal,http);cache.feeds.push({journal:key,attempts:feed.attempts});
    next.monitors=next.monitors.filter(m=>!(m.journal===key&&m.source==='official'&&!m.catalog_id));
    if(feed.attempts.length)next.monitors.push({journal:key,source:'official',status:feed.attempts.some(a=>a.status==='partial')?'partial':'failed',checked_at:new Date().toISOString(),code:'RSS_PARTIAL_ONLY'});
    for(const lead of feed.leads){
      const source=knownFeedSource(lead,journal,library.papers);
      if(source&&!sources.some(s=>s.doi===source.doi))sources.push(source);
      if(!library.papers.some(p=>p.journal_key===key&&p.doi&&p.doi===lead.doi))
        for(const task of tasks.filter(t=>t.journal===key))next=addDiscoverySignals(next,[{catalog_id:task.id,source:'official',title:lead.title,doi:lead.doi,source_url:lead.url}]);
    }
  }
  for(const task of tasks){
    const journal=config.journals.find(j=>j.enabled&&j.key===task.journal);if(!journal)continue;
    const catalog=blocked.has(task.host)?{catalog_id:task.id,url:task.url,checked_at:new Date().toISOString(),complete:false,code:'HOST_UNAVAILABLE',pages:[],papers:[]}:await readOfficialCatalog(task,http);
    if(['ACCESS_RESTRICTED','ROBOTS_UNAVAILABLE','RATE_LIMITED','NETWORK_ERROR','TIMEOUT'].includes(catalog.code))blocked.add(task.host);
    cache.catalogs.push(catalog);
    next.monitors=next.monitors.filter(m=>!(m.journal===task.journal&&m.source==='official'&&m.catalog_id===task.id));
    next.monitors.push({journal:task.journal,source:'official',catalog_id:task.id,status:catalog.complete?'ok':catalog.pages.length?'partial':'failed',checked_at:catalog.checked_at,code:catalog.code});
    for(const p of catalog.papers){
      if(p.type==='other')continue;
      const old=library.papers.find(x=>x.journal_key===p.journal&&((x.doi&&x.doi===p.doi)||titleKey(x.title_original)===titleKey(p.title)));
      if(old?.abstract_original||sources.some(s=>s.doi&&s.doi===p.doi&&s.abstract))continue;
      if(detailCount<maxDetails&&!blocked.has(task.host)){
        detailCount++;
        try{
          const response=await http.request(p.url,task.hosts||[task.host]);
          const lead=parsePublisherArticle(response,journal,{doi:p.doi||undefined,title:p.title,scope_url:catalog.url,discovery:true});
          if(lead.abstract&&(lead.abstract.length<150||(lead.abstract.match(/\b[A-Za-z]+\b/g)||[]).length<25||/^(?:highlights|graphical abstract)\b/i.test(lead.abstract))){lead.abstract='';lead.raw_abstract='';}
          if(lead.doi&&lead.journal_confirmed&&titleKey(lead.title)===titleKey(p.title))sources.push(publisherRecord(lead,journal));
        }catch(e){if(['ACCESS_RESTRICTED','ROBOTS_UNAVAILABLE','RATE_LIMITED'].includes(e.code))blocked.add(task.host);}
      }
      if(!sources.some(s=>s.journal_key===p.journal&&s.title===p.title&&s.abstract))
        next=addDiscoverySignals(next,[{catalog_id:task.id,source:'official',title:p.title,doi:p.doi,source_url:p.url}],{now:new Date(catalog.checked_at)});
    }
    onProgress({catalog:task.id,complete:catalog.complete,papers:catalog.papers.length,code:catalog.code});
  }
  const prepared={input_sha256:evidenceHash(JSON.stringify(sources)),sources,decisions:[],raw_record_count:sources.length};
  const imported=await importBrowserExport(config,{root,prepared,save:true});library=await readJournalLibrary({root,config});
  for(const c of cache.catalogs.filter(c=>c.complete)){
    const checked=c.papers.map(p=>({...p,review_status:'source_checked_candidate'}));
    recordCatalogBaseline(next,{catalog_id:c.catalog_id,url:c.url},c.pages,checked,{receiptId:'official:'+c.checked_at,inputHash:evidenceHash(JSON.stringify(c.pages))});
    const allComplete=c.papers.every(p=>p.type==='other'||library.papers.some(x=>x.journal_key===p.journal&&((p.doi&&x.doi===p.doi)||titleKey(x.title_original)===titleKey(p.title))&&x.abstract_original));
    if(allComplete)for(const t of next.tasks.filter(t=>t.catalog_id===c.catalog_id&&t.url===c.url)){
      // A successful current catalog alone cannot resolve an index signal about
      // an article not actually seen on this page (e.g. a stale publisher cache).
      if(t.signals.every(s=>c.papers.some(p=>s.doi&&p.doi===s.doi||titleKey(p.title)===titleKey(s.title)))){t.status='processed';t.checked_at=c.checked_at;}
    }
  }
  await writeWorkflowJson(path.join(repositoryRoot,OFFICIAL_CACHE_PATH),cache);
  return {state:next,cache,imported};
}
