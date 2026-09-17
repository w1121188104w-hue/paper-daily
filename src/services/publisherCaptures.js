import { readFileSync } from 'node:fs';
import { evidenceHash } from './evidenceHttp.js';
import { normalizeTitleForMatch } from './paperModel.js';
import { publisherRecord } from './publisherParsers.js';
import { originalAbstractSection } from './searchExtraction.js';

// Exceptional, source-backed recovery of an already known paper, not a new
// discovery source or an AI-generated abstract. These are reviewed excerpts
// read from the public publisher page through a normal browser. The captured
// metadata, section boundaries and licence remain inspectable in version control.
const captures = [
  { file: '../../data/publisher-captures/car-70065.json',
    sha256: 'c95f067d0fb178a1484bfd53dca71eeee8dcdd68a6b2a4d1c1953ac7f3d3c570' }
];
const titleKey = text => normalizeTitleForMatch(text).replace(/\s/g, '');
const reviewed = captures.flatMap(entry => {
  try {
    const raw = readFileSync(new URL(entry.file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    if (evidenceHash(raw) !== entry.sha256) return [];
    const capture = JSON.parse(raw);
    const section = capture.section_heading + '\n' + capture.abstract + '\n' + capture.following_heading;
    if (originalAbstractSection(section) !== capture.abstract) return [];
    return [{ ...capture, capture_sha256: entry.sha256 }];
  } catch { return []; } // Missing/corrupt cache cannot block the normal sources.
});

export function publisherCaptureFor(paper, journal) {
  return reviewed.find(c => c.doi === paper.doi && c.journal_key === paper.journal_key && c.journal_key === journal.key &&
    c.journal === journal.name && titleKey(c.title) === titleKey(paper.title_original)) || null;
}

export function publisherCaptureRecord(paper, journal, checkedAt) {
  const c = publisherCaptureFor(paper, journal);
  if (!c) return null;
  // This is an assembled excerpt, not a claim to retain the entire HTML body.
  const raw = [c.title, 'DOI: ' + c.doi, c.journal, c.authors.join('; '),
    c.section_heading, c.abstract, c.following_heading].join('\n');
  const record = publisherRecord({ title: c.title, doi: c.doi, authors: [], date: '',
    url: c.source_url, abstract: c.abstract, raw_abstract: raw,
    evidence: { url: c.source_url, scope_url: c.source_url, fetched_at: c.captured_at,
      body_sha256: evidenceHash(raw), method: 'publisher_browser_excerpt_v1' } }, journal);
  record.last_checked_at = checkedAt;
  return record;
}

export function verifiedPublisherCapture(record) {
  const c = reviewed.find(item => item.doi === record.doi && item.journal_key === record.journal_key &&
    item.journal === record.journal_name && item.title === record.title);
  if (!c || record.source !== 'publisher' || record.source_evidence?.method !== 'publisher_browser_excerpt_v1' ||
      record.source_evidence.url !== c.source_url || record.source_evidence.scope_url !== c.source_url ||
      record.source_evidence.fetched_at !== c.captured_at ||
      record.abstract !== c.abstract) return false;
  const raw = [c.title, 'DOI: ' + c.doi, c.journal, c.authors.join('; '),
    c.section_heading, c.abstract, c.following_heading].join('\n');
  return record.raw_abstract === raw && record.source_evidence.body_sha256 === evidenceHash(raw);
}
