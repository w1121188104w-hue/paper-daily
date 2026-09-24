import { collectJournals } from './collectJournals.js';
import { ACTIVE_CATALOG_TASKS, titleKey } from '../../tools/browser-abstract-extension/catalog-core.js';
import { addDiscoverySignals, validateWorkflow } from './collectionWorkflow.js';
import { knownJournalMismatch } from './journalIdentity.js';
import {collectionWindow} from './journalRun.js';
import {assessDiscoveryLead} from './discoveryLead.js';

// Discovery never calls a translator or writes a fabricated paper/abstract.
// search() MUST be a durably budgeted adapter. It is optional and disabled by default.
export async function discoverCollectionTasks(config, state, papers, {now=new Date(), collect=collectJournals,
  search=null, searchProviders=['zhipu','serpapi_scholar','serpapi_google'], queryBuilder=null, onLead=async()=>{}, sourceOptions={}, onJournal=async()=>{}}={}) {
  let next=structuredClone(validateWorkflow(state));
  const at=now.toISOString(),{fromDate,toDate}=collectionWindow({now,lookbackDays:60});
  const known=p=>papers.some(x=>x.journal_key===p.journal_key&&((x.doi&&x.doi===p.doi)||(!p.doi&&titleKey(x.title_original)===titleKey(p.title))));
  const monitor=(journal,source,status)=>{next.monitors=next.monitors.filter(m=>m.journal!==journal||m.source!==source);
    next.monitors.push({journal,source,status,checked_at:at});};
  for(const journal of config.journals.filter(j=>j.enabled)) {
    let results=[];
    try { results=(await collect(config,{...sourceOptions,journalKey:journal.key,fromDate,toDate,withSemanticScholar:true,
      existingPapers:papers,checkedAt:at})).source_results; } catch { /* Per-journal errors must not suppress search. */ }
    const catalogs=ACTIVE_CATALOG_TASKS.filter(t=>t.journal===journal.key);
    for(const source of ['crossref','openalex','semanticscholar']) {
      const result=results.find(r=>r.source===source);
      monitor(journal.key,source,result?.ok?(result.complete?'ok':'partial'):'failed');
      for(const p of result?.records||[]) {
        if(known(p)||knownJournalMismatch({doi:p.doi,journal_key:journal.key}))continue;
        // Issue assignment is not reliable in indexes. Both current surfaces are
        // intentionally alerted for a genuinely new paper (at most two catalogs).
        next=addDiscoverySignals(next,catalogs.map(t=>({catalog_id:t.id,source,title:p.title,doi:p.doi,source_url:p.url})),{now});
      }
    }
    if(!search)monitor(journal.key,'search','disabled');
    else {
      let usable=false, failed=false, quota=false;
      for(const provider of searchProviders) {
        // One catalog-discovery query per provider per journal, NOT per missing abstract.
        const query=(queryBuilder?queryBuilder(journal,catalogs):`${journal.name} ${toDate.slice(0,7)} latest issue online first`).slice(0,provider==='zhipu'?70:500);
        let response;try {response=await search({provider,query,taskId:`catalog-watch:${journal.key}:${toDate}`});}
        catch {failed=true;continue;}
        if(!response.called){quota ||= /quota|limit|budget/.test(response.reason||'');continue;}
        if(!response.result){failed=true;continue;}
        const leads=response.result?.leads||[];
        for(const lead of leads){
          const assessment=assessDiscoveryLead(lead,{journal,catalogs,papers,state:next,now});
          await onLead({journal:journal.key,provider,url:lead.url,reason:assessment.reason,collection:assessment.task?.collection||assessment.collection||null});
          if(!assessment.task)continue;
          next=addDiscoverySignals(next,[{catalog_id:assessment.task.id,source:provider,title:lead.title,doi:assessment.doi,
            source_url:lead.url,catalog_url:assessment.catalog_url}],{now});usable=true;
        }
        if(usable)break;
      }
      monitor(journal.key,'search',usable?'ok':quota?'quota_exhausted':failed?'failed':'ok');
    }
    next.updated_at=at;validateWorkflow(next);await onJournal(next);
  }
  return next;
}
