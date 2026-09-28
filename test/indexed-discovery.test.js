import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {discoverIndexedCollectionTasks} from '../src/services/collectionDiscovery.js';
import {emptyWorkflow} from '../src/services/collectionWorkflow.js';
import {loadJournalConfig} from '../src/services/journals.js';

test('production entry cannot call legacy paid adapters, including when indexes fail',async()=>{
 const config=await loadJournalConfig();let collected=0,searches=0;
 const state=await discoverIndexedCollectionTasks(config,emptyWorkflow(),[],{
  collect:async(_,options)=>{collected++;assert.equal(options.withSemanticScholar,true);throw Error('offline');},
  search:async()=>{searches++;throw Error('must never call');},searchProviders:['zhipu']
 });
 assert.equal(collected,config.journals.filter(j=>j.enabled).length);assert.equal(searches,0);
 assert.ok(state.monitors.filter(m=>m.source==='search').every(m=>m.status==='disabled'));
 assert.equal(state.tasks.length,0);
});
test('removed search CLI flag fails before sources or library mutation',()=>{
 const child=spawnSync(process.execPath,['scripts/discover-collection.js','--run','--search'],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
 assert.equal(child.status,1);assert.match(child.stderr,/DISCOVERY_NOT_COMPLETE/);
});
test('only indexed discovery workflow is enabled by deployment; no paid credentials mounted',async()=>{
 const text=await fs.readFile(new URL('../.github/workflows/collection-discovery.yml',import.meta.url),'utf8');
 assert.doesNotMatch(text,/ZHIPU|SERPAPI|DEEPSEEK|--search|SEARCH_ENABLED/);
 assert.match(text,/cron: '17 0,4/);assert.match(text,/discover-collection.js --run --save-sources/);
 assert.doesNotMatch(text,/checkout@d23441/);
 const cli=await fs.readFile(new URL('../scripts/discover-collection.js',import.meta.url),'utf8');
 assert.doesNotMatch(cli,/makeSearch|ZHIPU|SERPAPI/);
 for(const file of ['discovery-search-probe-v2.yml','discovery-search-probe.yml','daily-collect.yml','search-preflight.yml'])
  await assert.rejects(fs.access(new URL('../.github/workflows/'+file,import.meta.url)),{code:'ENOENT'});
});

test('remaining publish workflow uses only validated site assets, never mounts paid keys',async()=>{
 const file='../.github/workflows/deploy-pages.yml';
 const flow=JSON.parse(await fs.readFile(new URL(file,import.meta.url),'utf8'));
 const template=JSON.parse(await fs.readFile(new URL('../deploy/github/deploy-pages.yml.example',import.meta.url),'utf8'));
 template.name=template.name.replace(' (INACTIVE TEMPLATE)','');assert.deepEqual(flow,template);
 assert.deepEqual(Object.keys(flow.on),['workflow_dispatch']);assert.equal(flow.concurrency.group,'journal-production');
 assert.equal(flow.jobs.deploy.permissions.pages,'write');assert.equal(flow.jobs.deploy.permissions['id-token'],'write');
 const steps=Object.values(flow.jobs).flatMap(j=>j.steps);
 assert.doesNotMatch(JSON.stringify(flow),/secrets\.|journal-pipeline|--search|git add -A|push --force/);
 for(const s of steps.filter(s=>s.uses))assert.match(s.uses,/^actions\/[a-z-]+@[a-f0-9]{40}$/);
 const upload=steps.find(s=>s.uses?.startsWith('actions/upload-pages-artifact@'));
 assert.equal(upload.with.path,'${{ steps.build.outputs.directory }}');
 assert.equal(upload.with['include-hidden-files'],true);
});

test('paid search HTTP factory was removed; evidence and ledger parsers still readable',async()=>{
 const sources=await import('../src/services/searchSources.js');
 assert.equal(sources.makeSearchSources,undefined);assert.equal(typeof sources.safeSearchLink,'function');
 const source=await fs.readFile(new URL('../src/services/searchSources.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/open\.bigmodel\.cn|serpapi\.com\/|fetchImpl|process\.env/);
});
