// Typed dates are derived only from explicit source labels. Legacy
// publication_month remains available, but is never called the issue month.
const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
export function explicitMonth(text){
  const found=[...String(text||'').matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2},?\s+)?((?:19|20)\d{2})\b/gi)]
    .map(m=>`${m[2]}-${String(months.indexOf(m[1].toLowerCase())+1).padStart(2,'0')}`);
  const unique=[...new Set(found)];return unique.length===1?unique[0]:null;
}
export function catalogMembership(page,task){
  const heading=String(page.issue_heading||'');
  const volume=heading.match(/\bVolume\s+(\d+)\b/i)?.[1]||null;
  const issue=heading.match(/\b(?:Issue|Number|No\.)\s+(\d+)\b/i)?.[1]||null;
  // No date inference from article cards or a journal's archive year range.
  const issueSegment=heading.split('|').map(s=>s.trim()).find(s=>/\bVolume\s+\d+\b/i.test(s));
  const issueMonth=task?.collection==='issue'&&volume?explicitMonth(issueSegment):null;
  return {task_id:page.task_id,collection:task?.collection||null,catalog_url:page.source_url,
    captured_at:page.captured_at||null,volume,issue,issue_month:issueMonth,issue_heading:heading||null};
}
export function withTypedDates(paper){
  const p={...paper},text=p.evidence?.text||'';
  const quote=text.match(/(?:Version of Record online:|First Published online:?|Available online|Published online:?|First online:?)\s*((?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2},?\s+)?(?:19|20)\d{2})/i)?.[0];
  const firstQuote=text.match(/First published:?\s*((?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2},?\s+)?(?:19|20)\d{2})/i)?.[0];
  p.first_publication_month=firstQuote?explicitMonth(firstQuote):null;
  p.online_publication_month=quote?explicitMonth(quote):null;
  const issueMonths=[...new Set((p.catalog_memberships||[]).filter(m=>m.collection==='issue').map(m=>m.issue_month).filter(Boolean))];
  p.issue_publication_month=issueMonths.length===1?issueMonths[0]:null;
  p.publication_month_basis='legacy_unspecified';
  p.date_sources={online:quote?{quote,source_url:p.evidence.catalog_url}:null,first:firstQuote?{quote:firstQuote,source_url:p.evidence.catalog_url}:null,
    issue:(p.catalog_memberships||[]).filter(m=>m.issue_month).map(m=>({quote:m.issue_heading,source_url:m.catalog_url,month:m.issue_month}))};
  return p;
}
export function catalogDateLabel(paper,membership){
  const parts=[];
  if(membership?.collection==='issue')parts.push(`卷期：${membership.volume||'?'}卷 / ${membership.issue||'?'}期`, `卷期月份：${membership.issue_month||'待补'}`);
  else parts.push('在线发表列表');
  if(paper.online_publication_month)parts.push(`在线发表月份：${paper.online_publication_month}`);
  else if(paper.first_publication_month)parts.push(`首次发表月份：${paper.first_publication_month}`);
  else if(paper.publication_month)parts.push(`原始发表月份：${paper.publication_month}（日期类型待确认）`);
  return parts.join(' · ');
}
