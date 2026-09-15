import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { clonePilotLibrary } from './search-pilot.js';
import { journalGitFiles } from '../src/services/journalGitFiles.js';
import { assertLibrary, stableJson } from '../src/services/libraryValidation.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const manifestName = 'pipeline-checkpoint.json';

/** Export only the validated history closure, never the runner workspace or env.
 * A failed run may still have a valid last committed stage worth retaining. */
export async function savePipelineCheckpoint(config, { root, tempParent, secrets = [] }) {
  const copy = await clonePilotLibrary(config, { repositoryRoot: path.resolve(root, '../..'), tempParent });
  const plan = await journalGitFiles(config, { root: copy.root, repositoryRoot: copy.directory });
  const files = [];
  for (const relative of plan.files) {
    const bytes = await fs.readFile(path.join(copy.directory, relative));
    assertLibrary(!secrets.filter(Boolean).some(secret => bytes.includes(Buffer.from(secret))), '存档包含凭据，禁止导出');
    files.push({ path: relative, sha256: hash(bytes) });
  }
  await copy.verifyOriginal();
  const manifest = { schema_version: 1, kind: 'isolated_pipeline_checkpoint',
    config_sha256: hash(stableJson(config)), files };
  await fs.writeFile(path.join(copy.directory, manifestName), JSON.stringify(manifest), { flag: 'wx' });
  return { directory: copy.directory, files: files.length, versions: plan.versions };
}

/** Treat downloaded checkpoints as data, never executable input. Validate all
 * hashes and library invariants, then resume in a fresh copy, not in the artifact. */
export async function restorePipelineCheckpoint(config, { directory, tempParent }) {
  const repository = await fs.realpath(directory);
  const manifest = JSON.parse(await fs.readFile(path.join(repository, manifestName), 'utf8'));
  assertLibrary(manifest.schema_version === 1 && manifest.kind === 'isolated_pipeline_checkpoint' &&
    manifest.config_sha256 === hash(stableJson(config)), '存档类型或期刊配置不符');
  const root = path.join(repository, 'data', 'journal-store');
  const plan = await journalGitFiles(config, { root, repositoryRoot: repository });
  assertLibrary(Array.isArray(manifest.files) && manifest.files.length === plan.files.length &&
    manifest.files.every((file, i) => file.path === plan.files[i] && /^[a-f0-9]{64}$/.test(file.sha256)), '存档文件清单不符');
  for (const file of manifest.files) {
    assertLibrary(hash(await fs.readFile(path.join(repository, file.path))) === file.sha256, '存档文件校验失败');
  }
  return clonePilotLibrary(config, { repositoryRoot: repository, tempParent });
}

export async function checkpointOutput(file, checkpoint) {
  assertLibrary(typeof file === 'string' && file && !/[\r\n]/.test(checkpoint.directory), '存档输出路径无效');
  await fs.appendFile(file, `checkpoint_path=${checkpoint.directory}\n`);
}
