// Only fixed local codes, HTTP status numbers, and documented Zhipu business codes
// may leave the request boundary. Never return remote messages, URLs, or raw bodies.
const localCodes = new Set(['RATE_LIMITED', 'ACCESS_RESTRICTED', 'SEARCH_HTTP_ERROR',
  'SEARCH_PROVIDER_ERROR', 'INVALID_SEARCH_RESPONSE', 'SEARCH_RESPONSE_TOO_LARGE',
  'TIMEOUT', 'SEARCH_NETWORK_ERROR', 'MISSING_ZHIPU_KEY', 'MISSING_SERPAPI_KEY',
  'INVALID_SEARCH_QUERY', 'SEARCH_QUERY_TOO_LONG', 'INVALID_SEARCH_PROVIDER']);
// https://docs.bigmodel.cn/cn/api/api-code — unknown future codes stay redacted.
const zhipuCodes = new Set(['1000', '1001', '1003', '1005', '1113', '1200', '1210',
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
