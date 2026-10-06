import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionActivity,mergeDiscoveryHistory,validateDiscoveryHistory} from '../src/services/collectionActivity.js';
import {collectionStatusForDay,latestCollectionActivity} from '../public/journals/viewModel.js';
import {discoverIndexedCollectionTasks} from '../src/services/collectionDiscovery.js';
import {emptyWorkflow} from '../src/services/collectionWorkflow.js';
import {loadJournalConfig} from '../src/services/journals.js';

const checked='2026-10-05T01:00:00.000Z';
const check=(source,status='ok',at=checked)=>({journal:'AER',source,status,checked_at:at});
const capture={date:'2026-10-05',journal_key:'AER',captured_at:checked,paper_count:1,catalog_count:0};
test('publisher evidence uses actual capture day, deduplicates papers, excludes import time and raw evidence',()=>{
  const source={source:'publisher',source_evidence:{fetched_at:'2026-10-04T16:10:00Z',body:'PRIVATE'}};
  const papers=[{id:'one',journal_key:'AER',first_seen_date:'2026-10-07',last_checked_at:'2026-10-07T00:00:00Z',source_records:[source,source]},
    {id:'two',journal_key:'AER',source_records:[{source:'publisher',last_checked_at:checked},{source:'crossref',source_evidence:{fetched_at:checked}}]},
    {id:'other',journal_key:'UNKNOWN',source_records:[source]}];
  const rows=collectionActivity(papers,[],['AER']);
  assert.deepEqual(rows,[{date:'2026-10-05',journal_key:'AER',captured_at:'2026-10-04T16:10:00.000Z',paper_count:1,catalog_count:0}]);
  assert.doesNotMatch(JSON.stringify(rows),/PRIVATE|2026-10-07/);
});
test('verified empty catalog counts as a capture; invalid times and incomplete baselines do not',()=>{
  const base={journal:'AER',catalog_id:'aer',url:'https://example.test/catalog',checked_at:checked,papers:[],complete:true};
  assert.equal(collectionActivity([], [base,base,{...base,checked_at:'invalid'},{...base,checked_at:'2026-10-06T00:00:00Z',complete:false}],['AER'])[0].catalog_count,1);
});
test('discovery history retains real days and later failures, with only public status fields',()=>{
  const rows=mergeDiscoveryHistory([check('crossref'),check('openalex')],[{...check('crossref','failed','2026-10-05T04:00:00Z'),raw:'PRIVATE'},
    check('crossref','ok','2026-10-05T17:00:00Z'),check('search','disabled')]);
  assert.equal(rows.length,3);assert.equal(rows.find(r=>r.checked_at==='2026-10-05T04:00:00.000Z').status,'failed');
  assert.doesNotMatch(JSON.stringify(rows),/PRIVATE|disabled/);
  assert.throws(()=>validateDiscoveryHistory([{...rows[0],status:'invented'}]));
});
test('new source checks and publisher captures fix missing old runs without inventing complete collection',()=>{
  const data={runs:[],collection_activity:[capture],discovery_checks:[check('crossref'),check('openalex','failed')]};
  const result=collectionStatusForDay(data,'2026-10-05',['AER']);
  assert.equal(result.captured,1);assert.equal(result.complete,0);assert.equal(result.failed,1);
  assert.equal(result.label,'已采集，部分来源失败');
  assert.equal(collectionStatusForDay(data,'2026-10-07',['AER']).label,'暂无采集记录');
  assert.equal(collectionStatusForDay(data,'2026-10-05',['JF']).label,'暂无采集记录');
  assert.equal(collectionStatusForDay({...data,discovery_checks:[]},'2026-10-05',['AER','JF']).label,'已采集（部分期刊）');
  assert.equal(latestCollectionActivity({...data,snapshot_at:'2026-10-07T10:00:00Z'}).date,'2026-10-05');
});
test('legacy failures stay visible; successful empty index responses count as completed source checks',()=>{
  const data={runs:[{run_date:'2026-10-05',started_at:'2026-10-05T05:00:00Z',status:'full_failure',journal_keys:['AER'],sources:[]}],
    discovery_checks:[check('crossref'),check('openalex')]};
  assert.equal(collectionStatusForDay(data,'2026-10-05',['AER']).failed,1);
  assert.equal(collectionStatusForDay({...data,runs:[]},'2026-10-05',['AER']).complete,1);
});
test('discovery persists history for each journal before later review can interrupt the run',async()=>{
  const config=await loadJournalConfig();config.journals=config.journals.filter(j=>j.key==='AER');
  const previous={...emptyWorkflow(),monitors:[check('crossref'),check('openalex')]};
  let checkpoint;
  const state=await discoverIndexedCollectionTasks(config,previous,[],{now:new Date('2026-10-06T01:00:00Z'),
    collect:async()=>({source_results:[{source:'crossref',ok:true,complete:true,records:[]},{source:'openalex',ok:false,records:[]}]}),
    onJournal:async s=>{checkpoint=structuredClone(s);}});
  assert.equal(state.discovery_history.length,5);assert.deepEqual(checkpoint.discovery_history,state.discovery_history);
  assert.equal(state.discovery_history.filter(r=>r.checked_at.startsWith('2026-10-05')).length,2);
});
