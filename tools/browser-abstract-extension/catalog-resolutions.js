// Narrow, source-verified exceptions. Never merge arbitrary conflicting DOIs by
// title similarity. Both original captures and review-cache inputs stay intact.
export const KNOWN_CATALOG_ALIASES = [{
  journal:'AER', title:'Contextually Private Mechanisms',
  canonical_doi:'10.1257/aer.20240579', alternate_doi:'10.1257/aer.20240576',
  canonical_url:'https://www.aeaweb.org/articles?id=10.1257%2Faer.20240579',
  alternate_url:'https://www.aeaweb.org/articles?id=10.1257%2Faer.20240576',
  verified_on:'2026-09-21',
  reason:'Publisher published citation uses 10.1257/aer.20240579 (116(9), 3223–62); the alternate publisher page is labelled Forthcoming with the same title, authors and abstract.'
}];
export function resolveKnownCatalogAliases(papers) {
  const out=[...papers];
  for(const rule of KNOWN_CATALOG_ALIASES){
    const matches=(p,doi,url)=>p.journal===rule.journal && p.doi===doi && p.title===rule.title && p.url===url;
    const canonical=out.find(p=>matches(p,rule.canonical_doi,rule.canonical_url));
    const index=out.findIndex(p=>matches(p,rule.alternate_doi,rule.alternate_url));
    if(!canonical || index<0)continue;
    const alternate=out[index];
    canonical.alternate_records=[...(canonical.alternate_records||[]),structuredClone(alternate)];
    canonical.catalog_urls=[...new Set([...(canonical.catalog_urls||[]),...(alternate.catalog_urls||[])])];
    canonical.catalog_memberships=[...(canonical.catalog_memberships||[]),...(alternate.catalog_memberships||[])];
    canonical.record_resolution={method:'publisher_verified_alias',...rule};
    out.splice(index,1);
  }
  return out;
}
