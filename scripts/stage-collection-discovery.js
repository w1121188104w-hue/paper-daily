import {loadJournalConfig} from '../src/services/journals.js';
import {stageJournalFiles} from '../src/services/journalGitFiles.js';
import {readWorkflow,WORKFLOW_PATH} from '../src/services/collectionWorkflow.js';
import {fileURLToPath} from 'node:url';
import {safeProcess} from './collection-service.js';
const repositoryRoot=fileURLToPath(new URL('../',import.meta.url));
try{
  await readWorkflow(repositoryRoot);await stageJournalFiles(await loadJournalConfig());
  await safeProcess('git',['add','-f','--',WORKFLOW_PATH],{cwd:repositoryRoot});
}catch{console.error('DISCOVERY_STAGE_FAILED');process.exitCode=1;}
