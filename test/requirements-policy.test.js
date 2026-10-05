import test from 'node:test';
import assert from 'node:assert/strict';
import {onlineWindow,collectionScope,onlinePaginationStop} from '../tools/browser-abstract-extension/collection-policy.js';
import {summarizePending} from '../tools/browser-abstract-extension/pending-summary.js';
import {pendingWorkflowPapers,emptyWorkflow} from '../src/services/collectionWorkflow.js';
import {pendingFields} from '../src/services/collectionFieldTasks.js';
const now=new Date('2026-10-05T13:00:00Z');
test('two calendar months use Shanghai day, inclusive bounds and month-end clipping',()=>{
  assert.deepEqual(onlineWindow(now),{from:'2026-08-05',to:'2026-10-05'});
  assert.deepEqual(onlineWindow(new Date('2026-04-29T17:00:00Z')),{from:'2026-02-28',to:'2026-04-30'});
  const p={catalog_collection:'online'};
  for(const date of ['2026-08-05','2026-10-05'])assert.equal(collectionScope({...p,published_online_date:date},now).eligible,true);
  for(const date of ['2026-08-04','2026-10-06'])assert.equal(collectionScope({...p,published_online_date:date},now).eligible,false);
  assert.equal(collectionScope({...p,published_online_date:'2026-08'},now).needs_review,true);
  assert.equal(collectionScope({...p,publication_date:'2026-10-05',first_seen_date:'2026-10-05'},now).status,'online_date_missing');
  assert.equal(collectionScope({...p,catalog_memberships:[{collection:'issue'}],published_online_date:'2025-01-01'},now).eligible,true);
});
test('stop only proven descending online pagination, never a mixed page or an issue',()=>{
  const page={sort_order:'first_online_desc',items:['2026-07-02','2026-07-01'].map(published_online_date=>({published_online_date}))};
  assert.equal(onlinePaginationStop(page,{collection:'online'},now),true);
  assert.equal(onlinePaginationStop({...page,sort_order:null},{collection:'online'},now),false);
  assert.equal(onlinePaginationStop(page,{collection:'issue'},now),false);
  assert.equal(onlinePaginationStop({...page,items:[page.items[0],{published_online_date:'2026-09-01'}]},{collection:'online'},now),false);
});
test('DOI-less and DOI tasks resolve by article URL without conflating different DOIs',()=>{
  const p={journal:'RP',url:'https://www.sciencedirect.com/science/article/pii/S1234',title:'A research paper'},withDoi={...p,doi:'10.1234/one'};
  assert.equal(summarizePending({pending_papers:[p,withDoi]}).abstracts,1);
  assert.equal(summarizePending({pending_papers:[p,withDoi],known_papers:[{...withDoi,complete:true}]}).abstracts,0);
  assert.equal(summarizePending({pending_papers:[withDoi,{...withDoi,doi:'10.1234/two'}]}).abstracts,2);
  const state=emptyWorkflow();state.receipts=[{pending_papers:[p,withDoi]}];
  assert.equal(pendingWorkflowPapers(state,[{...withDoi,id:'doi:10.1234/one',journal_key:'RP',abstract_original:'Already saved'}]).length,0);
});
test('other missing fields never trigger supplementation; type alone does not prove absence',()=>{
  assert.deepEqual(pendingFields({abstract_original:'Existing',authors:[],type:'journal-article'}),[]);
  assert.deepEqual(pendingFields({abstract_original:'',authors:[],type:'correction'}),['abstract']);
  assert.deepEqual(pendingFields({abstract_original:'',abstract_status:'confirmed_absent'}),[]);
  const summary=summarizePending({pending_papers:[{journal:'RP',doi:'10.1234/a',processing_stage:'awaiting_review'}]});
  assert.equal(summary.abstracts,0);assert.equal(summary.stages.awaiting_review,1);
});
