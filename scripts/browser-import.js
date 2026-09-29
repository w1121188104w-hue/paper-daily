import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadJournalConfig } from '../src/services/journals.js';
import { readBrowserExport, prepareBrowserImport, importBrowserExport } from '../src/services/browserImport.js';
import { readJournalLibrary, withLibraryLock, writeLibraryJson } from '../src/services/journalLibrary.js';
import { assertLibrary } from '../src/services/libraryValidation.js';
import { readTranslationState, TRANSLATION_STATE_PATH } from '../src/services/translationAutomation.js';
import { buildJournalSite } from '../src/services/journalSiteBuild.js';

export async function initializeLocalLedger(root, config) {
  return withLibraryLock(root, async () => {
    try { await readTranslationState(root); return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const library = await readJournalLibrary({ root, config });
    assertLibrary(!library.imports.length && !library.papers.some(p => p.title_zh || p.abstract_zh), '旧库缺失翻译账本，不能重建空账本');
    for (const folder of ['translations', 'automation']) {
      let entries = []; try { entries = await fs.readdir(path.join(root, folder)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      assertLibrary(entries.length === 0, '存在历史翻译记录，不能重建空账本');
    }
    await writeLibraryJson(root, TRANSLATION_STATE_PATH, { schema_version: 2, paused: null, reservations: [] });
  });
}
// Recovery/import tool only. Paid translation has no local CLI entry point.
export async function runBrowserImportCommand(args,{log=console.log}={}){
  const {values:v}=parseArgs({args,options:{file:{type:'string',multiple:true},library:{type:'string'},save:{type:'boolean'},build:{type:'string'},help:{type:'boolean'}}});
  if(v.help){log('node scripts/browser-import.js --file <JSON> --library <库目录> [--save] [--build <目录>]\n仅用于离线核验与恢复，不执行翻译。日常使用扩展自动流程。');return;}
  assertLibrary(v.library&&v.file?.length,'请指定文件和库目录');assertLibrary(!v.build||v.save,'建站需明确保存');
  const config=await loadJournalConfig(),root=path.resolve(v.library),prepared=[];
  for(const file of v.file){const input=await readBrowserExport(file);prepared.push(await prepareBrowserImport(input.data,config,input.sha256));}
  const reports=[];
  for(const p of prepared){const r=await importBrowserExport(config,{root,prepared:p,save:!!v.save});reports.push({committed:r.committed,stats:r.stats});}
  const site=v.build?await buildJournalSite(config,{root,outputRoot:path.resolve(v.build)}):null;
  log(JSON.stringify({reports,site,paid_requests:0,deployed:false}));return {reports,site};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runBrowserImportCommand(process.argv.slice(2)).catch(error => {
  // Never echo an HTTP response, environment or credential in diagnostics.
  console.error(`本地导入流程未完成；已提交步骤保留，可原命令继续。错误类型：${/^[A-Z_]+$/.test(error.code || '') ? error.code : 'VALIDATION_OR_IO_ERROR'}`);
  process.exitCode = 1;
});
