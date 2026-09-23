import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadJournalConfig } from '../src/services/journals.js';
import { readBrowserExport, prepareBrowserImport, importBrowserExport } from '../src/services/browserImport.js';
import { readJournalLibrary, withLibraryLock, writeLibraryJson } from '../src/services/journalLibrary.js';
import { assertLibrary } from '../src/services/libraryValidation.js';
import { runTranslationAutomation, readTranslationState, TRANSLATION_STATE_PATH } from '../src/services/translationAutomation.js';
import { buildJournalSite } from '../src/services/journalSiteBuild.js';
import { makeTranslationPublisher } from '../src/services/translationAutomationGit.js';

export async function initializeLocalLedger(root, config) {
  return withLibraryLock(root, async () => {
    try { await readTranslationState(root); return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const library = await readJournalLibrary({ root, config });
    assertLibrary(!library.imports.length && !library.papers.some(p => p.title_zh || p.abstract_zh), '旧库缺失翻译账本，不能重建空账本');
    for (const folder of ['translations', 'automation']) {
      let entries = []; try { entries = await fs.readdir(path.join(root, folder)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      assertLibrary(entries.length === 0, '存在历史翻译记录，不能重建空账本');
    }
    await writeLibraryJson(root, TRANSLATION_STATE_PATH, { schema_version: 2, paused: null, reservations: [] });
  });
}
export async function runBrowserImportCommand(args, { log = console.log, env = process.env, fetchImpl = fetch } = {}) {
  const { values: v } = parseArgs({ args, options: {
    file: { type: 'string', multiple: true }, library: { type: 'string' }, save: { type: 'boolean' },
    build: { type: 'string' }, translate: { type: 'boolean' }, 'init-translation-ledger': { type: 'boolean' },
    'max-requests': { type: 'string', default: '10' }, 'remote-checkpoints': { type: 'boolean' }, help: { type: 'boolean' }
  } });
  if (v.help) { log('node scripts/browser-import.js --file <插件JSON> --library <本地库> [--save] [--build <网页输出目录>] [--translate --max-requests 10] [--init-translation-ledger]\n默认仅预检；不会部署网站，不调用搜索。新库首次翻译需明确初始化账本；已有账本永不覆盖。'); return; }
  assertLibrary(v.library && v.file?.length, '请指定 --file 和 --library');
  assertLibrary(Number.isInteger(Number(v['max-requests'])) && Number(v['max-requests']) > 0 && Number(v['max-requests']) <= 1000, '翻译请求上限应为1–1000');
  assertLibrary(v.save || !v.translate && !v.build && !v['init-translation-ledger'], '翻译、建站和初始化需同时指定 --save');
  assertLibrary(!v['remote-checkpoints'] || v.save && v.translate, '远端翻译预登记必须明确启用保存和翻译');
  const config = await loadJournalConfig(), root = path.resolve(v.library), reports = [];
  // Validate all files before the first commit. Each file is an atomic import;
  // interruption between files is safe to resume using the same command.
  const prepared = [];
  for (const file of v.file) { const input = await readBrowserExport(file); prepared.push(await prepareBrowserImport(input.data, config, input.sha256)); }
  for (const input of prepared) {
    const r = await importBrowserExport(config, { root, prepared: input, save: !!v.save });
    const report = { input_sha256: r.input_sha256, committed: r.committed, stats: r.stats, decisions: r.decisions,
      paper_count: r.papers.length, paid_requests: 0, scope: r.scope };
    reports.push(report); log(JSON.stringify({ stage: 'import', ...report }, null, 2));
  }
  let translation = null, site = null;
  if (v['init-translation-ledger']) await initializeLocalLedger(root, config);
  if (v.translate) {
    // Local-only durability: never pretend a local checkpoint has been pushed.
    // A separate lock spans the entire paid run, including network waits.
    const lockRoot = path.join(root, 'local-translation-session');
    const paperIds = [...new Set(reports.flatMap(r => r.decisions.filter(d => ['added','abstract_filled','unchanged'].includes(d.action)).map(d => `doi:${d.doi}`)))];
    const checkpoint = v['remote-checkpoints'] ? makeTranslationPublisher(config, {root, repositoryRoot:path.resolve(root,'../..'), branch:'master', env}) :
      async () => { await readTranslationState(root); await readJournalLibrary({ root, config }); };
    translation = await withLibraryLock(lockRoot, () => runTranslationAutomation(config, { root, apiKey: env.DEEPSEEK_API_KEY,
      maxRequests: Number(v['max-requests']), paperIds, fetchImpl,
      publishCheckpoint: checkpoint,
      log: row => log(JSON.stringify({ stage: 'translation_progress', ...row })) }));
    log(JSON.stringify({ stage: 'translation', ...translation }, null, 2));
  }
  if (v.build) {
    site = await buildJournalSite(config, { root, outputRoot: path.resolve(v.build) });
    log(JSON.stringify({ stage: 'site', directory: site.directory, paper_count: site.paper_count, deployed: false }, null, 2));
  }
  return { reports, translation, site, deployed: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runBrowserImportCommand(process.argv.slice(2)).catch(error => {
  // Never echo an HTTP response, environment or credential in diagnostics.
  console.error(`本地导入流程未完成；已提交步骤保留，可原命令继续。错误类型：${/^[A-Z_]+$/.test(error.code || '') ? error.code : 'VALIDATION_OR_IO_ERROR'}`);
  process.exitCode = 1;
});
