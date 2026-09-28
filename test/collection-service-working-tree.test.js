import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedWorkflowDirty} from '../scripts/collection-service.js';

test('clean sync skips expensive history traversal; staged content still blocks it',async()=>{
  const plan=async()=>{throw Error('must not read historical payloads');};
  assert.equal((await allowedWorkflowDirty({}, {git:async()=>'',plan})).size,0);
  await assert.rejects(allowedWorkflowDirty({}, {git:async()=> 'user.txt\0',plan}),/暂存区/);
});
test('changed data requires a validated history plan; unrelated edits cannot enter publication',async()=>{
  let checks=0;
  const options={plan:async()=>{checks++;return {files:['data/journal-store/current.json']};},
    git:async args=>args.includes('--cached')?'':'data/journal-store/current.json\0'};
  assert.ok((await allowedWorkflowDirty({}, options)).has('data/journal-store/current.json'));
  assert.equal(checks,1);
  await assert.rejects(allowedWorkflowDirty({}, {...options,git:async args=>args.includes('--cached')?'':'src/user.js\0'}),/未提交代码/);
  await assert.rejects(allowedWorkflowDirty({}, {...options,plan:async()=>{throw Error('corrupt history');}}),/corrupt history/);
});
