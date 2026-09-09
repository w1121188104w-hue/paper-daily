import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadJournalConfig } from '../src/services/journals.js';
import { buildJournalSite } from '../src/services/journalSiteBuild.js';

export async function runSiteBuildCommand(args, { build = buildJournalSite, log = console.log, env = process.env } = {}) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    'allow-empty': { type: 'boolean' }, 'github-output': { type: 'boolean' }, help: { type: 'boolean' }
  } });
  if (values.help) { log('node scripts/build-journal-site.js [--allow-empty] [--github-output]\n只构建本地静态文件，不提交、不上传、不部署；默认拒绝尚未初始化的空库。'); return; }
  if (values['github-output'] && (env.GITHUB_ACTIONS !== 'true' || !env.GITHUB_OUTPUT || !path.isAbsolute(env.GITHUB_OUTPUT))) {
    throw new Error('GitHub 输出参数只能在 Actions 环境使用');
  }
  const result = await build(await loadJournalConfig(), { allowEmpty: Boolean(values['allow-empty']) });
  log(JSON.stringify({ directory: result.directory, paper_count: result.paper_count, initialized: result.initialized,
    built_at: result.built_at, deployed: false }, null, 2));
  if (values['github-output']) {
    if (/[\r\n]/.test(result.directory)) throw new Error('输出路径无效');
    await fs.appendFile(env.GITHUB_OUTPUT, `directory=${result.directory}\n`, 'utf8');
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSiteBuildCommand(process.argv.slice(2)).catch(() => {
    console.error('静态网页构建失败，未替换旧构建。请检查论文库；仅预览空库时需明确使用 --allow-empty。');
    process.exitCode = 1;
  });
}
