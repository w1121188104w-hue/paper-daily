import { pathToFileURL } from 'node:url';
import { loadJournalConfig } from '../src/services/journals.js';
import { journalGitFiles, stageJournalFiles } from '../src/services/journalGitFiles.js';

export async function runJournalGitCommand(args, { plan = journalGitFiles, stage = stageJournalFiles, log = console.log } = {}) {
  if (args.length !== 1 || !['--check', '--stage'].includes(args[0])) {
    log('node scripts/journal-git-files.js --check（只读校验文件清单）\n--stage 会修改Git暂存区，仅供明确准备数据提交时使用；不会commit或push。');
    return args.length ? 1 : 0;
  }
  const config = await loadJournalConfig();
  if (args[0] === '--check') {
    const result = await plan(config); log(JSON.stringify({ file_count: result.files.length, versions: result.versions, staged: false }, null, 2));
  } else log(JSON.stringify({ ...await stage(config), staged: true, committed: false, pushed: false }, null, 2));
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runJournalGitCommand(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
    console.error('论文库Git文件清单检查失败；请检查完整历史和暂存区。未执行commit或push。'); process.exitCode = 1;
  });
}
