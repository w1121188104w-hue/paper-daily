import fs from 'node:fs/promises';
import { assertLibrary } from './libraryValidation.js';

export const SEARCH_POLICY_URL = new URL('../../config/search-policy.json', import.meta.url);
export function validateSearchPolicy(policy) {
  const approvedBudget = policy?.approved_on === '2026-09-17' && policy.zhipu_monthly_limit === null ||
    policy?.approved_on === '2026-09-13' && Number.isInteger(policy.zhipu_monthly_limit) &&
      policy.zhipu_monthly_limit >= 0 && policy.zhipu_monthly_limit <= 2000;
  assertLibrary(policy?.schema_version === 1 && approvedBudget &&
    policy.zhipu_engine === 'search_pro' &&
    policy.serpapi_monthly_limit === 250 && policy.lookback_days === 60 &&
    policy.automatic_payment === false && typeof policy.production_enabled === 'boolean', '搜索配置超出已授权范围');
  return policy;
}
export async function loadSearchPolicy(url = SEARCH_POLICY_URL) {
  return validateSearchPolicy(JSON.parse(await fs.readFile(url, 'utf8')));
}
