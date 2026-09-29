import {workflowRequest,workflowFailure,saveRun,detailKey} from './workflow-client.js';
const $=id=>document.getElementById(id);let refreshing=false,starting=false;
async function continueRun(id){
  const details=(await chrome.storage.local.get(detailKey(id)))[detailKey(id)];
  location.href=details?`dashboard.html?queue=catalog&autostart=1&run=${id}`:`catalog.html?autostart=1&run=${id}`;
}
async function refresh(){
  if(refreshing)return;refreshing=true;let stage='request';
  try{const s=await workflowRequest('/status');stage='render';
    if(s.version!==2)throw Object.assign(Error('请重启 start-workflow.cmd 更新本地服务，Key 不需要重配。'),{code:'VERSION'});
    $('status').textContent=`已连接。待处理目录 ${s.workflow.tasks.length} 个；待补论文 ${s.workflow.pending_papers.length} 篇。${s.busy?'后台正在安全处理已提交结果。':''}`;
    $('daily').disabled=s.busy||starting;$('full').disabled=s.busy||starting;
    const due=(s.workflow.catalog_checks||[]).filter(c=>c.status!=='recently_checked');
    $('audit').textContent=due.length?`${due.length} 个目录尚无基线或已到巡检期；可按需全刊巡检。`:'暂无到期目录。没有提醒不代表没有新论文，定期巡检用于补漏。';
    $('tasks').replaceChildren(...s.workflow.tasks.map(t=>{const p=document.createElement('p');p.textContent=`${t.journal} · ${t.collection==='issue'?'最新一期':'在线发表'} · ${t.signal_count} 条发现线索`;return p;}));
    $('runs').replaceChildren(...s.runs.map(r=>{const box=document.createElement('article'),p=document.createElement('p');
      p.textContent=`${r.mode==='full'?'全刊巡检':'增量采集'} · ${new Date(r.created_at).toLocaleString()} · ${r.message||r.phase}`;box.append(p);
      if(!r.has_export){const b=document.createElement('button');b.textContent='继续这次采集';b.disabled=s.busy;b.onclick=()=>continueRun(r.id);box.append(b);}
      if(r.phase==='failed'){const b=document.createElement('button');b.textContent='恢复后台处理';b.disabled=s.busy;b.onclick=async()=>{await workflowRequest('/finish',{id:r.id});await refresh();};box.append(b);}
      return box;}));
  }catch(e){$('status').textContent=e.code==='VERSION'?e.message:workflowFailure(e,stage);$('daily').disabled=true;$('full').disabled=true;}
  finally{refreshing=false;}
}
for(const mode of ['daily','full'])$(mode).onclick=async()=>{
  if(starting)return;starting=true;$('daily').disabled=true;$('full').disabled=true;$('status').textContent='同步正式库，建立去重后的增量任务……';
  try{const {run}=await workflowRequest('/start',{mode});await saveRun(run);
    if(!run.jobs.length){$('status').textContent='目前没有需要浏览器处理的目录。官网直读和 GitHub 翻译在后台自动运行。';return;}
    location.href=`catalog.html?autostart=1&run=${run.id}`;
  }catch(e){$('status').textContent=e.message;}finally{starting=false;$('daily').disabled=false;$('full').disabled=false;}
};
$('refresh').onclick=async()=>{try{await workflowRequest('/sync',{});await refresh();}catch(e){$('status').textContent=e.message;}};
void refresh();setInterval(()=>void refresh(),15000);
