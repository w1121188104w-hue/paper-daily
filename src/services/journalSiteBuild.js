import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DEFAULT_LIBRARY_ROOT, libraryPath, newRunId, withLibraryLock, writeLibraryJson } from './journalLibrary.js';
import { loadJournalPresentation } from './journalPresentation.js';
import { assertLibrary } from './libraryValidation.js';

export const DEFAULT_SITE_BUILD_ROOT = fileURLToPath(new URL('../../data/site-builds/', import.meta.url));
export const SITE_ASSETS = ['index.html', 'day.html', 'app.js', 'viewModel.js', 'styles.css', 'base.css'];
const SITE_FILES = [...SITE_ASSETS, 'data.json', '.nojekyll'];
const digest = (content) => createHash('sha256').update(content).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function optionalPointer(root) {
  try { return await fs.readFile(await libraryPath(root, 'current.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function disjoint(left, right) {
  const relative = path.relative(path.resolve(left), path.resolve(right));
  return relative && (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

export async function validateSiteDirectory(directory, hashes) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  assertLibrary(entries.length === SITE_FILES.length && entries.every((entry) => entry.isFile() && SITE_FILES.includes(entry.name)),
    '网页目录含多余文件、目录或链接，不允许发布');
  assertLibrary(Object.keys(hashes).length === SITE_FILES.length, '网页文件清单不完整');
  for (const name of SITE_FILES) {
    const content = await fs.readFile(await libraryPath(directory, name));
    assertLibrary(digest(content) === hashes[name], '网页文件校验失败，不切换到新版本');
  }
  const data = JSON.parse(await fs.readFile(path.join(directory, 'data.json'), 'utf8'));
  assertLibrary(data.schema_version === 1 && data.delivery_mode === 'static' && data.journals.length === 19 &&
    Array.isArray(data.papers) && Array.isArray(data.runs), '静态网页数据结构无效');
  // Dependencies must remain local and work from a GitHub repository subpath.
  for (const page of ['index.html', 'day.html']) {
    const html = await fs.readFile(path.join(directory, page), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = match[1];
      assertLibrary(ref.startsWith('#') || (ref.startsWith('./') && SITE_FILES.includes(ref.slice(2))), '网页引用不是可用的相对静态资源');
    }
  }
  return data;
}

/** Validated immutable site versions; publish one tiny pointer last, never remove a prior build. */
export async function buildJournalSite(config, { root = DEFAULT_LIBRARY_ROOT, outputRoot = DEFAULT_SITE_BUILD_ROOT,
  allowEmpty = false, now = () => new Date(), beforePublish } = {}) {
  assertLibrary(disjoint(root, outputRoot) && disjoint(outputRoot, root), '网页输出与正式论文库不得重叠');
  // Validate the complete formal library before creating any output directory.
  const data = await loadJournalPresentation(config, { root });
  assertLibrary(data.initialized || allowEmpty, '尚无正式论文库；如仅演示空界面，需明确加 --allow-empty');
  data.delivery_mode = 'static';
  return withLibraryLock(outputRoot, async () => {
    const oldPointer = await optionalPointer(outputRoot), builtAt = now().toISOString(), buildId = newRunId(new Date(builtAt));
    const prefix = `versions/${buildId}`, directory = await libraryPath(outputRoot, `${prefix}/site`);
    await fs.mkdir(directory, { recursive: true });
    const hashes = {};
    const write = async (name, content) => {
      await fs.writeFile(await libraryPath(directory, name), content, { flag: 'wx' }); hashes[name] = digest(content);
    };
    for (const name of SITE_ASSETS) {
      let content = await fs.readFile(new URL(`../../public/${name === 'base.css' ? 'styles.css' : `journals/${name}`}`, import.meta.url), 'utf8');
      if (name.endsWith('.html')) {
        assertLibrary(content.includes('<body'), '网页缺少正文标签');
        content = content.replace('<body', '<body data-delivery="static"')
          .replaceAll('本地只读预览 · 不会自动采集或翻译', '只读论文库 · 页面不会触发采集或翻译')
          .replaceAll('重新读取本地数据', '重新读取网页数据').replaceAll('正在读取已保存的论文库', '正在读取已发布的论文库');
      }
      await write(name, content);
    }
    await write('data.json', json(data)); await write('.nojekyll', '');
    const report = { schema_version: 1, build_id: buildId, built_at: builtAt, directory: `${prefix}/site`,
      paper_count: data.papers.length, initialized: data.initialized, source_snapshot_at: data.snapshot_at, hashes };
    await writeLibraryJson(outputRoot, `${prefix}/build.json`, report);
    if (beforePublish) await beforePublish({ directory, report });
    await validateSiteDirectory(directory, hashes);
    assertLibrary(await optionalPointer(outputRoot) === oldPointer, '网页版本入口被其他进程改变，请重新构建');
    const temp = `current-${buildId}.tmp`;
    await writeLibraryJson(outputRoot, temp, { schema_version: 1, build: `${prefix}/build.json` });
    await fs.rename(await libraryPath(outputRoot, temp), await libraryPath(outputRoot, 'current.json'));
    return { ...report, directory };
  });
}
