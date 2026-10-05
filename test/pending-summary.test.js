import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizePending} from '../tools/browser-abstract-extension/pending-summary.js';

test('abstracts and metadata-only counts are disjoint across legacy and field queues',()=>{
  const result=summarizePending({pending_papers:[{journal:'RP',doi:'10.1234/one'}],field_tasks:[
    {journal:'RP',doi:'https://doi.org/10.1234/ONE',missing_fields:['abstract','affiliations']},
    {journal:'RP',id:'doi:10.1234/two',missing_fields:['affiliations']},
    {journal:'RP',doi:'10.1234/three',missing_fields:['authors','publication_date']},
    {journal:'RP',doi:'10.1234/done',missing_fields:['abstract'],status:'complete'},
    {journal:'RP',doi:'10.1234/empty',missing_fields:[]}
  ]});
  assert.deepEqual(result,{abstracts:1,otherOnly:2,total:3});
});

test('same title with different DOIs does not collapse distinct papers',()=>{
  assert.equal(summarizePending({field_tasks:['one','two'].map(n=>({journal:'RP',doi:'10.1234/'+n,title:'Same title',missing_fields:['abstract']}))}).abstracts,2);
});
