import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {safeProcess} from './collection-service.js';
import {saveCloudRecoveryBundle} from '../src/services/cloudGitRecovery.js';
const repo=fileURLToPath(new URL('../',import.meta.url)),env={...process.env};delete env.DEEPSEEK_API_KEY;
const git=(args,options={})=>safeProcess('git',args,{cwd:repo,env,...options});
saveCloudRecoveryBundle({git,output:path.join(repo,'data/cloud-recovery/unpublished.bundle')})
  .then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('CLOUD_RECOVERY_ARCHIVE_FAILED');process.exitCode=1;});
