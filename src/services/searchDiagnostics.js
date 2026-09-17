// Only fixed local codes, HTTP status numbers, and documented Zhipu business codes
// may leave the request boundary. Never return remote messages, URLs, or raw bodies.
const localCodes = new Set(['RATE_LIMITED', 'ACCESS_RESTRICTED', 'SEARCH_HTTP_ERROR',
  'SEARCH_PROVIDER_ERROR', 'INVALID_SEARCH_RESPONSE', 'SEARCH_RESPONSE_TOO_LARGE',
  'TIMEOUT', 'SEARCH_NETWORK_ERROR', 'MISSING_ZHIPU_KEY', 'MISSING_SERPAPI_KEY',
  'INVALID_SEARCH_QUERY', 'SEARCH_QUERY_TOO_LONG', 'INVALID_SEARCH_PROVIDER']);
// Current /cn/api/api-code plus the provider's older /cn/faq/api-code reference.
// Unknown future codes stay redacted, including arbitrary strings from the server.
const zhipuCodes = new Set(['1000', '1001', '1002', '1003', '1004', '1005', '1113', '1200', '1210',
  '1211', '1212', '1213', '1214', '1215', '1220', '1221', '1222', '1230', '1234',
  '1261', '1301', '1302', '1305', '1308', '1309', '1310', '1311', '1313', '1314',
  '1315', '1316', '1317', '1318', '1319', '1320', '1321']);

export function safeSearchDiagnostic(error, provider) {
  const remoteCode = typeof error?.provider_error_code === 'number' && Number.isInteger(error.provider_error_code)
    ? String(error.provider_error_code) : error?.provider_error_code;
  return {
    code: localCodes.has(error?.code) ? error.code : 'SEARCH_REQUEST_FAILED',
    http_status: Number.isInteger(error?.http_status) && error.http_status >= 100 && error.http_status <= 599 ? error.http_status : null,
    provider_error_code: provider === 'zhipu' && zhipuCodes.has(remoteCode) ? remoteCode : null
  };
}

// Inspect credentials only in runner memory. No characters, length, hash, or
// decoded token payload can leave this projection. These are format hints only,
// not proof that an opaque or legacy-looking key is genuine or invalid.
export function safeSearchCredentialCheck({ zhipuKey = '', serpapiKey = '' } = {}) {
  const key = typeof zhipuKey === 'string' ? zhipuKey : '';
  let format = 'opaque';
  if (!key) format = 'missing';
  else if (/\s/.test(key)) format = 'contains_whitespace';
  else if (/^["'“‘]|["'”’]$/.test(key)) format = 'wrapped_in_quotes';
  else if (/^https?:\/\//i.test(key)) format = 'url_instead_of_key';
  else if (/[＊*…]/.test(key) || key.includes('...')) format = 'possibly_masked';
  else if (/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(key)) format = 'id_secret_pair';
  else if (/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(key)) format = 'jwt_like';
  return { format, same_as_serpapi_key: Boolean(key && key === serpapiKey) };
}
