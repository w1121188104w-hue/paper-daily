// Mutually exclusive groups. Missing affiliations alone never inflate abstracts.
export function summarizePending(workflow={}) {
  const rows=new Map();
  const key=p=>{
    const doi=String(p.doi||(/^doi:/i.test(p.id||'')?p.id.slice(4):'')).trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').toLowerCase();
    return `${p.journal||p.journal_key}|${doi?'doi:'+doi:p.id||p.title}`;
  };
  const get=p=>{const k=key(p);if(!rows.has(k))rows.set(k,{fields:new Set()});return rows.get(k);};
  for(const p of workflow.pending_papers||[])get(p).fields.add('abstract');
  for(const p of workflow.field_tasks||[]) {
    if(p.status && p.status!=='pending')continue;
    const row=get(p);
    for(const field of p.missing_fields||[])row.fields.add(field);
  }
  let abstracts=0,otherOnly=0;
  for(const {fields} of rows.values()) {
    if(fields.has('abstract'))abstracts++;
    else if(fields.size)otherOnly++;
  }
  return {abstracts,otherOnly,total:abstracts+otherOnly};
}
