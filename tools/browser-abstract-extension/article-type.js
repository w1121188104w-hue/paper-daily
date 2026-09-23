// Conservative source-backed rules; general mentions in the body are not labels.
export function catalogOtherSource(item) {
  const title=String(item.title||'').trim(), evidence=item.evidence||{};
  const titleOther=/^(?:covers? and front matter|front matter|back matter|issue information|editorial board|list of (?:editors|reviewers)|recent referees|jpe turnaround times|nobel (?:lecture|prize lecture)|corrigendum|erratum|retraction|retracted|publisher['’]s note)\b/i.test(title) ||
    /^editorial (?:data|policy(?: and style information)?)$/i.test(title) ||
    /^(?:book review|commentary)\s*[:：]/i.test(title) ||
    /(?:^|:\s*)a commentary on\s+[“"‘']/i.test(title);
  if(titleOther)return {method:'explicit_article_title',quote:title,source_url:evidence.catalog_url||item.source_url||item.url};
  const section=String(evidence.section||'').trim();
  if(/^(?:book reviews?|commentar(?:y|ies)|announcements?|editorials?|editorial board|erratum|corrigendum|retraction|publisher['’]s note)$/i.test(section))
    return {method:'catalog_label',quote:section,source_url:evidence.catalog_url||item.url};
  return null;
}
export function detailOtherSource(record) {
  if(!record.identity?.ok)return null;
  const titled=catalogOtherSource({...record,evidence:{}});
  if(titled)return titled;
  // Springer explicitly names the book review editor in this acceptance label.
  // Do not classify from a general reference to a book review elsewhere.
  for(const block of record.evidence||[]){
    if(block?.kind!=='context'||block.id!=='article-context')continue;
    const match=block.text?.match(/Accepted by [^\r\n.!?]{1,160}, Book Review Editor, \d{1,2} [A-Za-z]+ \d{4}\./);
    if(match)return {method:'publisher_article_type_label',quote:match[0],block_id:block.id,source_url:record.source_url};
  }
  return null;
}
