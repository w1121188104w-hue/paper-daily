// Offline migration of existing browser evidence. No API, paper import,
// translation, reminder acknowledgement or fake new full-audit receipt.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {emptyWorkflow,validateWorkflow,applyCollectionReceipt,readWorkflow,saveWorkflow} from '../src/services/collectionWorkflow.js';
import {mergeCatalogBaselines,catalogChecks} from '../src/services/catalogBaseline.js';
import {ACTIVE_CATALOG_TASKS} from '../tools/browser-abstract-extension/catalog-core.js';
import {withLibraryLock} from '../src/services/journalLibrary.js';
import {assertLibrary} from '../src/services/libraryValidation.js';

export async function seedCatalogBaselines(state,data,inputHash,{now=new Date()}={}){
  validateWorkflow(state);
  assertLibrary(/^[a-f0-9]{64}$/.test(inputHash)&&Array.isArray(data.catalog?.pages)&&
    Number.isFinite(Date.parse(data.catalog.run_started_at))&&data.catalog.run_started_at<=now.toISOString(),'目录证据缺少有效批次起始时间');
  const id=[inputHash.slice(0,8),inputHash.slice(8,12),inputHash.slice(12,16),inputHash.slice(16,20),inputHash.slice(20,32)].join('-');
  const run={version:1,id,mode:'full',created_at:data.catalog.run_started_at,known_papers:[],task_versions:[],
    jobs:ACTIVE_CATALOG_TASKS.map(t=>({catalog_id:t.id,url:t.url}))};
  const result=await applyCollectionReceipt(emptyWorkflow(),run,{...data,workflow_run_id:id},
    {input_sha256:inputHash,sources:[]},{papers:[]},{now});
  const next=structuredClone(state);
  mergeCatalogBaselines(next,(result.catalog_baselines||[]).filter(b=>Date.parse(b.checked_at)<=now.getTime()));
  if(JSON.stringify(next.catalog_baselines)!==JSON.stringify(state.catalog_baselines))next.updated_at=now.toISOString();
  return validateWorkflow(next);
}
async function main(){
  const {values:v}=parseArgs({options:{input:{type:'string',multiple:true},save:{type:'boolean'},interval:{type:'string'}}});
  assertLibrary(v.input?.length&&(!v.interval||['7','14'].includes(v.interval)),'Usage: --input export.json [--input export2.json] [--interval 7|14] [--save]');
  const repositoryRoot=fileURLToPath(new URL('../',import.meta.url));
  const apply=async()=>{
    let state=await readWorkflow(repositoryRoot);
    for(const file of v.input){
      assertLibrary((await fs.stat(file)).size<=150*1024*1024,'导出超过150MB');
      const text=await fs.readFile(file,'utf8'),data=JSON.parse(text.replace(/^\uFEFF/,''));
      state=await seedCatalogBaselines(state,data,createHash('sha256').update(text).digest('hex'));
    }
    if(v.interval)state.audit_interval_days=Number(v.interval);
    if(v.save)await saveWorkflow(repositoryRoot,state);
    const checks=catalogChecks(state);
    console.log(JSON.stringify({saved:!!v.save,paid_calls:0,papers_changed:0,reminders_acknowledged:0,
      verified_catalogs:checks.filter(c=>c.checked_at).length,total_catalogs:checks.length,
      checks},null,2));
  };
  if(v.save)await withLibraryLock(path.join(repositoryRoot,'data/collection-workflow'),apply);else await apply();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{
  console.error('BASELINE_IMPORT_FAILED: original workflow and paper library retained; check export evidence.');process.exitCode=1;
});
