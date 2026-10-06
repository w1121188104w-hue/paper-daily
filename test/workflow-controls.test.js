import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=(await fs.readFile(new URL('../tools/browser-abstract-extension/workflow.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');

function element(){return {disabled:false,textContent:'',children:[],append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;}};}
async function panel(state){
  const nodes=new Map(),calls=[],saved=[];
  const context=vm.createContext({
    document:{getElementById:id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},createElement:element},
    workflowRequest:async(endpoint,body)=>{calls.push({endpoint,body});return endpoint==='/start'?{run:{id:'new-capture',jobs:[{}]}}:state;},
    summarizePending:()=>({abstracts:87,otherOnly:0}),workflowFailure:()=> 'failed',
    saveRun:async run=>saved.push(run),location:{href:''},setInterval:()=>{},
  });
  vm.runInContext(source,context);await new Promise(resolve=>setImmediate(resolve));
  return {nodes,calls,saved,context};
}
const status=()=>({version:2,busy:true,capture_busy:false,workflow:{tasks:[],catalog_checks:[]},
  python:{available:true,id:'old-run',running:false,phase:'captured',review_pending:0},
  runs:[{id:'capture',scope:'catalog',phase:'collecting',created_at:'2026-10-06T08:00:00Z',has_export:false},
    {id:'upload',phase:'failed',created_at:'2026-10-06T08:00:00Z',has_export:true}]});

test('actual panel permits new capture during publication and refresh never initiates Git sync',async()=>{
  const {nodes,calls,saved,context}=await panel(status());
  for(const id of ['daily','full','catalog-only','catalog-full','python-start','python-fallback'])assert.equal(!!nodes.get(id).disabled,false,id);
  const rows=nodes.get('runs').children;
  assert.equal(rows[0].children[1].disabled,false,'existing capture can continue');
  assert.equal(rows[1].children[1].disabled,true,'formal publication remains protected');
  await nodes.get('refresh').onclick();assert.ok(calls.every(call=>call.endpoint==='/status'));
  await nodes.get('catalog-only').onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual({...calls.find(call=>call.endpoint==='/start').body},{mode:'daily',scope:'catalog'});
  assert.equal(saved.length,1);assert.equal(context.location.href,'catalog.html?autostart=1&run=new-capture');
});

test('panel blocks competing creation and keeps conservative compatibility with older services',async()=>{
  for(const state of [{...status(),capture_busy:true},(()=>{const s=status();delete s.capture_busy;return s;})()]){
    const {nodes}=await panel(state);
    for(const id of ['daily','full','catalog-only','catalog-full','python-start'])assert.equal(!!nodes.get(id).disabled,true,id);
  }
});
