import test from 'node:test';
import assert from 'node:assert/strict';
import {assessDiscoveryLead,issueRank} from '../src/services/discoveryLead.js';
import {ACTIVE_CATALOG_TASKS} from '../tools/browser-abstract-extension/catalog-core.js';
import {emptyWorkflow} from '../src/services/collectionWorkflow.js';
import {discoverCollectionTasks} from '../src/services/collectionDiscovery.js';
import fs from 'node:fs';
function assess(key,url,baseline){
 const catalogs=ACTIVE_CATALOG_TASKS.filter(t=>t.journal===key),issue=catalogs.find(t=>t.collection==='issue');
 return assessDiscoveryLead({url,title:'Example',snippet:''},{journal:{key,name:issue.name},catalogs,state:emptyWorkflow(),papers:[],baselines:baseline?[{catalog_id:issue.id,rank:issueRank(baseline,issue)}]:[]});
}
test('one paper in an issue does not certify a complete catalog',()=>{
 const catalogs=ACTIVE_CATALOG_TASKS.filter(t=>t.journal==='JAR'),issue=catalogs.find(t=>t.collection==='issue');
 const url='https://onlinelibrary.wiley.com/toc/1475679x/2026/64/5';
 const out=assessDiscoveryLead({url,title:'Example',snippet:''},{journal:{key:'JAR',name:issue.name},catalogs,state:emptyWorkflow(),papers:[{journal_key:'JAR',catalog_memberships:[{task_id:issue.id,catalog_url:url}]}]});
 assert.equal(out.reason,'issue_baseline_missing');
});
test('Wiley old and equal issues do not alert, newer issue does',()=>{
 const base='https://onlinelibrary.wiley.com/toc/1475679x/2026/64/4';
 assert.equal(assess('JAR',base.replace('/64/4','/64/3'),base).reason,'known_or_older_issue');
 assert.equal(assess('JAR',base,base).reason,'known_or_older_issue');
 assert.equal(assess('JAR',base.replace('/64/4','/64/5'),base).reason,'newer_issue_candidate');
});

test('issue discovery compares the year before a reset volume/issue number',()=>{
 const c=context('JAR');c.baselines=[{catalog_id:c.catalogs.find(t=>t.collection==='issue').id,rank:[64,12],issue_year:'2026'}];
 const lead={url:'https://onlinelibrary.wiley.com/toc/1475679x/2027/1/1',title:'Journal of Accounting Research',snippet:''};
 assert.equal(assessDiscoveryLead(lead,c).reason,'newer_issue_candidate');
 assert.equal(assessDiscoveryLead({...lead,url:'https://onlinelibrary.wiley.com/toc/1475679x/2025/65/1'},c).reason,'known_or_older_issue');
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
function context(key){return {journal:{key,name:ACTIVE_CATALOG_TASKS.find(t=>t.journal===key).name},catalogs:ACTIVE_CATALOG_TASKS.filter(t=>t.journal===key),state:emptyWorkflow(),papers:[],now:new Date('2026-09-24T00:00:00Z')};}
test('current catalog compares explicit volume/issue evidence, including SAGE alias',()=>{
 const c=context('JM');c.baselines=[{catalog_id:'catalog-jm-issue',rank:[52,6]}];
 const lead={url:'https://journals.sagepub.com/toc/JOM/current',title:'Journal of Management - Volume 52, Number 7',snippet:''};
 assert.equal(assessDiscoveryLead(lead,c).reason,'newer_issue_candidate');
 c.baselines[0].rank=[52,7];assert.equal(assessDiscoveryLead(lead,c).reason,'known_or_older_issue');
 assert.equal(assessDiscoveryLead({...lead,snippet:'Volume 51, Number 2'},c).task,undefined);
});
test('bibliography journal mentions and old articles cannot trigger new paper reminders',()=>{
 const c=context('JAR');
 assert.equal(assessDiscoveryLead({url:'https://onlinelibrary.wiley.com/doi/abs/10.1111/1911-3846.12474',title:'Unrelated',snippet:'Journal of Accounting Research First published: 1 September 2026'},c).reason,'article_identity_unconfirmed');
 const lead={url:'https://onlinelibrary.wiley.com/doi/abs/10.1111%252F1475-679X.12545',title:'Real title',snippet:'Journal of Accounting Research First published: 1 September 2020'};
 assert.equal(assessDiscoveryLead(lead,c).reason,'old_or_future_article');
 lead.snippet='Journal of Accounting Research First published: 20 September 2026';
 assert.equal(assessDiscoveryLead(lead,c).doi,'10.1111/1475-679x.12545');
 assert.equal(assessDiscoveryLead(lead,c).reason,'new_article_candidate');
 c.papers=[{journal_key:'JAR',doi:'10.1111/1475-679x.12545'}];
 assert.equal(assessDiscoveryLead(lead,c).reason,'known_article');
});
test('missing dates and incomplete identities remain unconfirmed, not new',()=>{
 const c=context('MS');
 assert.equal(assessDiscoveryLead({url:'https://pubsonline.informs.org/doi/abs/10.1287/mnsc.32.5.622',title:'Old article',snippet:'Management Science'},c).reason,'article_recency_unconfirmed');
});
test('Elsevier volume-only supplement C routes compare as whole volumes',()=>{
 const c=context('JFE');c.baselines=[{catalog_id:'catalog-jfe-issue',rank:[185,0]}];
 const lead={url:'https://www.sciencedirect.com/journal/journal-of-financial-economics/vol/180/suppl/C',title:'Journal of Financial Economics',snippet:'Volume 180'};
 assert.equal(assessDiscoveryLead(lead,c).reason,'known_or_older_issue');
 assert.equal(assessDiscoveryLead({...lead,url:lead.url.replace('/180/','/186/')},c).reason,'newer_issue_candidate');
});
test('Oxford DOI has journal segment but not numeric article identifier',()=>{
 const c=context('RES');c.papers=[{journal_key:'RES',doi:'10.1093/restud/rdaf012'}];
 const lead={url:'https://academic.oup.com/restud/advance-article/doi/10.1093/restud/rdaf012/123456',title:'Example',snippet:'The Review of Economic Studies'};
 assert.equal(assessDiscoveryLead(lead,c).reason,'known_article');
});
