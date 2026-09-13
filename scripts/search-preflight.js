import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSearchPolicy } from '../src/services/searchPolicy.js';
import { makeSearchSources, journalSearchQuery } from '../src/services/searchSources.js';
import { makeSearchBudgetGitHub } from '../src/services/searchBudgetGitHub.js';
import { makeBudgetedSearch, searchAllowance } from '../src/services/searchBudget.js';
import { assertLibrary } from '../src/services/libraryValidation.js';

// Explicit manual GitHub-only smoke test: no paper writes, no translations, no deployment.
export async function searchPreflight({ env = process.env, accountOnly = false, policyLoader = loadSearchPolicy,
  sourceFactory = makeSearchSources, ledgerFactory = makeSearchBudgetGitHub, log = console.log } = {}) {
  assertLibrary(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'w1121188104w-hue/paper-daily' &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch', '搜索密钥验证只能由明确的GitHub手动任务执行');
  const policy = await policyLoader();
  const sources = sourceFactory({ zhipuKey: env.ZHIPU_API_KEY || '', serpapiKey: env.SERPAPI_API_KEY || '', zhipuEngine: policy.zhipu_engine });
  if (accountOnly) {
    const report = { mode: 'account_only', ...await sources.accountDiagnostics(), search_calls: 0, papers_changed: 0, website_deployed: false };
    log(JSON.stringify(report, null, 2));
    return 0; // Diagnostics completed; verified_free_account independently states validation outcome.
  }
  // Read-only account request is free. Only the approved projection survives this boundary.
  const account = await sources.account();
  const ledger = ledgerFactory({ token: env.GITHUB_TOKEN, repositoryName: env.GITHUB_REPOSITORY });
  const initialState = await ledger.read({ initialize: true });
  const search = makeBudgetedSearch({ initialState, persist: state => ledger.persist(state), request: request => sources.request(request) });
  const query = journalSearchQuery({ name: 'American Economic Review' }, new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date()), 'zhipu');
  const result = await search.run({ provider: 'zhipu', query, taskId: 'search-preflight-official-catalog', zhipuMonthlyLimit: policy.zhipu_monthly_limit });
  const allowance = searchAllowance(search.state(), { provider: 'zhipu', zhipuMonthlyLimit: policy.zhipu_monthly_limit });
  const report = { status: result.result ? 'success' : 'incomplete', zhipu_engine: policy.zhipu_engine,
    zhipu_request_sent: result.called, zhipu_block_reason: result.reason ?? null,
    zhipu_diagnostic: result.diagnostic ?? null,
    zhipu_local_used: allowance.local_used, zhipu_monthly_limit: policy.zhipu_monthly_limit,
    zhipu_result_count: result.result?.leads.length ?? null,
    zhipu_official_link_count: result.result?.leads.filter(lead => ['www.aeaweb.org', 'pubs.aeaweb.org'].includes(new URL(lead.url).hostname)).length ?? null,
    serpapi_free_plan: account.free_plan, serpapi_account_used: account.used, serpapi_account_remaining: account.remaining,
    serpapi_renewal_date: account.renewal_date, papers_changed: 0, translation_calls: 0, website_deployed: false };
  log(JSON.stringify(report, null, 2));
  if (path.isAbsolute(env.GITHUB_STEP_SUMMARY || '')) await fs.appendFile(env.GITHUB_STEP_SUMMARY,
    `## 搜索接口验证（不发布网站）\n\n智谱：${report.status}，${policy.zhipu_engine}；返回 ${report.zhipu_result_count ?? '未知'} 条线索，其中 AER 官方域名 ${report.zhipu_official_link_count ?? '未知'} 条。线索数量不是论文数量，也不证明清单完整。\n\n智谱本月保守记账 ${allowance.local_used} / ${policy.zhipu_monthly_limit}。SerpAPI 已确认免费方案，账户本周期已用 ${account.used}，剩余 ${account.remaining}，重置日期 ${account.renewal_date}。本次没有调用 SerpAPI 搜索。\n\n论文写入 0，翻译调用 0，网站部署 0。密钥和账户个人信息不写入输出。\n`, 'utf8');
  if (report.zhipu_diagnostic && path.isAbsolute(env.GITHUB_STEP_SUMMARY || '')) await fs.appendFile(env.GITHUB_STEP_SUMMARY,
    `\n安全错误码（不包含远端错误正文）：\n\n\`\`\`json\n${JSON.stringify(report.zhipu_diagnostic, null, 2)}\n\`\`\`\n\n错误码不能证明实际扣费；结果不明时继续保留预占额度，且不自动重发。\n`, 'utf8');
  return report.status === 'success' ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const option = process.argv.slice(2).join(' '); assertLibrary(['--run', '--account-only'].includes(option), '必须显式指定验证模式');
    process.exitCode = await searchPreflight({ accountOnly: option === '--account-only' }); }
  catch (error) { console.error(`SEARCH_PREFLIGHT_FAILED：${/^[A-Z_]{3,50}$/.test(error.code || '') ? error.code : 'CHECK_FAILED'}；没有输出密钥、账户信息或远端错误正文。`); process.exitCode = 1; }
}
