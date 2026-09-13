import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadJournalConfig } from '../src/services/journals.js';
import { readJournalLibrary, DEFAULT_LIBRARY_ROOT } from '../src/services/journalLibrary.js';
import { dueRepairIssues, repairSummary } from '../src/services/repairState.js';

const HELP = `论文总名册（只读，不联网、不读密钥、不修改正式数据）
  node scripts/master-list.js --status
  node scripts/master-list.js --list
  node scripts/master-list.js --unresolved
  node scripts/master-list.js --unresolved --due
可选：--journal AER；--root 指向离线测试库。输出JSON，可供以后Codex集中读取。`;

export function parseMasterArgs(args) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, status: { type: 'boolean' }, list: { type: 'boolean' }, unresolved: { type: 'boolean' },
    due: { type: 'boolean' }, journal: { type: 'string' }, root: { type: 'string' }
  } });
  if (values.help || !Object.keys(values).length) return { mode: 'help' };
  if (['status', 'list', 'unresolved'].filter(key => values[key]).length !== 1 || (values.due && !values.unresolved)) throw new Error('请选择一种只读模式，--due只能用于待办清单');
  return { ...values, mode: values.list ? 'list' : values.unresolved ? 'unresolved' : 'status' };
}

export async function runMasterCommand(args, { log = console.log, read = readJournalLibrary, now = () => new Date() } = {}) {
  const options = parseMasterArgs(args);
  if (options.mode === 'help') { log(HELP); return 0; }
  const config = await loadJournalConfig();
  const journal = options.journal?.toUpperCase();
  if (journal && !config.journals.some(row => row.key === journal)) throw new Error('期刊缩写无效');
  const library = await read({ root: options.root || DEFAULT_LIBRARY_ROOT, config });
  const match = row => !journal || (row.journal || row.journal_key) === journal;
  if (options.mode === 'list') log(JSON.stringify({ ...library.masterList, entries: (library.masterList?.entries || []).filter(match) }, null, 2));
  else if (options.mode === 'unresolved') {
    const issues = (options.due ? dueRepairIssues(library.repairState, now(), { limit: 10000 }) :
      Object.values(library.repairState.issues).filter(issue => issue.status !== 'resolved')).filter(match);
    const papers = new Map((library.masterList?.entries || []).map(row => [row.id, row]));
    log(JSON.stringify({ schema_version: 1, automatic_queue: true, manual_review_required: false,
      issue_count: issues.length, paper_count: new Set(issues.map(issue => issue.paper_id)).size,
      issues: issues.map(issue => ({ ...issue, title: papers.get(issue.paper_id)?.title, doi: papers.get(issue.paper_id)?.doi })) }, null, 2));
  } else log(JSON.stringify({ initialized: Boolean(library.pointer), persisted: Boolean(library.manifest?.master_list),
    generated_at: library.masterList?.generated_at || null, coverage: library.masterList?.coverage || 'not_proven_complete',
    statistics: journal ? library.masterList?.journals.find(row => row.journal === journal) || null : library.masterList?.statistics || null,
    unresolved: repairSummary({ schema_version: 1, issues: Object.fromEntries(Object.entries(library.repairState.issues).filter(([, row]) => match(row))) }) }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runMasterCommand(process.argv.slice(2)); }
  catch { console.error('总名册读取失败：请检查参数、期刊缩写或正式库完整性；未输出原始错误正文。'); process.exitCode = 1; }
}
