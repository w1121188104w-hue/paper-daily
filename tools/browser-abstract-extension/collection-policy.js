// User opted out of JPE Just Accepted / image-preview collection, 2026-09-23.
export function disabledCatalogUrl(value){
  try{const u=new URL(value);return u.hostname==='www.journals.uchicago.edu'&&/^\/toc\/jpe\/0\/ja\/?$/.test(u.pathname);}catch{return false;}
}
export function excludedJpePaper(p){
  if(p?.journal!=='JPE')return false;
  const memberships=p.catalog_memberships||[];
  return memberships.length>0&&memberships.every(m=>disabledCatalogUrl(m.catalog_url));
}
export function excludedJpeRecord(r){
  return r?.journal==='JPE'&&!r.abstract&&(!!r.ocr||r.collection_status==='excluded_by_user');
}
