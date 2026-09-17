// Reversible transport encoding only. Original text and its fingerprint stay unchanged.
// Each occurrence has its own marker, so a response cannot drop repeated numbers.
export function protectTranslationNumbers(text, field) {
  if (/PDN_/u.test(text)) throw Object.assign(new Error('Reserved numeric marker in source'), { code: 'NUMERIC_MARKER_COLLISION' });
  const tokens = [];
  const encoded = text.replace(/\d+(?:,\d{3})*(?:\.\d+)?/g, value => {
    const marker = `⟦PDN_${field === 'title' ? 'T' : 'A'}_${tokens.length}⟧`;
    tokens.push({ marker, value }); return marker;
  });
  return { encoded, tokens };
}

export function restoreTranslationNumbers(text, protection) {
  // A provider may return literal numbers despite the requested encoding. In that
  // case the unchanged numeric/length/body guard remains responsible for acceptance.
  if (!text.includes('PDN_')) return { text, error: null };
  const found = text.match(/⟦PDN_[^⟧]*⟧/gu) || [];
  const expected = new Map(protection.tokens.map(token => [token.marker, token.value]));
  if (found.length !== expected.size || new Set(found).size !== found.length || found.some(marker => !expected.has(marker)))
    return { text: null, error: 'NUMERIC_MARKER_MISMATCH' };
  const restored = text.replace(/⟦PDN_[^⟧]*⟧/gu, marker => expected.get(marker));
  if (restored.includes('PDN_')) return { text: null, error: 'NUMERIC_MARKER_MISMATCH' };
  return { text: restored, error: null };
}
