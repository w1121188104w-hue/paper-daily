export const ARTICLE_REVIEW_PROTOCOL='article-block-selection-v1';
export const canonicalEvidence=value=>JSON.stringify(value, function(key,v){
  return v && typeof v==='object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v;
});
export function usableAbstractBlock(b){
  return b?.kind==='abstract' && !b.truncated && !/graphical|highlights/i.test(b.context||'') &&
    (!b.language||/^en(?:[-_]|$)/i.test(b.language)) && typeof b.text==='string' && b.text.length>=150 && b.text.length<=20000 &&
    !/^(?:\s*[•●▪]|highlights\b)/i.test(b.text) && !/(?:\.{3}|…)\s*$/.test(b.text) &&
    /\b(?:the|this|we|of|and|in)\b/i.test(b.text) && (b.text.match(/\b[A-Za-z]+\b/g)||[]).length>=25;
}
export const expectsAbstract=input=>input.blocks.some(usableAbstractBlock);
export function compactArticleInput(legacy){
  // The full capture is never mutated. Only the provider request is reduced.
  // Abstract and affiliation blocks are kept whole; large body text is context,
  // not a reason to reject a perfectly usable independent Abstract block.
  const blocks=[],omitted=[],context=[];
  for(const b of legacy.blocks){
    if(b.kind!=='context'||b.affiliation_record||b.context==='ocr_full_preview_context_not_an_abstract'){blocks.push({...b});continue;}
    context.push(b);
  }
  let budget=12000;
  for(const b of context){
    if(b.text.length<=budget){blocks.push({...b});budget-=b.text.length;continue;}
    const length=Math.min(budget,8000);
    if(length>0)blocks.push({id:b.id+'-excerpt',kind:'context',context:'partial_page_context_not_an_abstract',
      text:b.text.slice(0,length),truncated:true,source_block_id:b.id,source_start:0,source_end:length,source_length:b.text.length});
    budget-=length;omitted.push({block_id:b.id,original_length:b.text.length,sent_length:length,reason:'full_context_retained_in_raw_capture'});
  }
  return {...legacy,blocks,review_protocol:ARTICLE_REVIEW_PROTOCOL,evidence_selection:{full_capture_preserved:true,omitted_context:omitted}};
}
export function abstractBlockSpans(input,value){
  if(!Array.isArray(value.block_ids)||value.block_ids.length!==1)throw Error('INVALID_ABSTRACT_BLOCK_SELECTION');
  const b=input.blocks.find(b=>b.id===value.block_ids[0]);
  if(!usableAbstractBlock(b))throw Error('NOT_A_COMPLETE_ENGLISH_ABSTRACT');
  return [{block_id:b.id,start:0,end:b.text.length,text:b.text}];
}
export function verdictOutput(input,verdict){
  const fields=Object.fromEntries(Object.entries(verdict.proofs||{}).map(([name,spans])=>[name,
    {status:verdict.states[name],...(name==='abstract' && input.review_protocol===ARTICLE_REVIEW_PROTOCOL ?
      {block_ids:spans.filter(s=>input.blocks.some(b=>b.id===s.block_id&&b.text===s.text&&s.start===0&&s.end===b.text.length)).map(s=>s.block_id)} :
      {spans:spans.map(s=>({block_id:s.block_id,quote:s.text}))})}]));
  return {identity_match:verdict.status==='source_checked_candidate',fields,
    affiliations:(verdict.affiliations||[]).map(a=>({block_id:a.proof?.block_id,status:'confirmed'}))};
}
