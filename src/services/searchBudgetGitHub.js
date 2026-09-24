import { assertLibrary } from './libraryValidation.js';
import { emptySearchBudget, validateSearchBudget } from './searchBudget.js';

export const SEARCH_LEDGER_BRANCH = 'codex/search-ledger';
export const SEARCH_LEDGER_PATH = 'data/search-budget.json';
const repository = 'w1121188104w-hue/paper-daily';

// Separate ledger branch: reservation commits cannot make the production data push stale.
// Contents SHA is a compare-and-swap: competing/stale writers fail before billing.
// No retries for uncertain writes, no forced ref updates, no secret/error-body logging.
export function makeSearchBudgetGitHub({ token, repositoryName, fetchImpl = fetch, timeoutMs = 20000, scope='production' }) {
  assertLibrary(repositoryName === repository && typeof token === 'string' && token.length >= 8, '搜索记账仓库或认证无效');
  assertLibrary(['production','discovery-test-20260924'].includes(scope),'Unknown budget scope');
  const ledgerBranch=scope==='production'?SEARCH_LEDGER_BRANCH:'codex/discovery-test-20260924';
  const ledgerPath=scope==='production'?SEARCH_LEDGER_PATH:'data/discovery-test-budget-20260924.json';
  let fileSha = null, initialized = false;
  async function api(endpoint, method = 'GET', body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repository}${endpoint ? `/${endpoint}` : ''}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: method === 'GET' && endpoint.startsWith('contents/')
          ? 'application/vnd.github.object+json' : 'application/vnd.github+json',
          'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (response.status === 404 && method === 'GET') { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new Error('SEARCH_LEDGER_CHECKPOINT_FAILED'); }
      const reader = response.body?.getReader(); assertLibrary(reader, '搜索记账响应为空');
      const chunks = []; let size = 0;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break;
        size += value.length; assertLibrary(size <= 8000000, '搜索记账响应过大'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { const error = new Error('SEARCH_LEDGER_CHECKPOINT_FAILED'); error.code = 'SEARCH_LEDGER_CHECKPOINT_FAILED'; throw error; }
    finally { clearTimeout(timer); }
  }
  const contentEndpoint = `contents/${ledgerPath}`;
  return {
    async read({ initialize = false } = {}) {
      let branch = await api(`git/ref/heads/${ledgerBranch}`);
      let createdHere = false;
      if (!branch && initialize) {
        const repo = await api('');
        assertLibrary(repo?.default_branch === 'master', '默认分支变更，停止建立搜索账本');
        const base = await api('git/ref/heads/master');
        assertLibrary(/^[a-f0-9]{40}$/.test(base?.object?.sha), '搜索账本起始版本无效');
        branch = await api('git/refs', 'POST', { ref: `refs/heads/${ledgerBranch}`, sha: base.object.sha });
        createdHere = true;
      }
      assertLibrary(branch, '搜索账本分支不存在');
      const file = await api(`${contentEndpoint}?ref=${encodeURIComponent(ledgerBranch)}`);
      if (!file) { assertLibrary(createdHere, '搜索账本缺失，不能当作零用量'); fileSha = null; initialized = true; return emptySearchBudget(); }
      assertLibrary(/^[a-f0-9]{40}$/.test(file.sha), '搜索账本内容无效');
      let blob = file;
      // Contents omits base64 above 1 MB. Read the SAME immutable blob SHA,
      // never a download_url supplied by a response and never an empty ledger.
      if (file.encoding === 'none' && file.content === '') {
        assertLibrary(Number.isSafeInteger(file.size) && file.size > 1000000 && file.size <= 5000000,
          '搜索账本大小超出已支持范围');
        blob = await api(`git/blobs/${file.sha}`);
        assertLibrary(blob?.sha === file.sha && blob.size === file.size, '搜索账本大文件版本不一致');
      }
      assertLibrary(blob.encoding === 'base64' && typeof blob.content === 'string' && blob.content,
        '搜索账本内容无效');
      const bytes = Buffer.from(blob.content, 'base64');
      assertLibrary(blob.size === undefined || bytes.length === blob.size, '搜索账本内容长度不一致');
      const state = validateSearchBudget(JSON.parse(bytes.toString('utf8')));
      fileSha = file.sha; initialized = true; return state;
    },
    async persist(state) {
      assertLibrary(initialized, '必须先读取搜索账本'); validateSearchBudget(state);
      const result = await api(contentEndpoint, 'PUT', { branch: ledgerBranch,
        message: 'data: checkpoint search usage without credentials',
        content: Buffer.from(`${JSON.stringify(state)}\n`, 'utf8').toString('base64'), ...(fileSha ? { sha: fileSha } : {}) });
      assertLibrary(/^[a-f0-9]{40}$/.test(result?.content?.sha), '搜索记账写入未确认'); fileSha = result.content.sha;
    }
  };
}
