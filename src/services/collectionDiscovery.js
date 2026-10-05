import { collectJournals } from './collectJournals.js';
import { ACTIVE_CATALOG_TASKS, titleKey } from '../../tools/browser-abstract-extension/catalog-core.js';
import { addDiscoverySignals, validateWorkflow } from './collectionWorkflow.js';
import { knownJournalMismatch } from './journalIdentity.js';
import {onlineWindow} from '../../tools/browser-abstract-extension/collection-policy.js';
import {baselineKnownPapers} from './catalogBaseline.js';

// Production entry point: deliberately allowlist options. Old probe adapters,
// environment switches and search callbacks cannot turn paid search back on.
export function discoverIndexedCollectionTasks(config,state,papers,{now,collect,sourceOptions,onJournal}={}) {
  return discoverCollectionTasks(config,state,papers,{now,collect,sourceOptions,onJournal,search:null});
}

// Discovery never calls a translator or writes a fabricated paper/abstract.
// Three independent indexes only; paid search is no longer part of discovery.
export async function discoverCollectionTasks(config, state, papers, {now=new Date(), collect=collectJournals,
  sourceOptions={}, onJournal=async()=>{}}={}) {
  let next=structuredClone(validateWorkflow(state));
  const at=now.toISOString(),{from:fromDate,to:toDate}=onlineWindow(now);
  const seenPapers=[...papers,...baselineKnownPapers(next)];
  const known=p=>seenPapers.some(x=>x.journal_key===p.journal_key&&((x.doi&&x.doi===p.doi)||(!p.doi&&titleKey(x.title_original)===titleKey(p.title))));
  const monitor=(journal,source,status)=>{next.monitors=next.monitors.filter(m=>m.journal!==journal||m.source!==source);
    next.monitors.push({journal,source,status,checked_at:at});};
  for(const journal of config.journals.filter(j=>j.enabled)) {
    let results=[];
    try { results=(await collect(config,{...sourceOptions,journalKey:journal.key,fromDate,toDate,withSemanticScholar:true,
      existingPapers:papers,checkedAt:at})).source_results; } catch { /* Isolate failures; continue the other journals. */ }
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
    monitor(journal.key,'search','disabled');
    next.updated_at=at;validateWorkflow(next);await onJournal(next);
  }
  return next;
}
