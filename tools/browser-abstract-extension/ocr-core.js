import {normalizeDoi,normalizeTitle,safeSourceUrl} from './core.js';
export const OCR_VERSION='jpe-preview-ocr-v1';
export function validOcrPage(paper,url){
  const safe=safeSourceUrl(url),doi=normalizeDoi(paper?.doi);
  return !!safe && paper?.journal==='JPE' && /^10\.1086\//.test(doi) &&
    new URL(safe).hostname==='www.journals.uchicago.edu' && decodeURIComponent(new URL(safe).pathname).toLowerCase().endsWith('/'+doi);
}
export function abstractFromOcr(paper,ocr){
  const strict=strictAbstractFromOcr(paper,ocr);
  // Preserve successful v1 evidence byte-for-byte. Recovery is a separate,
  // auditable candidate path, not a reason to lower OCR confidence thresholds.
  const result=strict.abstract?strict:recoverOcrBoundary(paper,ocr)||recoverHeadinglessAbstract(paper,ocr)||strict;
  if(result.abstract&&/(?:^|\s)[|\[]\s+[A-Za-z]/.test(result.abstract))return {status:'ocr_suspect_character',abstract:null};
  return result;
}
function strictAbstractFromOcr(paper,ocr){
  const fail=reason=>({status:reason,abstract:null});
  if(!Array.isArray(ocr?.lines)||ocr.lines.length>1500)return fail('invalid_ocr');
  const lines=ocr.lines.map(l=>typeof l.text==='string'?l.text.trim():'');
  const starts=lines.map((t,i)=>/^abstract\s*[:.]?$/i.test(t)?i:-1).filter(i=>i>=0);
  if(starts.length!==1)return fail('abstract_heading_missing_or_ambiguous');
  const start=starts[0],before=lines.slice(0,start).join(' '),title=normalizeTitle(paper.title);
  const foundDois=(before.match(/10\.\d{4,9}\/[\w.()/-]+/gi)||[]).map(d=>normalizeDoi(d.replace(/[.,;]+$/,'')));
  if(foundDois.some(d=>d!==normalizeDoi(paper.doi)))return fail('ocr_doi_conflict');
  const titleMatch=title.length>=20&&normalizeTitle(before).includes(title);
  if(!titleMatch&&!foundDois.includes(normalizeDoi(paper.doi)))return fail('ocr_identity_unconfirmed');
  let end=-1;
  for(let i=start+1;i<lines.length;i++)if(/^(?:JEL\b|Key\s*words\b|Keywords\b|(?:1[. ]+)?Introduction\b)/i.test(lines[i])){end=i;break;}
  if(end<0)return fail('abstract_end_not_visible');
  const selected=lines.slice(start+1,end).filter(Boolean),text=selected.join('\n');
  const confidence=ocr.lines.slice(start+1,end).filter(l=>l.text?.trim()).map(l=>l.confidence);
  if(confidence.some(c=>!Number.isFinite(c)||c<88)||confidence.reduce((a,b)=>a+b,0)/Math.max(1,confidence.length)<92)return fail('ocr_low_confidence');
  if(text.length<150||text.length>10000||(text.match(/\b[A-Za-z]+\b/g)||[]).length<25||!/[.!?][”’"']?$/.test(text)||/(?:\.{3}|…)\s*$/.test(text)||/[\u4e00-\u9fff]{3}|�|\b(?:Highlights|References|Acknowledgments)\b/i.test(text))return fail('ocr_incomplete_or_uncertain');
  // No spelling repair, guessing or dehyphenation. Keep exact OCR lines and
  // explicitly document the sole whitespace transformation.
  return {status:'ocr_candidate',abstract:text,line_start:start+1,line_end:end,
    normalization:'trim_lines_preserve_linebreaks',identity_method:titleMatch?'image_title':'image_doi',
    quality:'ocr_not_character_accuracy_verified'};
}
function distance(a,b){
  let row=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next;}
  return row[b.length];
}
function heading(text){
  const m=text.match(/^([A-Za-z]{7,9})(?:\s*[.:]\s*|\s*$)/);
  return m&&distance(m[1].toLowerCase(),'abstract')<=2?m[0].length:null;
}
function recoverHeadinglessAbstract(paper,ocr){
  if(!Array.isArray(ocr?.lines)||ocr.lines.length>1500)return null;
  const rows=ocr.lines,lines=rows.map(l=>typeof l.text==='string'?l.text.trim():'');
  // Only a front-page summary ending at an explicit Keywords label qualifies.
  // Never reinterpret an Introduction/Highlights/body paragraph as an abstract.
  if(lines.some(t=>heading(t)!==null))return null;
  const ends=lines.map((t,i)=>/^key\s*words\s*:/i.test(t)?i:-1).filter(i=>i>=0);
  if(ends.length!==1)return null;
  const end=ends[0];let start=end-1;
  if(start<1)return null;
  const validBox=b=>b&&['x0','x1','y0','y1'].every(k=>Number.isFinite(b[k]))&&b.x1>b.x0&&b.y1>b.y0;
  while(start>0){
    const prev=rows[start-1].bbox,box=rows[start].bbox;
    if(!validBox(prev)||!validBox(box))return null;
    if(box.y0-prev.y1>Math.max(22,(box.y1-box.y0)*1.2))break;
    start--;
  }
  if(start<2||end-start<6||end-start>35)return null;
  const before=lines.slice(0,start).join(' '),title=normalizeTitle(paper.title);
  const dois=(before.match(/10\.\d{4,9}\/[\w.()/-]+/gi)||[]).map(d=>normalizeDoi(d.replace(/[.,;]+$/,'')));
  if(dois.some(d=>d!==normalizeDoi(paper.doi)))return null;
  if(title.length<20||!normalizeTitle(before).includes(title))return null;
  if(lines.slice(0,end).some(t=>/^(?:(?:\d+[. ]+)?(?:Introduction|Background|Literature Review|Highlights|References)|(?:\d+(?:\.\d+)*[. ]+)\S)/i.test(t)))return null;
  const selected=lines.slice(start,end),text=selected.join('\n');
  if(!/^(?:We\s|I\s|This (?:paper|study|article)\b)/.test(text)||!/[.!?][”’"']?$/.test(text)||/(?:\.{3}|…)\s*$/.test(text))return null;
  if(text.length<300||text.length>5000||(text.match(/\b[A-Za-z]+\b/g)||[]).length<70||/�|[\u4e00-\u9fff]{3}/.test(text)||selected.some(t=>/^(?:Highlights|References|Acknowledg(?:e)?ments)\s*:?\s*$/i.test(t)))return null;
  const body=rows.slice(start,end),confidence=body.map(l=>l.confidence);
  if(body.some(l=>!validBox(l.bbox))||confidence.some(c=>!Number.isFinite(c)||c<88)||confidence.reduce((a,b)=>a+b,0)/confidence.length<92)return {status:'ocr_low_confidence',abstract:null};
  return {status:'ocr_candidate',abstract:text,line_start:start,line_end:end,line_start_offset:0,
    normalization:'trim_lines_preserve_linebreaks',identity_method:'image_title',boundary_method:'headingless_front_summary_before_keywords',
    recovery_version:'ocr-headingless-v3',requires_semantic_check:true,quality:'ocr_not_character_accuracy_verified'};
}
function recoverOcrBoundary(paper,ocr){
  if(!Array.isArray(ocr?.lines)||ocr.lines.length>1500)return null;
  const lines=ocr.lines.map(l=>typeof l.text==='string'?l.text.trim():''),starts=[];
  lines.forEach((t,i)=>{const offset=heading(t);if(offset!==null)starts.push({i,offset});});
  if(starts.length!==1)return null;
  const {i:head,offset}=starts[0],before=lines.slice(0,head).join(' '),title=normalizeTitle(paper.title);
  const dois=(before.match(/10\.\d{4,9}\/[\w.()/-]+/gi)||[]).map(d=>normalizeDoi(d.replace(/[.,;]+$/,'')));
  if(dois.some(d=>d!==normalizeDoi(paper.doi)))return null;
  const titleMatch=title.length>=20&&normalizeTitle(before).includes(title);
  if(!titleMatch&&!dois.includes(normalizeDoi(paper.doi)))return null;
  const inline=lines[head].slice(offset),start=inline?head:head+1;
  let end=-1,boundary=null;
  for(let i=start+1;i<lines.length;i++){
    const t=lines[i];
    if(/^(?:JEL\b|Key\s*words\b|Keywords\b|(?:1[. ]+)?Introduction\b|Acknowledg(?:e)?ments\b)/i.test(t)){
      end=i;boundary='explicit_section';break;
    }
    // Small-caps OCR can miss letters in KEY WORDS. Only a short labelled
    // heading with a colon qualifies, never a substring of running prose.
    const key=t.match(/^(key\s*[a-z]{4,7})\s*:/i);
    if(key&&distance(key[1].replace(/\s/g,'').toLowerCase(),'keywords')<=2){end=i;boundary='keyword_heading_ocr';break;}
    const prev=ocr.lines[i-1]?.bbox,box=ocr.lines[i]?.bbox;
    const gap=prev&&box?box.y0-prev.y1:0;
    const separated=prev&&box&&gap>=Math.max(18,(prev.y1-prev.y0)*1.2);
    const footer=/^[*†‡“"']/.test(t)||/^(?:[A-Z][A-Za-z'-]+:\s*(?:University|Department|Institute)|(?:We|I|The authors)\s+(?:thank|am grateful|are grateful)|Edited by\b)/i.test(t);
    // Require both a visual separation and a footnote/affiliation cue.
    if(separated&&footer){end=i;boundary='separated_footnote';break;}
  }
  if(end<0){
    const layout=ocr.image_layout,body=ocr.lines.slice(start).filter(l=>l.text?.trim());
    const last=body.at(-1),h=layout?.height;
    // Only substantial text followed by a measured, long white area and a
    // separate page footer can become a candidate for semantic review. This
    // does NOT allow a short paragraph ending at the footnotes/page edge.
    if(layout?.method==='pixel_whitespace_v1'&&layout.footer_ink&&Number.isFinite(h)&&body.length>=6&&
      body.every(l=>l.bbox&&Number.isFinite(l.bbox.y1))&&last.bbox.y1<h*.72&&
      layout.blank_bands?.some(b=>b.y0>=last.bbox.y1-2&&b.y0<=last.bbox.y1+40&&b.y1>=h*.90&&b.y1-b.y0>=h*.20)&&
      (body.map(l=>l.text).join(' ').match(/\b[A-Za-z]+\b/g)||[]).length>=70){
      end=lines.length;boundary='measured_blank_area_before_footer';
    }
  }
  if(end<0)return null;
  const selected=lines.slice(start,end);if(inline)selected[0]=inline;
  const text=selected.filter(Boolean).join('\n');
  const confidence=ocr.lines.slice(start,end).filter(l=>l.text?.trim()).map(l=>l.confidence);
  if(confidence.some(c=>!Number.isFinite(c)||c<88)||confidence.reduce((a,b)=>a+b,0)/Math.max(1,confidence.length)<92)return {status:'ocr_low_confidence',abstract:null};
  // A tiny paragraph before a long footnote may continue on page two.
  if(boundary==='separated_footnote'&&selected.filter(Boolean).length<4)return {status:'ocr_possible_continuation',abstract:null};
  if(text.length<150||text.length>10000||(text.match(/\b[A-Za-z]+\b/g)||[]).length<25||!/[.!?,][”’"']?$/.test(text)||/(?:\.{3}|…)\s*$/.test(text)||/[\u4e00-\u9fff]{3}|�|\b(?:Highlights|References|Acknowledg(?:e)?ments)\b/i.test(text))return null;
  return {status:'ocr_candidate',abstract:text,line_start:start,line_end:end,line_start_offset:inline?offset:0,
    normalization:'trim_lines_preserve_linebreaks_remove_heading_only',identity_method:titleMatch?'image_title':'image_doi',
    boundary_method:boundary,recovery_version:'ocr-boundary-v2',requires_semantic_check:true,
    quality:'ocr_not_character_accuracy_verified'};
}
export function recoverStoredOcr(record){
  if(!record.identity?.ok||!validOcrPage(record,record.source_url)||!record.ocr?.lines||
    !/^[a-f0-9]{64}$/.test(record.ocr.image_sha256||'')||record.evidence?.some(b=>b.kind==='abstract'&&b.ocr_provenance))return record;
  const o=record.ocr,extraction=abstractFromOcr(record,o);
  if(!extraction.abstract)return record;
  const capture=appendOcrEvidence({url:record.source_url,evidence:record.evidence||[],candidates:[]},record,o,
    {source_url:o.image_source_url,kind:o.capture_kind,source_width:o.source_width,source_height:o.source_height,width:o.capture_width,height:o.capture_height,layout:o.image_layout});
  return {...record,evidence:capture.evidence,ocr:capture.ocr};
}
export function appendOcrEvidence(capture,paper,ocr,image){
  const withLayout={...ocr,image_layout:image.layout||ocr.image_layout};
  const extraction=abstractFromOcr(paper,withLayout);
  const audit={...withLayout,extraction,image_source_url:image.source_url||null,capture_kind:image.kind,
    image_cache_file:'ocr/'+ocr.image_sha256+'.png',source_width:image.source_width,source_height:image.source_height,capture_width:image.width,capture_height:image.height};
  if(!extraction.abstract)return {...capture,ocr:audit};
  const transcript=ocr.lines.map(l=>l.text.trim()).join('\n');
  const recovery=extraction.recovery_version?{recovery_version:extraction.recovery_version,boundary_method:extraction.boundary_method,line_start_offset:extraction.line_start_offset}:{};
  const block={id:'ocr-abstract-'+ocr.image_sha256.slice(0,12),kind:'abstract',context:'ocr:publisher_visible_preview',language:'en',truncated:false,text:extraction.abstract,
    ocr_provenance:{version:OCR_VERSION,engine:ocr.engine,image_sha256:ocr.image_sha256,image_source_url:image.source_url||null,
      source_url:safeSourceUrl(capture.url),line_start:extraction.line_start,line_end:extraction.line_end,normalization:extraction.normalization,quality:extraction.quality,...recovery}};
  const context=extraction.recovery_version?[{id:'ocr-page-'+ocr.image_sha256.slice(0,12),kind:'context',context:'ocr_full_preview_context_not_an_abstract',text:transcript}]:[];
  return {...capture,ocr:audit,evidence:[...(capture.evidence||[]),...context,block],candidates:[...(capture.candidates||[]),{text:block.text,field:block.context,language:'en'}]};
}
