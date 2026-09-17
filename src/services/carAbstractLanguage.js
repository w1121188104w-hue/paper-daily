import { extractionEvidence } from './searchExtraction.js';
import { evidenceHash } from './evidenceHttp.js';
import { verifiedPublisherCapture } from './publisherCaptures.js';

// A positive publisher language heading, not a guessed language classifier.
// Preserve the French original while the author's English version is sought.
export const needsCarEnglishAbstract = paper => paper.journal_key === 'CAR' &&
  /^RÉSUMÉ\s*/iu.test(paper.abstract_original || '') && !/\bABSTRACT\b/i.test(paper.abstract_original);

export const missingOriginalAbstract = paper => !paper.abstract_original || needsCarEnglishAbstract(paper);

// Only verified verbatim publisher evidence (search/reader or a pinned browser
// excerpt) may replace French. Model-produced text and language guesses fail.
export function verifiedCarEnglishRecord(record) {
  if (record.journal_key === 'CAR' && verifiedPublisherCapture(record)) return true;
  if (record.journal_key !== 'CAR' || record.source !== 'publisher' ||
      !['zhipu_search_verbatim_abstract', 'zhipu_reader_verbatim_abstract'].includes(record.source_evidence?.method) ||
      record.source_evidence.body_sha256 !== evidenceHash(record.raw_abstract)) return false;
  const rows = extractionEvidence([{ title: record.title, url: record.source_evidence.url,
    content: record.raw_abstract }], { title_original: record.title, doi: record.doi },
  { key: 'CAR', name: record.journal_name, electronic_issn: record.electronic_issn });
  return rows.some(row => row.publisher && row.abstract === record.abstract && !/^RÉSUMÉ/iu.test(row.abstract));
}
