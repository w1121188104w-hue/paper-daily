import { pathToFileURL } from 'node:url';
import { loadJournalConfig } from '../src/services/journals.js';
import { loadJournalPresentation } from '../src/services/journalPresentation.js';
import { createJournalPreviewServer } from '../src/journalPreviewServer.js';

export async function runPreviewCommand(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--check') {
    const data = await loadJournalPresentation(await loadJournalConfig());
    console.log(JSON.stringify({ initialized: data.initialized, papers: data.papers.length,
      journals: data.journals.length, runs: data.runs.length, attempt_warning: data.attempt_warning,
      classification: data.classification_summary, translation_eligibility: data.translation_eligibility }, null, 2));
    return;
  }
  if (args.length && !(args.length === 2 && args[0] === '--port' && /^\d{4,5}$/.test(args[1]) &&
      Number(args[1]) >= 1024 && Number(args[1]) <= 65535)) throw new Error('参数无效');
  const port = args.length ? Number(args[1]) : 4317;
  const server = createJournalPreviewServer({ config: await loadJournalConfig() });
  server.on('error', () => { console.error('本地预览未能启动；请检查端口是否被占用，或使用 --port 指定其他端口。'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`期刊只读预览：http://127.0.0.1:${port}/\n不会采集、翻译、写库或部署；按 Ctrl+C 关闭。`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPreviewCommand().catch(() => {
    console.error('预览检查失败。请检查论文库和参数；用法：node scripts/journal-preview.js [--check | --port 4317]');
    process.exitCode = 1;
  });
}
