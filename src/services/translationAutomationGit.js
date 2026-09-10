import { spawn } from 'node:child_process';
import { journalGitFiles, stageJournalFiles, DEFAULT_REPOSITORY_ROOT } from './journalGitFiles.js';
import { DEFAULT_LIBRARY_ROOT } from './journalLibrary.js';
import { assertLibrary } from './libraryValidation.js';
import { TRANSLATION_STATE_PATH, readTranslationState } from './translationAutomation.js';

export const STATE_GIT_PATH = `data/journal-store/${TRANSLATION_STATE_PATH}`;
export function makeTranslationPublisher(config, { root = DEFAULT_LIBRARY_ROOT, repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  branch, env = process.env, gitImpl } = {}) {
  assertLibrary(typeof branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/.test(branch) && !branch.includes('..'), '发布分支格式无效');
  const childEnv = { ...env }; delete childEnv.DEEPSEEK_API_KEY;
  const git = gitImpl || ((args, { input = '' } = {}) => new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repositoryRoot, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
    const fail = () => { clearTimeout(timer); reject(new Error('自动翻译保存或上传失败；未输出Git错误正文或凭据。')); };
    child.stdout.on('data', (chunk) => { size += chunk.length; if (size > 1024 * 1024) { timedOut = true; child.kill(); } else chunks.push(chunk); });
    child.stderr.resume(); child.on('error', fail); child.stdin.on('error', () => {});
    child.on('close', (code) => { clearTimeout(timer); if (code || timedOut) fail(); else resolve(Buffer.concat(chunks).toString('utf8')); });
    child.stdin.end(input);
  }));
  return async ({ phase }) => {
    assertLibrary(['reserve', 'settle'].includes(phase), '未知保存阶段');
    await readTranslationState(root);
    const plan = await journalGitFiles(config, { root, repositoryRoot });
    const allowed = new Set([...plan.files, STATE_GIT_PATH]);
    const dirty = (await git(['diff', '--name-only', '-z', 'HEAD'])).split('\0').filter(Boolean);
    assertLibrary(dirty.every((file) => allowed.has(file)), '存在非正式数据改动，停止自动上传');
    await stageJournalFiles(config, { root, repositoryRoot, runGit: (args, options) => git(args, options) });
    await git(['add', '-f', '--', STATE_GIT_PATH]);
    const staged = (await git(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
    assertLibrary(staged.length > 0 && staged.every((file) => allowed.has(file)), '暂存区含未授权文件或为空');
    await git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '-m', phase === 'reserve' ? 'data: reserve translation requests before billing' : 'data: save automatic DeepSeek translations and usage']);
    await git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  };
}
