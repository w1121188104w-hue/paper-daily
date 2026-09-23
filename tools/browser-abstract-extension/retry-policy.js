// Persistent per-evidence budget. Reloading/clicking continue cannot reset it.
export const MAX_REVIEW_ATTEMPTS = 3;
export function reviewErrorPolicy(code) {
  const global = /^(?:PROVIDER_HTTP_(?:400|401|402|403|404|429)|SESSION_LIMIT|LOCAL_VALIDATION_OR_STORAGE_ERROR|CACHE_UNREADABLE|BUSY|ORIGIN_DENIED)$/.test(code || '');
  const retryable = /^(?:PROVIDER_(?:TIMEOUT|NETWORK_ERROR|INVALID_JSON|INVALID_ENVELOPE|INCOMPLETE_RESPONSE|INVALID_REVIEW_SHAPE|FAILED_OR_INVALID_RESPONSE|ABSTRACT_NOT_EXTRACTED)|PROVIDER_HTTP_5\d\d)$/.test(code || '');
  return {global_failure:global,retryable};
}
export function canRetryReview(result) {
  return !!result?.error && reviewErrorPolicy(result.error).retryable &&
    Number(result.attempt || 1) < MAX_REVIEW_ATTEMPTS;
}
