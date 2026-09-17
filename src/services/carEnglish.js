import { cleanAbstract, cleanText, normalizeSourceRecord } from './paperModel.js';

// Crossref's inline XML can insert whitespace inside COVID-19 / AI-supported.
// Match without whitespace, but return the publisher's untouched prefix.
export function carTitlePrefix(full, candidate) {
  const target = candidate.replace(/\s/gu, '');
  if (candidate.length < 20 || !target || !full.replace(/\s/gu, '').startsWith(target)) return '';
  let count = 0;
  for (let i = 0; i < full.length; i++) if (!/\s/u.test(full[i]) && ++count === target.length) return full.slice(0, i + 1);
  return '';
}

// CAR sometimes concatenates its English and French editions. Select verbatim
// prefixes only; never translate, summarize, or infer an English title boundary.
export function selectCarEnglish(record, peers = []) {
  if (record.journal_key !== 'CAR') return null;
  const current = record;
  if (record.text_selection) record = { ...record, title: record.text_selection.original_title,
    abstract: record.text_selection.original_abstract, text_selection: undefined };
  const raw = record.raw_abstract || record.abstract;
  const marker = /RÉSUMÉ/u.exec(raw);
  if (!marker || !/^\s*ABSTRACT\b/i.test(raw) || raw.slice(marker.index + marker[0].length).trim().length < 60) return null;
  const before = raw.slice(0, marker.index);
  const paragraphs = before.split(/\r?\n/).map(cleanText).filter(Boolean);
  const last = paragraphs.at(-1) || '';
  // Some pages repeat the French title on its own line just before RÉSUMÉ.
  const caption = last.length >= 20 && last.length < record.title.length && record.title.endsWith(last) ? last : '';
  let title = caption ? record.title.slice(0, -caption.length).trim() : record.title;
  const confirmed = peers.filter(p => p.doi && p.doi === record.doi && p.journal_key === 'CAR' &&
    !p.text_selection && p.title.length >= 20 && p.title.length < title.length && carTitlePrefix(title, p.title))
    .sort((a, b) => a.title.length - b.title.length)[0];
  if (confirmed) title = carTitlePrefix(title, confirmed.title);
  let abstract = cleanAbstract(before);
  const frenchTitle = record.title.slice(title.length).trim();
  if (frenchTitle && abstract.endsWith(frenchTitle)) abstract = abstract.slice(0, -frenchTitle.length).trim();
  if (abstract.length < 100 || !record.abstract.startsWith(abstract)) return null;
  if (title === current.title && abstract === current.abstract) return null;
  return normalizeSourceRecord({ ...record, title, abstract,
    text_selection: { policy: 'car_english_v1', original_title: record.title, original_abstract: record.abstract } });
}
