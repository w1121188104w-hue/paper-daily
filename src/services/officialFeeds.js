import {publisherFor} from './publisherCatalog.js';
import {parsePublisherFeed,publisherRecord} from './publisherParsers.js';
import {selectCarEnglish} from './carEnglish.js';
import {titleKey} from '../../tools/browser-abstract-extension/catalog-core.js';

// A failed HTML page must not disable an independent public RSS surface. The
// HTTP client still enforces robots, origin-wide 429 cooldown and total budget.
export async function readOfficialFeeds(journal,http){
  const publisher=publisherFor(journal),attempts=[],leads=[];
  // JPE image/Just Accepted feeds remain outside the user's collection scope.
  if(journal.key==='JPE')return {attempts,leads};
  for(const url of publisher.feeds){
    try{
      const response=await http.request(url,publisher.hosts),parsed=parsePublisherFeed(response,journal);
      leads.push(...parsed.rows);
      attempts.push({url,checked_at:response.fetched_at,status:'partial',code:'FEED_IS_NOT_COMPLETE_CATALOG',
        observed:parsed.rows.length,abstracts:parsed.rows.filter(p=>p.abstract).length,rejected:parsed.rejected.length,body_sha256:response.sha256});
    }catch(e){
      if(e.code==='EVIDENCE_STORAGE_ERROR')throw e;
      attempts.push({url,checked_at:new Date().toISOString(),status:'failed',code:/^[A-Z_]{3,50}$/.test(e.code||'')?e.code:'READ_FAILED'});
    }
  }
  return {attempts,leads};
}

// Feed dates are updates, not publication dates. Directly adopt only a missing
// abstract for an already identified DOI + journal + exact title. New or
// conflicting feed entries stay discovery signals until an article is checked.
export function knownFeedSource(lead,journal,papers){
  if(!lead.doi||!lead.abstract)return null;
  const old=papers.find(p=>p.doi===lead.doi&&p.journal_key===journal.key);
  if(!old||old.abstract_original)return null;
  let source=publisherRecord(lead,journal);
  if(journal.key==='CAR')source=selectCarEnglish(source,[{doi:old.doi,journal_key:'CAR',title:old.title_original},...(old.source_records||[])])||source;
  if(titleKey(source.title)!==titleKey(old.title_original)||source.abstract.length<150||
    (source.abstract.match(/\b[A-Za-z]+\b/g)||[]).length<25||/(?:^|\s)RÉSUMÉ(?:\s|$)/u.test(source.abstract)||
    /^(?:highlights|graphical abstract)\b/i.test(source.abstract))return null;
  return source;
}
