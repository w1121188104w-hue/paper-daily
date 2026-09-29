import {parseArgs} from 'node:util';
import {loadJournalConfig} from '../src/services/journals.js';
import {makeEvidenceHttp} from '../src/services/evidenceHttp.js';
import {readOfficialCatalog} from '../src/services/officialCatalog.js';
import {readOfficialFeeds} from '../src/services/officialFeeds.js';
import {parsePublisherArticle} from '../src/services/publisherParsers.js';
import {publisherFor} from '../src/services/publisherCatalog.js';
import {ACTIVE_CATALOG_TASKS} from '../tools/browser-abstract-extension/catalog-core.js';

// Read-only operator diagnostic. No key, search, library write, or AI request.
const {values:v}=parseArgs({options:{run:{type:'boolean'},journal:{type:'string',multiple:true},details:{type:'boolean'}}});
if(!v.run){console.log('Usage: node scripts/check-official-catalogs.js --run [--journal AER] [--details]');}
else{
  const config=await loadJournalConfig(),keys=v.journal||config.journals.filter(j=>j.enabled).map(j=>j.key);
  if(keys.some(k=>!config.journals.some(j=>j.key===k)))throw Error('UNKNOWN_JOURNAL');
  const http=makeEvidenceHttp({maxRequests:180,timeoutMs:25000,intervalMs:2000});
  for(const key of keys){
    const journal=config.journals.find(j=>j.key===key),publisher=publisherFor(journal);
    const feed=await readOfficialFeeds(journal,http);
    console.log(JSON.stringify({kind:'feeds',journal:key,attempts:feed.attempts}));
    for(const task of ACTIVE_CATALOG_TASKS.filter(t=>t.journal===key)){
      const result=await readOfficialCatalog(task,http);
      console.log(JSON.stringify({kind:'catalog',id:task.id,checked_at:result.checked_at,complete:result.complete,code:result.code,
        observed:result.papers.length,other:result.papers.filter(p=>p.type==='other').length,pages:result.pages.map(p=>({url:p.source_url,status:p.status,items:p.items?.length,body_sha256:p.body_sha256}))}));
      if(v.details){
        const candidate=result.papers.find(p=>p.type!=='other'&&p.doi)||feed.leads.find(p=>p.doi&&p.type==='journal-article');
        if(candidate){try{
          const response=await http.request(candidate.url,publisher.hosts),article=parsePublisherArticle(response,journal,{doi:candidate.doi,title:candidate.title,discovery:true});
          console.log(JSON.stringify({kind:'article',journal:key,doi:article.doi,title_found:!!article.title,journal_confirmed:article.journal_confirmed,abstract_length:article.abstract.length,method:article.evidence.method}));
        }catch(e){console.log(JSON.stringify({kind:'article',journal:key,code:/^[A-Z_]{3,50}$/.test(e.code||'')?e.code:'READ_FAILED'}));}}
      }
    }
  }
}
