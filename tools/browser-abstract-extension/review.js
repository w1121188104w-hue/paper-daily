import {REVIEW_KEY,bridgeHealth} from './review-client.js';
const $=id=>document.getElementById(id);let results={};
$('extension-id').textContent=chrome.runtime.id;
async function load(){
  results=(await chrome.storage.local.get(REVIEW_KEY))[REVIEW_KEY]||{};
  $('counts').textContent='已保存 '+Object.keys(results).length+' 条原文核对记录。';
  $('results').replaceChildren(...Object.values(results).slice(-100).reverse().map(r=>{
    const box=document.createElement('details'),title=document.createElement('summary'),p=document.createElement('pre');
    title.textContent=r.input?.identity?.title||'核对记录';p.textContent=JSON.stringify({error:r.error||null,attempt:r.attempt||1,verdict:r.verdict},null,2);box.append(title,p);return box;
  }));
  $('status').textContent='显示最近 100 条；完整历史仍保存在本机。';
}
$('connection').onclick=async()=>{$('connection-status').textContent=(await bridgeHealth()).reason;};
$('load').onclick=()=>void load().catch(()=>{$('status').textContent='本地读取失败，原始记录保留。';});
$('export').onclick=()=>{const u=URL.createObjectURL(new Blob([JSON.stringify({kind:'paper_source_review',schema_version:1,results})],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download='paper-review-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),30000);};
void load();
