import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {loadJournalConfig} from '../src/services/journals.js';
import {createCollectionCoordinator,collectionHttpServer} from '../src/services/collectionCoordinator.js';
import {stageJournalFiles,journalGitFiles} from '../src/services/journalGitFiles.js';
import {assertLibrary} from '../src/services/libraryValidation.js';
import {WORKFLOW_PATH,readWorkflow} from '../src/services/collectionWorkflow.js';
import {runTranslationAutomation,readTranslationState} from '../src/services/translationAutomation.js';
import {makeTranslationPublisher,STATE_GIT_PATH} from '../src/services/translationAutomationGit.js';
import {buildJournalSite} from '../src/services/journalSiteBuild.js';

export function safeProcess(command,args,{cwd,env=process.env,input='',timeout=120000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let chunks=[],size=0,bad=false;
    const timer=setTimeout(()=>{bad=true;child.kill();},timeout);
    child.stderr.resume();child.stdin.on('error',()=>{});child.stdout.on('data',c=>{size+=c.length;if(size>2*1024*1024){bad=true;child.kill();}else chunks.push(c);});
    child.on('error',()=>{clearTimeout(timer);reject(Error('PROCESS_UNAVAILABLE'));});
    child.on('close',code=>{clearTimeout(timer);if(code||bad)reject(Error('PROCESS_FAILED'));else resolve(Buffer.concat(chunks).toString('utf8'));});child.stdin.end(input);
  });
}
export async function startCollectionService({env=process.env}={}){
  const repositoryRoot=fileURLToPath(new URL('../',import.meta.url)),root=path.join(repositoryRoot,'data/journal-store');
  assertLibrary(env.LOCALAPPDATA&&env.PAPER_EXTENSION_ID,'本机配置缺失');
  const stateDir=path.join(env.LOCALAPPDATA,'PaperDailyWorkflow'),config=await loadJournalConfig();
  const childEnv={...env};delete childEnv.DEEPSEEK_API_KEY;
  const git=(args,options={})=>safeProcess('git',args,{cwd:repositoryRoot,env:childEnv,...options});
  async function allowedDirty(){const plan=await journalGitFiles(config,{root,repositoryRoot});
    const allowed=new Set([...plan.files,WORKFLOW_PATH,STATE_GIT_PATH]);
    const dirty=(await git(['diff','HEAD','--name-only','-z'])).split('\0').filter(Boolean);
    assertLibrary(dirty.every(p=>allowed.has(p)),'存在未提交代码改动，停止正式流程');
    assertLibrary(!(await git(['diff','--cached','--name-only','-z'])),'暂存区已有改动');
    return allowed;}
  async function sync(){
    assertLibrary((await git(['remote','get-url','origin'])).trim()==='https://github.com/w1121188104w-hue/paper-daily.git','正式仓库不匹配');
    await allowedDirty();await git(['fetch','origin','master']);
    const [behind,ahead]=(await git(['rev-list','--left-right','--count','origin/master...HEAD'])).trim().split(/\s+/).map(Number);
    assertLibrary(!(behind&&ahead),'本地和线上分支冲突，不能自动覆盖');
    if(behind){assertLibrary(!(await git(['diff','HEAD','--name-only'])),'远端已变化，先保留本机未发布数据');await git(['merge','--ff-only','origin/master']);}
  }
  async function checkpoint(){
    await allowedDirty();await readTranslationState(root);
    await stageJournalFiles(config,{root,repositoryRoot,runGit:(args,options)=>git(args,options)});
    await git(['add','-f','--',STATE_GIT_PATH]);
    try{await fs.stat(path.join(repositoryRoot,WORKFLOW_PATH));await readWorkflow(repositoryRoot);await git(['add','-f','--',WORKFLOW_PATH]);}catch(e){if(e.code!=='ENOENT')throw e;}
    if((await git(['diff','--cached','--name-only'])).trim())await git(['-c','user.name=paper-daily','-c','user.email=paper-daily@users.noreply.github.com','commit','-m','data: save browser collection and workflow receipts']);
    await git(['push','origin','HEAD:refs/heads/master']);
  }
  const release=(mode,id,hash,publicationId)=>safeProcess('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(repositoryRoot,'scripts/collection-release.ps1'),'-Mode',mode,
    ...(id?['-BatchId',id,'-ExportHash',hash,'-PublicationId',publicationId]:[])],{cwd:repositoryRoot,env:childEnv,timeout:45000}).then(JSON.parse);
  const coordinator=createCollectionCoordinator({repositoryRoot,stateDir,config,sync,checkpoint,
    translate:opts=>runTranslationAutomation(config,{...opts,mode:'backfill',apiKey:env.DEEPSEEK_API_KEY,
      publishCheckpoint:makeTranslationPublisher(config,{root,repositoryRoot,branch:'master',env,gitImpl:git}),log:()=>{}}),
    build:opts=>buildJournalSite(config,{...opts,outputRoot:path.join(repositoryRoot,'data/workflow-site-builds')}),
    publish:async()=>{await checkpoint();return release('Publish');},
    checkPublication:async(id,hash,publicationId)=>(await release('Check',id,hash,publicationId)).published===true});
  await fs.mkdir(stateDir,{recursive:true});
  // An OS listener is the one-writer guard. No paid work starts on boot.
  const server=collectionHttpServer(coordinator,{extensionId:env.PAPER_EXTENSION_ID});
  server.requestTimeout=120000;server.headersTimeout=15000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(17328,'127.0.0.1',resolve);});
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)
  startCollectionService().then(()=>console.log('Workflow ready on 127.0.0.1:17328; no automatic paid work started.')).catch(()=>{console.error('WORKFLOW_START_FAILED');process.exitCode=1;});
