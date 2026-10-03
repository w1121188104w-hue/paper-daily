import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const source=existsSync(path.join(root,'tools/browser-abstract-extension/core.js'))?root:path.join(root,'data/browser-import-release');
const moduleAt=name=>import(pathToFileURL(path.join(source,'tools/browser-abstract-extension',name)).href);
const {ACTIVE_CATALOG_TASKS,assessCatalog,catalogUrl}=await moduleAt('catalog-core.js');
const {assessCapture,safeSourceUrl}=await moduleAt('core.js');
const [action,inputFile,outputFile]=process.argv.slice(2);
const input=JSON.parse(await fs.readFile(inputFile,'utf8'));
if(action==='verify'){
  for(const [name,hash] of Object.entries(input.source_hashes)){
    if(!/^[a-zA-Z0-9-]+\.js$/.test(name))throw Error('INVALID_SOURCE_NAME');
    const text=(await fs.readFile(path.join(source,'tools/browser-abstract-extension',name),'utf8')).replace(/\r\n/g,'\n');
    const actual=createHash('sha256').update(text).digest('hex');
    if(actual!==hash)throw Error('SOURCE_VERSION_CHANGED:'+name);
  }
  for(const task of input.tasks){
    if(task.kind==='catalog'){
      const c=ACTIVE_CATALOG_TASKS.find(c=>c.id===task.catalog_id&&c.journal===task.journal);
      if(!c||!catalogUrl(task.url,c))throw Error('INVALID_CATALOG_TASK');
    }else if(task.kind!=='article'||!safeSourceUrl(task.url)||!task.doi)throw Error('INVALID_ARTICLE_TASK');
  }
  console.log(JSON.stringify({verified:true,tasks:input.tasks.length}));
}else if(action==='assess'){
  const result=input.task.kind==='catalog'?
    assessCatalog(ACTIVE_CATALOG_TASKS.find(c=>c.id===input.task.catalog_id),input.capture):assessCapture(input.task,input.capture);
  await fs.writeFile(outputFile,JSON.stringify(result,null,2)+'\n');
}else throw Error('UNKNOWN_ACTION');
