import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowRequest,workflowFailure} from '../tools/browser-abstract-extension/workflow-client.js';

test('status uses POST with empty JSON, matching origin-preserving review health protocol',async()=>{
  const result=await workflowRequest('/status',undefined,async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:17328/status');
    assert.equal(options.method,'POST');assert.equal(options.body,'{}');
    assert.equal(options.headers['Content-Type'],'application/json');
    assert.equal(options.headers['X-Paper-Workflow'],'1');
    assert.equal(options.headers.Origin,undefined); // Origin is browser-controlled.
    return {ok:true,json:async()=>({busy:false})};
  });assert.deepEqual(result,{busy:false});
});
test('identity rejection, bad response and render failure are not mislabeled as service stopped',async()=>{
  for(const status of [403,409,500])await assert.rejects(workflowRequest('/status',undefined,async()=>({ok:false,status})),
    e=>e.code===`WORKFLOW_HTTP_${status}`&&!workflowFailure(e).includes('无法连接'));
  await assert.rejects(workflowRequest('/status',undefined,async()=>({ok:true,json:async()=>{throw Error('bad');}})),e=>e.code==='WORKFLOW_RESPONSE');
  await assert.rejects(workflowRequest('/status',undefined,async()=>{throw Error('offline');}),e=>e.code==='WORKFLOW_CONNECTION');
  assert.match(workflowFailure(Error('raw private details'),'render'),/服务已连接/);
  assert.ok(!workflowFailure(Error('raw private details')).includes('private'));
});
