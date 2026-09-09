import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadJournalConfig, findJournal } from '../src/services/journals.js';
import { readJournalLibrary, DEFAULT_LIBRARY_ROOT } from '../src/services/journalLibrary.js';
import { exportTranslationBatch, importTranslationFile } from '../src/services/translationWorkflow.js';
import { translationEligibility } from '../src/services/translationQueue.js';

const HELP = `第四阶段：待翻译清单与中文导入（不联网、不调用AI、不启动网站）

只读查看队列：
  node scripts/translations.js --queue

导出最多10篇研究论文候选的原文清单及空结果模板（写工作文件，不改论文）：
  node scripts/translations.js --export --limit 10
  可加 --journal AER 限定期刊。期刊资料、更正/撤稿通知和待核查记录暂不导出。

译完后先预检，不改库：
  node scripts/translations.js --import "结果文件的完整路径"

用户确认后才保存合格结果：
  node scripts/translations.js --import "结果文件的完整路径" --save

正文检查只是机械校验，不代表翻译准确。原文中的指令一律视为待翻译内容。
未初始化论文库或无待翻译字段时，查看/导出不会创建空库。`;

export function parseTranslationArgs(args) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, queue: { type: 'boolean' }, export: { type: 'boolean' },
    import: { type: 'string' }, save: { type: 'boolean' }, limit: { type: 'string' }, journal: { type: 'string' }
  } });
  if (!Object.keys(values).length || values.help) return { mode: 'help' };
  if ([values.queue, values.export, values.import !== undefined].filter(Boolean).length !== 1) throw new Error('请选择查看队列、导出或导入中的一种操作');
  if (values.queue) {
    if (Object.keys(values).length !== 1) throw new Error('队列查看不能附带写入或筛选参数');
    return { mode: 'queue' };
  }
  if (values.export) {
    if (values.save) throw new Error('导出不能使用 --save，--save 只用于导入');
    const limit = Number(values.limit ?? 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('每批论文数量应为1–100');
    return { mode: 'export', limit, journalKey: values.journal?.trim().toUpperCase() };
  }
  if (values.limit !== undefined || values.journal !== undefined || !values.import?.trim()) throw new Error('导入需要结果文件路径，不能带导出筛选参数');
  return { mode: 'import', file: values.import, save: Boolean(values.save) };
}

export async function runTranslationCommand(args, { log = console.log, read = readJournalLibrary,
  exportBatch = exportTranslationBatch, importFile = importTranslationFile } = {}) {
  const { mode, ...options } = parseTranslationArgs(args);
  if (mode === 'help') { log(HELP); return 0; }
  const config = await loadJournalConfig();
  if (mode === 'queue') {
    const library = await read({ root: DEFAULT_LIBRARY_ROOT, config });
    const { ready, held } = translationEligibility(library.papers);
    log(JSON.stringify({ initialized: Boolean(library.pointer), queue: library.queue,
      export_eligibility: { ready: { paper_count: ready.paper_count, field_count: ready.field_count },
        held: { paper_count: held.paper_count, field_count: held.field_count } } }, null, 2));
    log('只读完成，没有联网或创建文件。'); return 0;
  }
  if (mode === 'export') {
    if (options.journalKey && !findJournal(config, options.journalKey)) throw new Error('没有匹配到指定期刊');
    const output = await exportBatch(config, options);
    log(output.empty ? '没有符合研究论文候选范围的待翻译字段；未创建空清单或论文库。' : JSON.stringify({ batch_id: output.batch.batch_id,
      paper_count: output.batch.items.length, reused: output.reused, request_path: output.request_path, response_path: output.response_path }, null, 2));
    return 0;
  }
  const applied = await importFile(config, options);
  log(JSON.stringify({ dry_run: applied.dry_run, committed: applied.committed, run_id: applied.run_id, report: applied.report }, null, 2));
  log(options.save ? applied.committed ? '已保存逐字段处理结果；未改英文或采集状态。' : '没有改变正式论文；请查看报告中的跳过或拒收原因。'
    : '这是预检，没有写库。人工检查译文和报告后，才可加 --save 导入。');
  return ['success', 'no_changes'].includes(applied.status) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runTranslationCommand(process.argv.slice(2)); }
  catch (error) {
    console.error(error.code ? `操作未完成（${error.code}）。请检查本地库、清单或结果格式；不要手动覆盖current.json。` : error.message);
    process.exitCode = 1;
  }
}
