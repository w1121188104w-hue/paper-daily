import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DEFAULT_LIBRARY_ROOT, libraryPath, readJournalLibrary, readLibraryRef, withLibraryLock } from './journalLibrary.js';
import { assertLibrary, isObject } from './libraryValidation.js';

export const DEFAULT_REPOSITORY_ROOT = path.resolve(DEFAULT_LIBRARY_ROOT, '../..');

/** Follow validated formal history only. Do not stage drafts, keys, attempts, writer.lock, or orphan snapshots. */
export async function journalGitFiles(config, { root = DEFAULT_LIBRARY_ROOT, repositoryRoot = DEFAULT_REPOSITORY_ROOT } = {}) {
  const relativeRoot = path.relative(path.resolve(repositoryRoot), path.resolve(root)).split(path.sep).join('/');
  assertLibrary(relativeRoot === 'data/journal-store', '只允许将指定论文库列入数据提交');
  const library = await readJournalLibrary({ root, config });
  assertLibrary(library.pointer, '尚无可保存到Git的正式版本');
  const files = new Set(['current.json']), visited = new Set();
  const checked = new Map();
  async function read(ref) {
    assertLibrary(ref && typeof ref.path === 'string', '历史引用缺失');
    if (checked.has(ref.path)) { assertLibrary(checked.get(ref.path).hash === ref.sha256, '同一路径出现不同校验值'); return checked.get(ref.path).data; }
    const data = await readLibraryRef(root, ref); files.add(ref.path); checked.set(ref.path, { hash: ref.sha256, data }); return data;
  }
  let ref = library.pointer.manifest;
  while (ref) {
    assertLibrary(!visited.has(ref.path), '历史版本链存在循环'); visited.add(ref.path);
    const manifest = await read(ref);
    assertLibrary(manifest.schema_version === 1 && ref.path === `snapshots/${manifest.run_id}/manifest.json` &&
      isObject(manifest.papers) && isObject(manifest.runs) && Array.isArray(manifest.raw), '历史版本结构无效');
    for (const bucket of Object.values(manifest.papers)) await read(bucket);
    for (const bucket of Object.values(manifest.runs)) await read(bucket);
    for (const bucket of Object.values(manifest.enrichment_runs || {})) {
      const logs = await read(bucket); assertLibrary(Array.isArray(logs), '历史补全日志结构无效');
      for (const log of logs) await read(log.report);
    }
    if (manifest.enrichment_state) await read(manifest.enrichment_state);
    for (const bucket of Object.values(manifest.translation_imports || {})) {
      const logs = await read(bucket); assertLibrary(Array.isArray(logs), '历史翻译日志结构无效');
      for (const log of logs) await read(log.report);
    }
    await read(manifest.audit); for (const raw of manifest.raw) await read(raw);
    if (manifest.translation_queue) await read(manifest.translation_queue);
    ref = manifest.parent;
  }
  assertLibrary(await fs.readFile(await libraryPath(root, 'current.json'), 'utf8') === library.pointerText, '读取期间正式版本已变化');
  return { files: [...files].sort().map((file) => `${relativeRoot}/${file}`), pointerText: library.pointerText, versions: visited.size };
}

function git(args, { cwd, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; child.stdout.on('data', (chunk) => chunks.push(chunk)); child.stderr.resume();
    child.on('error', () => reject(new Error('Git 无法启动')));
    child.stdin.on('error', () => {});
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error('Git 操作未完成；未输出远程地址或凭据')));
    child.stdin.end(input);
  });
}

export async function stageJournalFiles(config, { root = DEFAULT_LIBRARY_ROOT, repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  runGit = git } = {}) {
  return withLibraryLock(root, async () => {
    const top = (await runGit(['rev-parse', '--show-toplevel'], { cwd: repositoryRoot })).trim();
    assertLibrary(path.resolve(top) === path.resolve(repositoryRoot), 'Git仓库根目录不符');
    assertLibrary(!(await runGit(['diff', '--cached', '--name-only', '-z'], { cwd: repositoryRoot })), '暂存区已有内容，请先处理，避免混入本次数据提交');
    const plan = await journalGitFiles(config, { root, repositoryRoot });
    await runGit(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'],
      { cwd: repositoryRoot, input: `${plan.files.join('\0')}\0` });
    const staged = (await runGit(['diff', '--cached', '--name-only', '-z'], { cwd: repositoryRoot })).split('\0').filter(Boolean);
    assertLibrary(staged.every((file) => plan.files.includes(file)), '暂存区混入非本次论文库文件，不允许提交');
    return { file_count: plan.files.length, staged_count: staged.length, versions: plan.versions };
  });
}
