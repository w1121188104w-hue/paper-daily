// All accepted values are copied from observed publisher fields, never AI prose.
export function validAffiliationBlock(block) {
  const r=block?.affiliation_record;
  return block?.kind==='context' && block.context==='author_affiliation' && r &&
    (r.author===null || typeof r.author==='string' && r.author.length>0 && r.author.length<=500) &&
    typeof r.affiliation==='string' && r.affiliation.length>=4 && r.affiliation.length<=2000 &&
    ['meta:citation_author_institution','jsonld:author.affiliation','dom:explicit-affiliation-reference','dom:affiliation-unmapped'].includes(r.method) &&
    block.text===(r.author ? r.author+'\n'+r.affiliation : r.affiliation);
}
export function validatedAffiliations(input, selections) {
  if(!Array.isArray(selections))return [];
  const rows=[],seen=new Set();
  for(const selected of selections.slice(0,40)) {
    if(!['confirmed','corrected'].includes(selected?.status))continue;
    const block=input.blocks.find(b=>b.id===selected.block_id);
    if(!validAffiliationBlock(block))continue;
    const r=block.affiliation_record,key=JSON.stringify([r.author,r.affiliation]);if(seen.has(key))continue;seen.add(key);
    rows.push({...r,source_url:input.source_url,association:r.author?'explicit':'unmapped',status:'source_checked',
      proof:{block_id:block.id,start:0,end:block.text.length,text:block.text}});
  }
  return rows;
}
export const affiliationSelections = verdict => (verdict?.affiliations||[]).map(r=>({block_id:r.proof?.block_id,status:'confirmed'}));
