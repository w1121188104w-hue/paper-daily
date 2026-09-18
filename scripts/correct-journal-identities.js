import { pathToFileURL } from 'node:url';
import { loadJournalConfig } from '../src/services/journals.js';
import { DEFAULT_LIBRARY_ROOT, readJournalLibrary, withLibraryLock } from '../src/services/journalLibrary.js';
import { journalIdentityCorrection } from '../src/services/journalIdentityCorrection.js';
import { removeApprovedWrongJournalPapers } from '../src/services/journalIdentityCorrectionRun.js';
import { makeTranslationPublisher } from '../src/services/translationAutomationGit.js';

export async function runIdentityCorrectionCommand(args, { env = process.env, root = DEFAULT_LIBRARY_ROOT,
  log = console.log, publisher = makeTranslationPublisher } = {}) {
  if (args.length > 1 || (args.length && args[0] !== '--save')) throw new Error('参数无效');
  const save = args[0] === '--save', config = await loadJournalConfig();
  if (save && (env.GITHUB_ACTIONS !== 'true' || !env.DATA_BRANCH || env.GITHUB_REF !== `refs/heads/${env.DATA_BRANCH}`))
    throw new Error('保存仅允许在默认分支后台执行');
  const previous = await readJournalLibrary({ root, config }), plan = journalIdentityCorrection(previous);
  if (!save || !plan.removed.length) {
    log(JSON.stringify({ dry_run: !save, removed: save ? 0 : undefined, planned_dois: plan.removed.map(p => p.doi) })); return;
  }
  const after = await withLibraryLock(root, async () => removeApprovedWrongJournalPapers(config,
    { root, previous: await readJournalLibrary({ root, config }) }));
  await publisher(config, { root, branch: env.DATA_BRANCH, env })({ phase: 'settle' });
  log(JSON.stringify({ removed: previous.papers.length - after.papers.length, backup: previous.pointer.manifest,
    paid_requests: 0, remaining: after.papers.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runIdentityCorrectionCommand(process.argv.slice(2)); }
  catch { console.error('错刊修正未完成；未输出密钥或错误正文，请检查任务记录。'); process.exitCode = 1; }
}
