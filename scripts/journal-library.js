import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadJournalConfig } from '../src/services/journals.js';
import { DEFAULT_LIBRARY_ROOT, readJournalLibrary } from '../src/services/journalLibrary.js';
import { runJournalCollection, collectionWindow, safeRunError } from '../src/services/journalRun.js';

const HELP = `经管期刊第三阶段：本地永久库（不启动网站、不调用AI）

只读查看并校验已有库：
  node scripts/journal-library.js --status
  node scripts/journal-library.js --validate

明确联网并保存单刊（默认回查含今天的最近60天）：
  node scripts/journal-library.js --collect --save --journal AER

可选：--all 替代 --journal；--lookback-days 60；--max-pages 1000；--only-if-needed
也可使用 --from YYYY-MM-DD --to YYYY-MM-DD 指定范围，与 --lookback-days 互斥。
--only-if-needed：今天所选期刊和范围已经双源成功时跳过；默认手动重跑不跳过。
正式库位于 data/journal-store，仅本地保存。需备份整个目录，不能只复制最新版本子目录。
本命令不设置定时运行、不提交Git、不部署。仅想试抓不保存，请用 scripts/journals.js。`;

export function parseLibraryArgs(args) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, status: { type: 'boolean' }, validate: { type: 'boolean' },
    collect: { type: 'boolean' }, save: { type: 'boolean' }, all: { type: 'boolean' },
    journal: { type: 'string' }, 'lookback-days': { type: 'string' }, 'max-pages': { type: 'string' },
    'only-if-needed': { type: 'boolean' }, from: { type: 'string' }, to: { type: 'string' }
  } });
  if (values.help || !Object.keys(values).length) return { mode: 'help' };
  if (Number(Boolean(values.status)) + Number(Boolean(values.validate)) + Number(Boolean(values.collect)) !== 1) {
    throw new Error('请选择 --status、--validate 或 --collect 中的一种模式');
  }
  if (!values.collect) {
    if (Object.keys(values).some((key) => !['status', 'validate'].includes(key))) throw new Error('只读模式不能带采集或保存参数');
    return { mode: values.status ? 'status' : 'validate' };
  }
  if (!values.save) throw new Error('正式保存需要明确加 --save；仅试抓请使用 scripts/journals.js');
  if (Boolean(values.all) === Boolean(values.journal?.trim())) throw new Error('请指定 --journal 一本期刊，或 --all 全部19刊');
  if ((values.from || values.to) && values['lookback-days'] !== undefined) throw new Error('日期范围不能与回查天数同时指定');
  const lookbackDays = Number(values['lookback-days'] ?? 60), maxPages = Number(values['max-pages'] ?? 1000);
  collectionWindow({ lookbackDays, fromDate: values.from, toDate: values.to });
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error('页数上限应为1–1000');
  return { mode: 'collect', journalKey: values.journal, fromDate: values.from, toDate: values.to,
    lookbackDays, maxPages, onlyIfNeeded: Boolean(values['only-if-needed']) };
}

export async function runLibraryCommand(args, { log = console.log, read = readJournalLibrary, run = runJournalCollection } = {}) {
  const { mode, ...options } = parseLibraryArgs(args);
  if (mode === 'help') { log(HELP); return 0; }
  const config = await loadJournalConfig();
  if (mode !== 'collect') {
    const library = await read({ root: DEFAULT_LIBRARY_ROOT, config });
    const latest = [...library.runs].sort((a, b) => a.started_at.localeCompare(b.started_at)).at(-1);
    log(JSON.stringify({ mode, root: DEFAULT_LIBRARY_ROOT, initialized: Boolean(library.pointer),
      validated: true, paper_count: library.papers.length, run_count: library.runs.length,
      translation_import_count: library.imports?.length || 0,
      pending_translation_fields: library.queue?.field_count || 0,
      latest_committed_run: latest || null }, null, 2));
    log('只读校验结束，没有联网或写文件。此处显示最近正式提交的日志；提交前中断的诊断位于 attempts 目录。');
    return 0;
  }
  log(`将联网采集并保存到 ${DEFAULT_LIBRARY_ROOT}。不会读取密钥、调用AI或启动旧网站。`);
  const result = await run(config, { ...options, onProgress: (source) => log(
    `${source.journal_key} / ${source.source}：${source.ok ? '完整成功' : '失败或不完整'}，原始${source.raw_count}条，排除资料${source.excluded_count}条`) });
  log(JSON.stringify({ status: result.status, committed: result.committed, run_id: result.run_id,
    reason: result.reason, paper_count: result.papers?.length ?? result.paper_count,
    run: result.run }, null, 2));
  return ['success', 'no_updates', 'skipped'].includes(result.status) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runLibraryCommand(process.argv.slice(2)); }
  catch (error) {
    // Usage errors are local and safe; operational errors use a fixed-message allowlist.
    console.error(error.code ? `${error.code}：${safeRunError(error).message}` : error.message);
    process.exitCode = 1;
  }
}
