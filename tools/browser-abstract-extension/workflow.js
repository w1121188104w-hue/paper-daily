import {workflowRequest,workflowFailure,saveRun,storedRun,detailKey} from './workflow-client.js';
import {startLocalServices} from './service-launcher.js';
import {summarizePending} from './pending-summary.js';
const $=id=>document.getElementById(id);let refreshing=false,starting=false;
async function continueRun(id){
  const details=(await chrome.storage.local.get(detailKey(id)))[detailKey(id)];
  const run=await storedRun(id);
  location.href=details&&run.scope!=='catalog'?`dashboard.html?queue=catalog&autostart=1&run=${id}`:`catalog.html?autostart=1&run=${id}`;
}
async function refresh(){
  if(refreshing)return;refreshing=true;let stage='request';
  try{const s=await workflowRequest('/status');stage='render';
    if(s.version!==2)throw Object.assign(Error('请重启 start-workflow.cmd 更新本地服务，Key 不需要重配。'),{code:'VERSION'});
    const pending=summarizePending(s.workflow);
    $('status').textContent=`已连接。待处理目录 ${s.workflow.tasks.length} 个；待补摘要 ${pending.abstracts} 篇；仅缺其他信息 ${pending.otherOnly} 篇。${s.busy?'后台正在安全处理已提交结果。':''}`;
    const p=s.python,phases={idle:'尚未启动',starting:'正在启动',running:'正在采集',paused:'已暂停',interrupted:'运行中断，可继续',captured:'本轮采集结束'};
    $('python-status').textContent=!p?'请更新并重启本机服务以启用 Python。':!p.available?'本机 Python 环境尚未配置。请运行项目的 setup-local-python.cmd。':
      `${phases[p.phase]||p.phase} · 已采集 ${p.completed||0}/${p.total||0} 页 · 已审核 ${p.review_done||0}/${p.review_total||0} 项 · 待审核 ${p.review_pending||0} 项 · 疑难记录 ${p.remaining||0} 项${p.current?' · 当前 '+p.current.journal+' '+(p.current.title||'目录'):''}`;
    if(p?.review_error)$('python-status').textContent+=' · '+({REVIEW_BUSY:'DeepSeek 正在处理其他内容，稍后自动继续',REVIEW_LIMIT:'审核额度已用完，已采集内容保留',REVIEW_SERVICE_UNAVAILABLE:'等待审核服务连接，恢复后自动继续'}[p.review_error]||'审核待恢复');
    $('python-start').disabled=!p?.available||p.running||starting||s.busy||p.id&&!['idle','captured'].includes(p.phase);
    $('python-pause').disabled=!p?.running;
    $('python-resume').disabled=!p?.available||p.running||!['paused','interrupted'].includes(p.phase);
    $('python-fallback').disabled=!p?.id||p.running||s.busy;
    for(const id of ['daily','full','catalog-only','catalog-full'])$(id).disabled=s.busy||starting;
    const due=(s.workflow.catalog_checks||[]).filter(c=>c.status!=='recently_checked');
    $('audit').textContent=due.length?`${due.length} 个目录尚无基线或已到巡检期；可按需全刊巡检。`:'暂无到期目录。没有提醒不代表没有新论文，定期巡检用于补漏。';
    $('tasks').replaceChildren(...s.workflow.tasks.map(t=>{const p=document.createElement('p');p.textContent=`${t.journal} · ${t.collection==='issue'?'最新一期':'在线发表'} · ${t.signal_count} 条发现线索`;return p;}));
    $('runs').replaceChildren(...s.runs.map(r=>{const box=document.createElement('article'),p=document.createElement('p');
      p.textContent=`${r.scope==='catalog'?'仅补充目录':r.scope==='articles'?'Python 论文补采':r.mode==='full'?'全刊巡检':'增量采集'} · ${new Date(r.created_at).toLocaleString()} · ${r.message||r.phase}`;box.append(p);
      if(!r.has_export){const b=document.createElement('button');b.textContent='继续这次采集';b.disabled=s.busy;b.onclick=()=>continueRun(r.id);box.append(b);}
      if(r.scope==='catalog'&&r.has_export&&!r.parent_run_id){const b=document.createElement('button');b.textContent='启动 Python 采集剩余论文';b.disabled=s.busy||s.python?.running||!s.python?.available||s.python?.id&&!['idle','captured'].includes(s.python.phase);b.onclick=async()=>{b.disabled=true;try{await workflowRequest('/python/start',{scope:'articles',catalog_run_id:r.id});await refresh();}catch(e){$('python-status').textContent=e.message;b.disabled=false;}};box.append(b);}
      if(r.phase==='failed'){const b=document.createElement('button');b.textContent='恢复后台处理';b.disabled=s.busy;b.onclick=async()=>{await workflowRequest('/finish',{id:r.id});await refresh();};box.append(b);}
      return box;}));
  }catch(e){$('status').textContent=e.code==='VERSION'?e.message:workflowFailure(e,stage);$('python-status').textContent='本机采集服务未连接，请点击上方“启动本机服务”。';for(const id of ['daily','full','catalog-only','catalog-full'])$(id).disabled=true;for(const action of ['start','pause','resume','fallback'])$('python-'+action).disabled=true;}
  finally{refreshing=false;}
}
for(const id of ['daily','full','catalog-only','catalog-full'])$(id).onclick=async()=>{
  if(starting)return;starting=true;for(const id of ['daily','full','catalog-only','catalog-full'])$(id).disabled=true;$('status').textContent='同步正式库，建立去重后的增量任务……';
  const mode=['full','catalog-full'].includes(id)?'full':'daily',scope=id.startsWith('catalog-')?'catalog':'all';
  try{const {run}=await workflowRequest('/start',{mode,scope});await saveRun(run);
    if(!run.jobs.length){$('status').textContent='目前没有需要浏览器处理的目录。官网直读和 GitHub 翻译在后台自动运行。';return;}
    location.href=`catalog.html?autostart=1&run=${run.id}`;
  }catch(e){$('status').textContent=e.message;}finally{starting=false;void refresh();}
};
$('services-start').onclick=async()=>{
  $('services-start').disabled=true;$('services-status').textContent='正在启动本机采集与 DeepSeek 审核服务……';
  try{
    await startLocalServices();
    const deadline=Date.now()+45000;
    while(Date.now()<deadline){
      try{const responses=await Promise.all([[17328,'X-Paper-Workflow'],[17327,'X-Paper-Review']].map(async([port,guard])=>{
          const r=await fetch(`http://127.0.0.1:${port}/health`,{method:'POST',headers:{'Content-Type':'application/json',[guard]:'1'},body:'{}',signal:AbortSignal.timeout(3000)});
          return r.ok&&(await r.json()).status==='ready';
        }));
        if(responses.every(Boolean)){$('services-status').textContent='采集与原文审核服务已连接。可以启动 Python 补采，或继续已有任务。';await refresh();return;}
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw Error('服务仍在启动，请稍后刷新状态；已有数据已保留。');
  }catch(e){$('services-status').textContent=e.message;}
  finally{$('services-start').disabled=false;}
};
$('refresh').onclick=async()=>{try{await workflowRequest('/sync',{});await refresh();}catch(e){$('status').textContent=e.message;}};
for(const action of ['start','pause','resume','fallback'])$('python-'+action).onclick=async()=>{
  $('python-'+action).disabled=true;
  try{const result=await workflowRequest('/python/'+action,action==='start'?{mode:'daily'}:{});
    if(action==='fallback'){await saveRun(result.run);location.href=`catalog.html?autostart=1&run=${result.run.id}`;return;}
    await refresh();
  }catch(e){$('python-status').textContent='操作尚未完成，已有结果保留。'+e.message;}
};
void refresh();setInterval(()=>void refresh(),15000);
