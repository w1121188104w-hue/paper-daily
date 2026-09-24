import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDiscoveryTestBudget} from '../src/services/discoveryTestBudget.js';
import {emptySearchBudget} from '../src/services/searchBudget.js';
test('100 cumulative across restarts; failed/unknown requests consume allowance',async()=>{
 let state=emptySearchBudget(),calls=0;
 const factory=()=>makeDiscoveryTestBudget({initialState:state,persist:async s=>state=structuredClone(s),request:async()=>{calls++;if(calls%2)throw Error('network');return {charged:1,leads:[]};}});
 let b=factory();for(let i=0;i<50;i++)await b.run({provider:'zhipu',query:'query '+i,taskId:'task '+i});
 b=factory();await Promise.all(Array.from({length:55},(_,i)=>b.run({provider:'zhipu',query:'query '+(50+i),taskId:'task '+(50+i)})));
 assert.equal(calls,100);assert.equal(state.requests.length,100);assert.equal(b.allowance().remaining,0);
 assert.equal((await factory().run({provider:'zhipu',query:'new month or key',taskId:'later'})).reason,'test_quota_exhausted');
});
test('checkpoint failures and non-Zhipu providers never reach paid API',async()=>{
 let calls=0;const b=makeDiscoveryTestBudget({initialState:emptySearchBudget(),persist:async()=>{throw Error('checkpoint');},request:async()=>calls++});
 await assert.rejects(b.run({provider:'zhipu',query:'test',taskId:'test'}));
 await assert.rejects(b.run({provider:'serpapi_google',query:'test',taskId:'test'}));assert.equal(calls,0);
});
