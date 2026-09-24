import test from 'node:test';
import assert from 'node:assert/strict';
import {assessDiscoveryLead,issueRank} from '../src/services/discoveryLead.js';
import {ACTIVE_CATALOG_TASKS} from '../tools/browser-abstract-extension/catalog-core.js';
import {emptyWorkflow} from '../src/services/collectionWorkflow.js';
function assess(key,url,baseline){
 const catalogs=ACTIVE_CATALOG_TASKS.filter(t=>t.journal===key),issue=catalogs.find(t=>t.collection==='issue');
 return assessDiscoveryLead({url,title:'Example',snippet:''},{journal:{key,name:issue.name},catalogs,state:emptyWorkflow(),papers:baseline?[{journal_key:key,catalog_memberships:[{task_id:issue.id,catalog_url:baseline}]}]:[]});
}
test('Wiley old and equal issues do not alert, newer issue does',()=>{
 const base='https://onlinelibrary.wiley.com/toc/1475679x/2026/64/4';
 assert.equal(assess('JAR',base.replace('/64/4','/64/3'),base).reason,'known_or_older_issue');
 assert.equal(assess('JAR',base,base).reason,'known_or_older_issue');
 assert.equal(assess('JAR',base.replace('/64/4','/64/5'),base).reason,'newer_issue_candidate');
});
test('online directory is online but its existence alone is not a new article',()=>{
 const out=assess('JAR','https://onlinelibrary.wiley.com/toc/1475679x/0/0');
 assert.equal(out.collection,'online');assert.equal(out.task,undefined);
});
test('Springer concrete route is ranked; unknown baseline never fabricates newness',()=>{
 const url='https://link.springer.com/journal/41267/volumes-and-issues/57-8';
 assert.equal(assess('JIBS',url).reason,'issue_baseline_missing');
 assert.equal(assess('JIBS',url,url.replace('57-8','57-7')).reason,'newer_issue_candidate');
 assert.equal(assess('JIBS',url,url).reason,'known_or_older_issue');
});
test('invalid and foreign URLs cannot produce a task',()=>{
 assert.equal(assess('JAR','not a url').reason,'invalid_url');
 const task=ACTIVE_CATALOG_TASKS.find(t=>t.journal==='JAR');
 assert.equal(issueRank('https://evil.example/toc/1475679x/2026/64/5',task),null);
 assert.equal(assess('JAR','https://evil.example/toc/1475679x/2026/64/5').task,undefined);
});
