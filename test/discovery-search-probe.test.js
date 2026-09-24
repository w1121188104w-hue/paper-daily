import test from 'node:test';
import assert from 'node:assert/strict';
import {runDiscoveryProbe,PROBE_JOURNALS} from '../scripts/discovery-search-probe.js';
import {emptySearchBudget} from '../src/services/searchBudget.js';
test('manual probe is bounded, uses Pro, checkpoints quota, never imports or translates',async()=>{
  let calls=0,checkpoints=0,saved;
  const report=await runDiscoveryProbe({env:{GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REPOSITORY:'w1121188104w-hue/paper-daily',ZHIPU_API_KEY:'dummy-key-for-test'},
    configLoader:async()=>({journals:PROBE_JOURNALS.map(key=>({key,name:'Journal '+key,enabled:true}))}),libraryLoader:async()=>({papers:[]}),
    sourceFactory:o=>{assert.equal(o.zhipuEngine,'search_pro');return {account:async()=>{throw Error('no verified free account');},request:async()=>{assert.ok(checkpoints>calls);calls++;return {charged:1,leads:[]};}};},
    ledgerFactory:()=>({read:async()=>emptySearchBudget(),persist:async()=>{checkpoints++;}}),save:async r=>saved=structuredClone(r),log:()=>{}});
  assert.equal(calls,6);assert.equal(report.requests.length,18);assert.equal(report.actual_search_calls,6);
  assert.equal(report.papers_changed,0);assert.equal(report.translation_calls,0);assert.equal(report.website_deployed,false);
  assert.equal(JSON.stringify(saved).includes('dummy-key-for-test'),false);
});
test('probe refuses accidental local or scheduled invocation before credential use',async()=>{
  await assert.rejects(runDiscoveryProbe({env:{},sourceFactory:()=>{throw Error('must not execute');}}));
});
test('explicit local probe is Pro-only; failed ledger blocks every paid request',async()=>{
  let requests=0;
  const base={local:true,env:{PAPER_DISCOVERY_LOCAL_TEST:'1',LOCALAPPDATA:'local-test',ZHIPU_API_KEY:'dummy-local-key'},
    configLoader:async()=>({journals:PROBE_JOURNALS.map(key=>({key,name:'Journal '+key,enabled:true}))}),libraryLoader:async()=>({papers:[]}),
    sourceFactory:()=>({account:async()=>{throw Error('must not check SerpAPI');},request:async o=>{assert.equal(o.provider,'zhipu');requests++;return {charged:1,leads:[]};}}),log:()=>{}};
  await assert.rejects(runDiscoveryProbe({...base,ledgerFactory:()=>({read:async()=>{throw Error('ledger unavailable');}})}));
  assert.equal(requests,0);
  const report=await runDiscoveryProbe({...base,ledgerFactory:()=>({read:async()=>emptySearchBudget(),persist:async()=>{}})});
  assert.equal(requests,6);assert.equal(report.requests.filter(r=>r.reason==='local_probe_zhipu_only').length,12);
});
