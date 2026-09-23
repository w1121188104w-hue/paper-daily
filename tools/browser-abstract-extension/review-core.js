// Shared browser/server validator. Model text never becomes paper metadata directly.
import { safeSourceUrl, normalizeDoi, normalizeTitle } from './core.js';
import { enrichCatalogItem, mergeCatalog } from './catalog-core.js';
import { validAffiliationBlock, validatedAffiliations } from './affiliations.js';
import {ARTICLE_REVIEW_PROTOCOL,compactArticleInput,abstractBlockSpans,expectsAbstract,verdictOutput} from './article-review.js';
import {recoverStoredOcr} from './ocr-core.js';
import {detailOtherSource} from './article-type.js';
import {applyAbstractAvailability} from './abstract-availability.js';
import {disabledCatalogUrl,excludedJpeRecord} from './collection-policy.js';
export const REVIEW_FIELDS = ['title', 'doi', 'authors', 'publication_date', 'abstract'];
export function validateReviewInput(input) {
  if (!input || !['catalog', 'article'].includes(input.kind) || !safeSourceUrl(input.source_url) ||
    !input.identity || typeof input.identity.title !== 'string' || input.identity.title.length > 1500 ||
    !Array.isArray(input.blocks) || !input.blocks.length || input.blocks.length > 100 ||
    JSON.stringify(input).length > 80000) throw Error('INVALID_OR_OVERSIZE_EVIDENCE');
  const seen = new Set();
  for (const b of input.blocks) {
    if (!b || !/^[a-zA-Z0-9-]{1,80}$/.test(b.id) || seen.has(b.id) || typeof b.text !== 'string' || b.text.length > 60000 ||
      !['title','doi','card','abstract','context'].includes(b.kind)) throw Error('INVALID_EVIDENCE_BLOCK');
    seen.add(b.id);
    if (b.affiliation_record && !validAffiliationBlock(b)) throw Error('INVALID_AFFILIATION_EVIDENCE');
    if (b.parent_block_id) {
      const parent = input.blocks.find(p => p.id === b.parent_block_id);
      if (!parent || !Number.isInteger(b.parent_start) || !Number.isInteger(b.parent_end) || b.parent_start < 0 ||
        b.parent_end <= b.parent_start || parent.text.slice(b.parent_start,b.parent_end) !== b.text) throw Error('INVALID_PARENT_EVIDENCE');
    }
  }
  return input;
}
export function copyEvidenceSpans(blocks, spans, repeatedTitle = null) {
  if (!Array.isArray(spans) || !spans.length || spans.length > 20) throw Error('MISSING_SPANS');
  return spans.map(s => {
    const block = blocks.find(b => b.id === s.block_id);
    if (!block || typeof s.quote !== 'string' || !s.quote.trim()) throw Error('INVALID_SPAN');
    const start = block.text.indexOf(s.quote);
    if (start < 0 || (block.text.indexOf(s.quote, start + 1) >= 0 && s.quote !== repeatedTitle)) throw Error('QUOTE_NOT_UNIQUE_IN_SOURCE');
    return { block_id: block.id, start, end: start + s.quote.length, text: block.text.slice(start, start + s.quote.length) };
  });
}
export function publicationMonth(text) {
  const s = String(text || '').trim();
  if (/^\d{4}-(?:0[1-9]|1[0-2])(?:-\d{2})?$/.test(s)) return s.slice(0, 7);
  const names = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const m = s.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2},?\s+)?((?:19|20)\d{2})\b/i);
  if (!m || (s.match(/\b(?:19|20)\d{2}\b/g) || []).length !== 1) return null;
  return `${m[2]}-${String(names.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}`;
}
export function validateReviewOutput(input, output) {
  validateReviewInput(input);
  const fields = {}, proofs = {}, states = {};
  if (!output || output.identity_match !== true || !output.fields || typeof output.fields !== 'object')
    return { status: 'identity_unconfirmed', fields: {}, proofs: {}, states: {}, publication_month: null };
  for (const name of REVIEW_FIELDS) {
    fields[name] = null;
    const value = output.fields[name];
    if (!value || !['confirmed','corrected'].includes(value.status)) { states[name] = 'missing_or_uncertain'; continue; }
    try {
      // A duplicate checkbox label on ScienceDirect repeats the exact title.
      // Only that known title can repeat; authors, DOI and abstract stay strict.
      const spans = name==='abstract' && input.review_protocol===ARTICLE_REVIEW_PROTOCOL ? abstractBlockSpans(input,value) :
        copyEvidenceSpans(input.blocks, value.spans, name === 'title' ? input.identity.title : null);
      // Preview OCR is supporting context for abstract boundaries, not a new
      // authority for author spelling or publication dates (often draft dates).
      if(name!=='abstract'&&spans.some(s=>{const b=input.blocks.find(b=>b.id===s.block_id);return b.ocr_provenance||b.context==='ocr_full_preview_context_not_an_abstract';}))throw Error('OCR_CONTEXT_NOT_METADATA');
      const text = spans.map(s => s.text).join(name === 'abstract' ? '\n\n' : '; ');
      if (name === 'doi') {
        if (spans.length !== 1 || !normalizeDoi(text) || (input.identity.doi && normalizeDoi(text) !== normalizeDoi(input.identity.doi))) throw Error('DOI_CONFLICT');
      }
      if (name === 'title' && (text.length < 5 || text.length > 1500 || spans.length !== 1)) throw Error('INVALID_TITLE');
      if (name === 'abstract') {
        if (spans.some(s => { const b = input.blocks.find(b => b.id === s.block_id); return b.kind !== 'abstract' || b.truncated || /graphical|highlights/i.test(b.context || '') || (b.language && !/^en(?:[-_]|$)/i.test(b.language)); }) ||
          text.length < 150 || text.length > 20000 || !/\b(?:the|this|we|of|and|in)\b/i.test(text) ||
          (text.match(/\b[A-Za-z]+\b/g) || []).length < 25 || /[\u4e00-\u9fff]{5}|(?:\.{3}|…)\s*$|^highlights\b/i.test(text)) throw Error('NOT_A_COMPLETE_ENGLISH_ABSTRACT');
        // Do not permit a model to shorten an abstract into an excerpt.
        if (spans.some(s => s.text.trim() !== input.blocks.find(b => b.id === s.block_id).text.trim())) throw Error('PARTIAL_ABSTRACT_SELECTION');
      }
      fields[name] = name === 'doi' ? normalizeDoi(text) : text;
      proofs[name] = spans; states[name] = value.status;
    } catch (error) { states[name] = error.message; }
  }
  // A trusted page match was required before input creation; AI cannot invent identity.
  if (fields.title && input.identity.doi == null && normalizeTitle(fields.title) !== normalizeTitle(input.identity.title)) {
    fields.title = null; delete proofs.title; states.title = 'TITLE_IDENTITY_UNCONFIRMED';
  }
  return { status: 'source_checked_candidate', fields, proofs, states, publication_month: publicationMonth(fields.publication_date),
    ...(input.affiliation_extraction_version === 1 ? {affiliations:validatedAffiliations(input,output.affiliations)} : {}),
    assurance: 'exact_source_spans_and_model_semantic_check_not_a_guarantee' };
}
export function makeReviewJobs(catalog, article, {includeRetired=false}={}) {
  const jobs = [], skipped = [];
  for (const page of catalog?.pages || []) for (const original of page.items || []) {
    const item = enrichCatalogItem(original);
    const id = `catalog:${page.job_key}:${item.url}`;
    if(!includeRetired&&(disabledCatalogUrl(page.source_url)||disabledCatalogUrl(page.requested_url))){skipped.push({id,reason:'excluded_by_user'});continue;}
    if (item.evidence?.version !== 2 || !item.evidence.text) { skipped.push({ id, reason: 'recapture_required' }); continue; }
    const blocks = [{ id: 'card', kind: 'card', text: item.evidence.text, context: item.evidence.section || '' }];
    blocks.push(...catalogAbstractBlocks(item));
    // The link DOI is independently observed; never add unverified proposed fields as evidence.
    if (item.doi && decodeURIComponent(item.url).toLowerCase().includes(item.doi)) blocks.push({ id: 'link-doi', kind: 'doi', text: item.doi });
    const input = { kind: 'catalog', source_url: item.url, identity: { title: item.title, doi: item.doi, journal: item.journal }, blocks,
      proposed: { title: item.title, doi: item.doi, authors: item.authors_raw, publication_date: item.date_raw } };
    try { validateReviewInput(input); jobs.push({ id, input }); } catch { skipped.push({ id, reason: 'evidence_too_large_or_invalid' }); }
  }
  for (const original of article?.records || []) {
    const record=recoverStoredOcr(original);
    const id = `article:${record.doi}`;
    if(!includeRetired&&excludedJpeRecord(record)){skipped.push({id,reason:'excluded_by_user'});continue;}
    if (!record.identity?.ok || record.evidence_version !== 2 || !record.evidence?.length) { skipped.push({ id, reason: 'recapture_required' }); continue; }
    const legacy_input = { kind: 'article', source_url: record.source_url, identity: { title: record.title, doi: record.doi, journal: record.journal },
      blocks: record.evidence, proposed: { title: record.title, doi: record.doi, abstract: record.abstract },
      ...(record.affiliation_extraction_version===1 ? {affiliation_extraction_version:1} : {}) };
    try { const input=compactArticleInput(legacy_input); validateReviewInput(input); jobs.push({ id, input, legacy_input }); } catch { skipped.push({ id, reason: 'essential_evidence_too_large_or_invalid' }); }
  }
  return { jobs, skipped };
}

