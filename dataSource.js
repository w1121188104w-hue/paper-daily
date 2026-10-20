export function withJournalNames(data) {
  const names=new Map((data.journals||[]).filter(j=>j.display_name).map(j=>[j.key,j.display_name]));
  return {...data,papers:data.papers.map(p=>names.has(p.journal_key)?{...p,journal_display_name:names.get(p.journal_key)}:p)};
}
// Local pages retain data.json. Published pages opt into immutable per-journal files.
export async function loadWebsiteData({split=false,fetchImpl=fetch,signal,cryptoImpl=globalThis.crypto}={}) {
  async function get(url,cache='no-store'){
    const r=await fetchImpl(url,{cache,signal});if(!r.ok)throw Error('WEBSITE_READ_FAILED');return r;
  }
  if(!split)return withJournalNames(await (await get('./data.json')).json());
  const index=await (await get('./publication-index.json')).json();
  if(index.schema_version!==2||index.application!=='paper-daily-publication'||!Array.isArray(index.journals)||!index.journals.length)throw Error('WEBSITE_INDEX_INVALID');
  const journalKeys=new Set();
  for(const j of index.journals){
    if(!/^[A-Z][A-Z0-9]{1,10}$/.test(j.key)||journalKeys.has(j.key)||!/^[a-f0-9]{64}$/.test(j.sha256)||j.file!==`journals/${j.key}.${j.sha256}.json`)throw Error('WEBSITE_INDEX_INVALID');
    journalKeys.add(j.key);
  }
  const chunks=new Array(index.journals.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,chunks.length)},async()=>{
    for(;;){const i=cursor++;if(i>=chunks.length)return;const j=index.journals[i];
      const bytes=await (await get('./'+j.file,'force-cache')).arrayBuffer();
      const sha=[...new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
      if(bytes.byteLength!==j.bytes||sha!==j.sha256)throw Error('WEBSITE_JOURNAL_INTEGRITY');
      const data=JSON.parse(new TextDecoder().decode(bytes));
      if(data.schema_version!==1||data.journal?.key!==j.key||!Array.isArray(data.papers)||!Array.isArray(data.catalogs)||
        data.papers.length!==j.paper_count||data.catalogs.length!==j.catalog_count||data.papers.some(p=>p.journal_key!==j.key))throw Error('WEBSITE_JOURNAL_INVALID');
      chunks[i]=data;
    }
  }));
  const papers=chunks.flatMap(c=>c.papers),catalogs=chunks.flatMap(c=>c.catalogs),ids=new Set(papers.map(p=>p.id));
  if(papers.length!==index.paper_count||catalogs.length!==index.catalog_count||ids.size!==papers.length||catalogs.some(c=>c.article_ids.some(id=>!ids.has(id))))throw Error('WEBSITE_TOTAL_MISMATCH');
  const pending=papers.filter(p=>p.title_translation_status!=='done'||p.abstract_original&&p.abstract_translation_status!=='done');
  const fields=pending.reduce((n,p)=>n+(p.title_translation_status!=='done'?1:0)+(p.abstract_original&&p.abstract_translation_status!=='done'?1:0),0);
  return withJournalNames({schema_version:1,initialized:true,delivery_mode:'static',publication:{version:index.version,revision:index.revision},
    snapshot_at:null,journals:chunks.map(c=>c.journal),papers,runs:[],pending:{paper_count:pending.length,field_count:fields},
    enrichment:{missing_abstracts:papers.filter(p=>!p.abstract_original&&p.abstract_status!=='no_abstract'&&p.collection!=='other').length},
    local_rss:{catalogs,active_journals:index.active_journals,failures:[],job:null},quarantined:[],collection_activity:[],discovery_checks:[]});
}
