import fs from 'node:fs/promises';
import path from 'node:path';
import {assertLibrary} from './libraryValidation.js';

const subjects=new Set(['data: checkpoint cloud publication queue','data: reserve translation requests before billing','data: save automatic DeepSeek translations and usage']);
/** Preserve only generated, already committed cloud results after a failed push.
 * A bundle has Git objects, not .git/config, credential headers, or runner env.
 * Recovery is explicit; producing the archive never retries a paid request.
 */
export async function saveCloudRecoveryBundle({git,output}){
  const commits=(await git(['log','--format=%s','origin/master..HEAD'])).trim();
  if(!commits)return {saved:false};
  assertLibrary(commits.split('\n').every(s=>subjects.has(s)),'恢复包含非云端发布提交');
  const files=(await git(['diff','--name-only','-z','origin/master...HEAD'])).split('\0').filter(Boolean);
  assertLibrary(files.length&&files.every(f=>f.startsWith('data/journal-store/')||['data/collection-workflow/state.json','data/collection-workflow/publication-queue.json'].includes(f)),'恢复包含非发布数据');
  await fs.mkdir(path.dirname(output),{recursive:true});
  await git(['bundle','create',output,'HEAD','^origin/master']);
  await git(['bundle','verify',output]);
  return {saved:true,commits:commits.split('\n').length};
}
