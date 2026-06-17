import pdfParse from 'pdf-parse';

export async function extractPdfText(pdfUrl, maxChars = 16000) {
  if (!pdfUrl) return '';
  const response = await fetch(pdfUrl);
  if (!response.ok) {
    throw new Error(`PDF download failed: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const parsed = await pdfParse(buffer);
  const text = String(parsed.text || '').replace(/\s+/g, ' ').trim();
  return text.slice(0, maxChars);
}
