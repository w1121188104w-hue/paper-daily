import fs from 'node:fs/promises';
import path from 'node:path';
import {assertLibrary} from './libraryValidation.js';
import {readBrowserExport} from './browserImport.js';
import {validateCloudQueue,CLOUD_QUEUE_PATH} from './cloudPublication.js';
import {writeWorkflowJson} from './workflowStorage.js';

/** Local data is replayable from frozen exports. Cloud translations are authoritative.
 * Archive the exact local commit before rebasing the dedicated clean checkout.
 * Code changes, missing exports, a dirty index, or unknown commits always stop this.
 */
export async function recoverCollectionDivergence({git,stateDir,allowedFiles}){
  assertLibrary(!(await git(['status','--porcelain','--untracked-files=all'])).trim(),'恢复前工作目录必须干净');
  const head=(await git(['rev-parse','HEAD'])).trim(),remote=(await git(['rev-parse','origin/master'])).trim();
  assertLibrary(/^[a-f0-9]{40}$/.test(head)&&/^[a-f0-9]{40}$/.test(remote),'恢复版本无效');
  const subjects=(await git(['log','--format=%s','origin/master..HEAD'])).trim().split('\n');
  assertLibrary(subjects.length>0&&subjects.every(s=>s==='data: save browser collection and workflow receipts'),'仅能恢复自动数据提交');
  const base=(await git(['merge-base','HEAD','origin/master'])).trim();
  const files=(await git(['diff','--name-only','-z',base,head])).split('\0').filter(Boolean);
  assertLibrary(files.length&&files.every(f=>allowedFiles.has(f)),'分歧中有非采集数据改动');
  const before=validateCloudQueue(JSON.parse(await git(['show',base+':'+CLOUD_QUEUE_PATH])));
  const local=validateCloudQueue(JSON.parse(await git(['show',head+':'+CLOUD_QUEUE_PATH])));
  const requests=local.requests.filter(r=>!before.requests.some(b=>JSON.stringify(b)===JSON.stringify(r)));
  assertLibrary(requests.length>0,'无法证明分歧数据可重放');
  for(const r of requests){
    const input=await readBrowserExport(path.join(stateDir,r.id,'export.json'));
    const saved=JSON.parse(await fs.readFile(path.join(stateDir,r.id,'run.json'),'utf8'));
    assertLibrary(input.sha256===r.input_sha256&&saved.export_hash===input.sha256&&saved.run.id===r.id,'恢复所需原始批次缺失或变化');
  }
  const backup='refs/heads/codex/collection-recovery-'+head;
  await git(['update-ref',backup,head]);
  await writeWorkflowJson(path.join(stateDir,'git-recovery.json'),{version:1,from:head,to:remote,backup,batches:requests.map(r=>r.id),phase:'archived'});
  // The checkout is clean, local-only changes are validated generated data, and
  // the former HEAD remains reachable. No untracked files are cleaned/deleted.
  await git(['reset','--hard',remote]);
  await writeWorkflowJson(path.join(stateDir,'git-recovery.json'),{version:1,from:head,to:remote,backup,batches:requests.map(r=>r.id),phase:'replay_pending'});
  return requests.map(r=>r.id);
}
