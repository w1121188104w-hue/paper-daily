import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadJournalConfig} from '../src/services/journals.js';
import {readWorkflow,saveWorkflow,WORKFLOW_PATH} from '../src/services/collectionWorkflow.js';
import {CLOUD_QUEUE_PATH,processCloudPublications,readCloudQueue,enqueueManualBackfill} from '../src/services/cloudPublication.js';
import {runTranslationAutomation,automationQueue,readTranslationState} from '../src/services/translationAutomation.js';
import {readJournalLibrary} from '../src/services/journalLibrary.js';
import {makeTranslationPublisher} from '../src/services/translationAutomationGit.js';
import {safeProcess} from './collection-service.js';
import {assertLibrary} from '../src/services/libraryValidation.js';

const repo=fileURLToPath(new URL('../',import.meta.url)),root=path.join(repo,'data/journal-store');
async function main(){
  assertLibrary(process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_REPOSITORY==='w1121188104w-hue/paper-daily'&&process.env.GITHUB_REF==='refs/heads/master','翻译只允许在正式 GitHub 工作流运行');
  const config=await loadJournalConfig(),env={...process.env};delete env.DEEPSEEK_API_KEY;
  const git=(args,opts={})=>safeProcess('git',args,{cwd:repo,env,...opts});
  const checkpoint=async()=>{
    await readCloudQueue(repo);await readWorkflow(repo);
    await git(['add','-f','--',CLOUD_QUEUE_PATH,WORKFLOW_PATH]);
    const staged=(await git(['diff','--cached','--name-only','-z'])).split('\0').filter(Boolean);
    assertLibrary(staged.every(f=>[CLOUD_QUEUE_PATH,WORKFLOW_PATH].includes(f)),'云端回执暂存范围错误');
    if(staged.length)await git(['-c','user.name=github-actions[bot]','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com','commit','-m','data: checkpoint cloud publication queue']);
    await git(['push','origin','HEAD:refs/heads/master']);
  };
  if(process.env.PAPER_BACKFILL_MISSING==='true'){
    assertLibrary(process.env.GITHUB_EVENT_NAME==='workflow_dispatch','全库补译只能显式手动启动');
    const library=await readJournalLibrary({root,config}),state=await readTranslationState(root);
    const tasks=state.paused?[]:automationQueue(library,state).available;
    const request=await enqueueManualBackfill(repo,{runId:process.env.GITHUB_RUN_ID,tasks});
    await checkpoint();
    console.log(JSON.stringify({manual_backfill:request?.id||null,eligible_fields:tasks.length,paused:!!state.paused}));
  }
  const result=await processCloudPublications(repo,{checkpoint,
    translate:opts=>runTranslationAutomation(config,{...opts,root,mode:'backfill',apiKey:process.env.DEEPSEEK_API_KEY,
      publishCheckpoint:makeTranslationPublisher(config,{root,repositoryRoot:repo,branch:'master',gitImpl:git})}),
    updateReceipt:async r=>{const s=await readWorkflow(repo),receipt=s.receipts.find(x=>x.id===r.id);
      if(receipt){receipt.publication_id=r.publication_id;receipt.pending_translation_fields=r.pending_fields;
        receipt.translation_status=r.status;receipt.translation_code=r.code;receipt.cloud_processed_at=new Date().toISOString();await saveWorkflow(repo,s);}}
  });
  console.log(JSON.stringify(result));
}
main().catch(()=>{console.error('CLOUD_PUBLICATION_FAILED: saved papers and billing reservations retained');process.exitCode=1;});
