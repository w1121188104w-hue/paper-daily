import { classifyPaper } from './paperClassification.js';
import { normalizeTitleForMatch } from './paperModel.js';

/** Supplement, not replace, the existing UI classification. Retain named lectures
 * and never infer document type merely from the absence of an abstract. */
export function paperDocumentType(paper, options) {
  const detail = classifyPaper(paper, options), classification = detail.kind;
  if (classification === 'other') return { document_type: detail.rule === 'named_lecture_or_address' ? 'lecture' :
    detail.rule === 'confirmed_nonresearch_type' ? 'other' : 'administrative', research_candidate: false };
  if (classification !== 'candidate') return { document_type: classification, research_candidate: false };
  const titles = (paper.source_records?.length ? paper.source_records.map(r => r.title) : [paper.title_original])
    .map(normalizeTitleForMatch).filter(Boolean);
  const lecture = title => /^(?:nobel lecture|presidential address)(?:\s|$)/.test(title);
  if (titles.length && titles.every(lecture)) return { document_type: 'lecture', research_candidate: false };
  if (titles.some(lecture)) return { document_type: 'uncertain', research_candidate: false };
  return { document_type: 'research_candidate', research_candidate: true };
}

/** Precise source dates can establish window membership without becoming a new
 * display field. Multiple conflicting days are kept as an uncertainty interval. */
export function evidenceWindowStatus(publication, fromDate, toDate, fallback) {
  if (!fromDate || !toDate || publication.publication_conflict) return 'unknown';
  const days = (publication.publication_evidence || []).map(e => e.value).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (!days.length) return fallback;
  const sorted = [...new Set(days)].sort(), first = sorted[0], last = sorted.at(-1);
  if (last < fromDate || first > toDate) return 'outside';
  if (first >= fromDate && last <= toDate) return 'inside';
  return 'boundary_uncertain';
}
