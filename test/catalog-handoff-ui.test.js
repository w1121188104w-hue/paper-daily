import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {CatalogEngine} from '../tools/browser-abstract-extension/catalog-engine.js';
import {ACTIVE_CATALOG_TASKS,mergeCatalog} from '../tools/browser-abstract-extension/catalog-core.js';

// Execute the actual dashboard with browser storage/transport doubles. This
// catches accidental detail navigation and loss of the catalog review payload.
test('catalog-only dashboard submits catalog reviews, stays on results and hands off only on click',async()=>{
  const id='11111111-1111-1111-1111-111111111111',task=ACTIVE_CATALOG_TASKS[0],requests=[],elements=new Map(),storage={},timers=[];
  const element=()=>({disabled:false,hidden:false,value:'all',textContent:'',children:[],append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},addEventListener(){}});
  const document={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},querySelector:()=>element(),createElement:element,createTextNode:text=>({text})};
  const run={id,scope:'catalog',jobs:[{catalog_id:task.id,url:task.url}]};
  const state={schema_version:1,mode:'done',reason:'done',pages:[{task_id:task.id,items:[],status:'catalog_empty',source_url:task.url,requested_url:task.url,captured_at:new Date().toISOString()}],queue:[{task_id:task.id,url:task.url,depth:0}],cursor:1,history:[],scope_task_ids:[task.id]};
  storage.catalog=state;
  const cache={proof:{input:{kind:'catalog'},verdict:{status:'source_checked_candidate'}}};
  const location={href:'catalog.html?run='+id,replace(url){this.href=url;}};
  const context=vm.createContext({document,location,history:{replaceState(){}},URL,Blob,structuredClone,Date,console,
    setTimeout,clearTimeout,setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval(){},
    window:{addEventListener(){}},navigator:{locks:{request:async(name,options,fn)=>fn({})}},
    chrome:{runtime:{id:'test',getManifest:()=>({version:'test'}),onMessage:{addListener(){},removeListener(){}}},
      storage:{local:{get:async key=>({[key]:storage[key]}),set:async rows=>Object.assign(storage,rows)},session:{get:async()=>({}),set:async()=>{}},onChanged:{addListener(){},removeListener(){}}},
      tabs:{onRemoved:{addListener(){},removeListener(){}}}},
    ACTIVE_CATALOG_TASKS,mergeCatalog,CatalogEngine,workflowId:()=>id,storedRun:async()=>run,catalogKey:()=> 'catalog',REVIEW_KEY:'reviews',
    readCatalogDocument(){},makeReviewJobs:()=>({jobs:[]}),prepareReviewPlan:async()=>({jobs:[]}),reviewedCatalogPapers:()=>[],reviewFingerprint:async()=>'',
    mountAutoReview:()=>({close(){},reset(){},stop(){},tick(){},isRunning:()=>false,getState:()=>({phase:'done'}),export:async()=>({ai_review_results:cache})}),
    workflowRequest:async(endpoint,body)=>{requests.push({endpoint,body});if(endpoint==='/status')return {busy:false,python:{available:true,phase:'idle'}};return {phase:'processing'};}
  });
  const source=(await fs.readFile(new URL('../tools/browser-abstract-extension/catalog-dashboard.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  vm.runInContext(source,context);
  for(let n=0;n<40&&!requests.some(r=>r.endpoint==='/status');n++)await new Promise(r=>setImmediate(r));
  const submitted=requests.find(r=>r.endpoint==='/submit');assert.ok(submitted);
  assert.deepEqual(submitted.body.data.catalog_review_results,cache);
  assert.equal(submitted.body.data.records.length,0);
  assert.equal(requests.some(r=>r.endpoint==='/python/start'),false);
  assert.equal(location.href,'catalog.html?run='+id);
  assert.equal(elements.get('python-remaining').disabled,false);
  await elements.get('python-remaining').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(requests.find(r=>r.endpoint==='/python/start').body)),{scope:'articles',catalog_run_id:id});
  assert.equal(location.href,'workflow.html');
});
