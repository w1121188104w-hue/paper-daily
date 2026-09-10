import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadJournalConfig } from '../src/services/journals.js';
import { DEFAULT_LIBRARY_ROOT, readJournalLibrary } from '../src/services/journalLibrary.js';
import { readTranslationState, automationSummary, runTranslationAutomation } from '../src/services/translationAutomation.js';
import { makeTranslationPublisher } from '../src/services/translationAutomationGit.js';

export async function runAutomaticTranslationCommand(args, { env = process.env, root = DEFAULT_LIBRARY_ROOT,
  log = console.log, execute = runTranslationAutomation, publisher = makeTranslationPublisher } = {}) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, status: { type: 'boolean' }, run: { type: 'boolean' }, mode: { type: 'string' }, 'github-output': { type: 'boolean' }
  } });
  if (!Object.keys(values).length || values.help) {
    log('node scripts/translate-library.js --status（只读，不联网）\n--run --mode daily|backfill --github-output 仅在已启用的GitHub后台执行。自动采用合格机器译文，不逐篇校对；先远端登记再调用，不重试相同原文。'); return 0;
  }
  if (Number(Boolean(values.status)) + Number(Boolean(values.run)) !== 1 || (values.status && Object.keys(values).length !== 1)) throw new Error('参数组合无效');
  const config = await loadJournalConfig();
  if (values.status) { log(JSON.stringify(automationSummary(await readJournalLibrary({ root, config }), await readTranslationState(root)), null, 2)); return 0; }
  if (!['daily', 'backfill'].includes(values.mode) || env.GITHUB_ACTIONS !== 'true' || env.JOURNAL_TRANSLATION_ENABLED !== 'true' ||
    env.GITHUB_REF !== `refs/heads/${env.DATA_BRANCH}` || !values['github-output'] || !env.GITHUB_OUTPUT || !path.isAbsolute(env.GITHUB_OUTPUT))
    throw new Error('自动翻译仅能在已启用的默认分支后台运行');
  const result = await execute(config, { root, mode: values.mode, apiKey: env.DEEPSEEK_API_KEY,
    publishCheckpoint: publisher(config, { root, branch: env.DATA_BRANCH, env }),
    log: (progress) => log(JSON.stringify(progress)) });
  // This summary contains only verified counts and fixed codes, never model bodies or credentials.
  log(JSON.stringify(result, null, 2));
  const attention = Boolean(result.paused || result.held_fields || result.reserved_requests);
  await fs.appendFile(env.GITHUB_OUTPUT, `attention=${attention}\nrequested=${result.requested_this_run}\n`, 'utf8');
  if (env.GITHUB_STEP_SUMMARY && path.isAbsolute(env.GITHUB_STEP_SUMMARY)) await fs.appendFile(env.GITHUB_STEP_SUMMARY,
    `## 自动翻译结果\n\n本轮请求：${result.requested_this_run}篇；尚未请求：${result.available_papers}篇；暂缓字段：${result.held_fields}。\n\n累计已知用量估算：${result.estimated_cny_known_usage.toFixed(4)}元（非账单）；无逐篇校对、无自动重试。\n\n停止原因：${result.stop_reason}。\n`, 'utf8');
  // Transport/account warnings were durably saved. A separate workflow job reports attention after Pages.
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runAutomaticTranslationCommand(process.argv.slice(2)); }
  catch { console.error('自动翻译未完成；未输出密钥、译文草稿或错误堆栈。请核查状态记录和保存步骤，不要盲目重跑。'); process.exitCode = 1; }
}
