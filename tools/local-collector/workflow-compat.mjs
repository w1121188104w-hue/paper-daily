// OUP includes a "Get access" control inside some catalogue title links.
// Correct only an exact, DOI-bound match to the separately observed article title.
export function normalizeOupControlLabel(record, pages, capture) {
  let hostname;
  try { hostname=new URL(record.source_url).hostname; } catch { return null; }
  if(hostname!=='academic.oup.com' || !record.identity?.ok || !record.doi ||
      !String(record.title).endsWith('Get access'))return null;
  const dois=(capture.dois||[]).map(d=>String(d).toLowerCase());
  if(!dois.length || dois.some(d=>d!==record.doi.toLowerCase()))return null;
  const title=record.title.slice(0,-'Get access'.length).trim();
  if(!(capture.titles||[]).includes(title))return null;
  const cards=pages.flatMap(p=>p.items||[]).filter(i=>i.journal===record.journal &&
    i.url===record.url && i.title===record.title && (!i.doi || i.doi.toLowerCase()===record.doi.toLowerCase()));
  if(!cards.length || cards.some(i=>!i.evidence?.text?.includes(title)))return null;
  const correction={method:'remove_oup_access_control_with_exact_article_doi_and_title',
    original_title:record.title,title,source_url:record.source_url,doi:record.doi};
  record.title=title;record.title_normalization=correction;
  for(const card of cards){card.title=title;card.title_normalization=correction;}
  return correction;
}
