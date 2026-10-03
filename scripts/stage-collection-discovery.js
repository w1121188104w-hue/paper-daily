import {loadJournalConfig} from '../src/services/journals.js';
import {stageJournalFiles} from '../src/services/journalGitFiles.js';
import {readWorkflow,WORKFLOW_PATH} from '../src/services/collectionWorkflow.js';
import {fileURLToPath} from 'node:url';
import {safeProcess} from './collection-service.js';
import {readOfficialCache,OFFICIAL_CACHE_PATH} from '../src/services/officialCatalog.js';
import {readCloudQueue,CLOUD_QUEUE_PATH} from '../src/services/cloudPublication.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {sourceReviewGitFiles} from '../src/services/sourceReviewGit.js';
const repositoryRoot=fileURLToPath(new URL('../',import.meta.url));
try{
  await readWorkflow(repositoryRoot);await stageJournalFiles(await loadJournalConfig());
  await safeProcess('git',['add','-f','--',WORKFLOW_PATH],{cwd:repositoryRoot});
  for(const [file,validate] of [[OFFICIAL_CACHE_PATH,readOfficialCache],[CLOUD_QUEUE_PATH,readCloudQueue]]){
    try{await fs.stat(path.join(repositoryRoot,file));await validate(repositoryRoot);await safeProcess('git',['add','-f','--',file],{cwd:repositoryRoot});}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const reviewFiles=await sourceReviewGitFiles(repositoryRoot);
  if(reviewFiles.length)await safeProcess('git',['add','-f','--pathspec-from-file=-','--pathspec-file-nul'],{cwd:repositoryRoot,input:reviewFiles.join('\0')+'\0'});
}catch{console.error('DISCOVERY_STAGE_FAILED');process.exitCode=1;}
