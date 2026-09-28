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
 const probe=await fs.readFile(new URL('../.github/workflows/discovery-search-probe-v2.yml',import.meta.url),'utf8');
 assert.match(probe,/if: \$\{\{ false \}\}/);
});