export function catalogAbstractBlocks(item) {
  // JPE cards store the displayed Abstract at the end of the article's card.
  // Recover the exact saved span, not a generated summary or an Abstract link.
  if (item.journal !== 'JPE' || item.type === 'other' || item.evidence?.version !== 2 ||
    !/^https:\/\/www\.journals\.uchicago\.edu\/doi\/(?:abs\/|full\/)?10\.1086\//i.test(item.url || '')) return [];
  const text = item.evidence.text || '', markers = [...text.matchAll(/\bAbstract\s+/g)];
  if (markers.length !== 1 || !item.title || !text.includes(item.title)) return [];
  const marker = markers[0], titleEnd = text.indexOf(item.title) + item.title.length;
  if (marker.index < titleEnd || /graphical\s*$/i.test(text.slice(0,marker.index))) return [];
  const start = marker.index + marker[0].length, body = text.slice(start).trimEnd();
  if (body.length < 150 || body.length > 20000 || (body.match(/\b[A-Za-z]+\b/g) || []).length < 25 ||
    !/\b(?:we|this|the|of|and|in)\b/i.test(body) || !/[.!?][”’"']?$/.test(body) || /(?:\.{3}|…)\s*$/.test(body) ||
    /\b(?:Highlights|Introduction|Keywords|References|Related articles|Recommended articles|Read more|Show more)\b/i.test(body) ||
    /^(?:Full text|PDF|Download|Supplemental)/i.test(body)) return [];
  return [{id:'catalog-abstract',kind:'abstract',context:'publisher_catalog:Abstract',language:'en',text:body,
    parent_block_id:'card',parent_start:start,parent_end:start+body.length}];
}

export function reviewedCatalogPapers(catalog, plan, results) {
  const papers = mergeCatalog(catalog.pages || []);
  for (const paper of papers) {
    paper.review_status = 'pending';
    for (const job of plan.jobs.filter(j => j.input.source_url === paper.url && j.input.identity.journal === paper.journal &&
      !(paper.doi && j.input.identity.doi && paper.doi !== j.input.identity.doi))) {
      const result = results[job.hash];
      if (!result) continue;
      if (result.error || !result.verdict) { paper.review_status = result.error || 'invalid_response'; continue; }
      // Recheck source quotes when composing final fields; do not trust stored
      // model strings or a status flag as proof. Preserve raw captures separately.
      const output = { identity_match: result.verdict.status === 'source_checked_candidate', fields: {} };
      for (const [field, spans] of Object.entries(result.verdict.proofs || {})) output.fields[field] = {
        status: result.verdict.states[field], spans: spans.map(s => ({block_id:s.block_id,quote:s.text})) };
      const checked = validateReviewOutput(job.input, output);
      paper.review_status = checked.status; paper.review_field_states = checked.states;
      if (checked.status !== 'source_checked_candidate') continue;
      for (const [field, target] of Object.entries({title:'title',doi:'doi',authors:'authors_raw',publication_date:'date_raw',abstract:'abstract'})) {
        if (!checked.fields[field]) continue;
        paper[target] = checked.fields[field];
        paper.field_sources[target] = {method:'deepseek_source_checked',source_url:job.input.source_url,proofs:checked.proofs[field]};
        if (field === 'abstract') {
          paper.abstract_status = 'source_checked'; paper.abstract_source = 'publisher_catalog'; paper.abstract_source_url = job.input.source_url;
        }
      }
      if (checked.publication_month) {
        paper.publication_month = checked.publication_month;
        paper.field_sources.publication_month = paper.field_sources.date_raw;
      }
      paper.doi_status = paper.doi ? 'present' : 'no_doi_yet';
    }
  }
  return papers;
}

export async function reviewedArticleRecords(article, plan, results) {
  return Promise.all((article.records||[]).map(async record=>{
    const job=plan.jobs.find(j=>j.id===`article:${record.doi}`), result=job && results[job.hash];
    const copy={...record,abstract:null,abstract_length:0,abstract_sha256:null,abstract_field:null,
      abstract_status:'pending_source_review',affiliations:[],affiliation_status:'pending_source_review'};
    delete copy.abstract_source;delete copy.abstract_source_url;delete copy.abstract_provenance;
    if(excludedJpeRecord(record)){copy.collection_status='excluded_by_user';if(!result){copy.abstract_status='excluded_by_user';copy.review_status='excluded_by_user';return copy;}}
    const typeSource=detailOtherSource(record);
    if(typeSource){copy.type='other';copy.field_sources={...record.field_sources,type:typeSource};}
    if(!result || (result.error && result.error!=='PROVIDER_ABSTRACT_NOT_EXTRACTED') || !result.verdict){copy.review_status=result?.error||'pending';return applyAbstractAvailability(copy);}
    const checked=validateReviewOutput(job.input,verdictOutput(job.input,result.verdict));
    copy.review_status=checked.status;
    if(checked.status!=='source_checked_candidate')return applyAbstractAvailability(copy);
    copy.abstract=checked.fields.abstract;copy.abstract_status=copy.abstract?'source_checked':expectsAbstract(job.input)?'needs_review':'missing';
    if(copy.abstract_status==='needs_review')copy.review_status='needs_attention';
    copy.review_field_states=checked.states;
    if(copy.abstract){
      const block=job.input.blocks.find(b=>b.id===checked.proofs.abstract?.[0]?.block_id);
      copy.abstract_length=copy.abstract.length;
      copy.abstract_sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(copy.abstract)))].map(x=>x.toString(16).padStart(2,'0')).join('');
      copy.abstract_field=checked.proofs.abstract.map(p=>p.block_id).join(',');
      copy.abstract_source=block?.ocr_provenance?'publisher_preview_image':'publisher_article';copy.abstract_source_url=record.source_url;
      if(block?.ocr_provenance){copy.abstract_status='source_checked_ocr';copy.abstract_provenance=block.ocr_provenance;}
    }
    copy.affiliations=checked.affiliations||[];copy.affiliation_status=copy.affiliations.length?'source_checked':'missing';
    copy.authors_raw=checked.fields.authors||null;copy.publication_month=checked.publication_month;
    copy.field_proofs=checked.proofs;return applyAbstractAvailability(copy);
  }));
}
