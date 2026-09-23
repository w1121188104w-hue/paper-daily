import {workflowRequest,saveRun} from './workflow-client.js';
const $=id=>document.getElementById(id);
async function refresh(){
  try{const s=await workflowRequest('/status');$('status').textContent=`正式流程已连接。待检查目录 ${s.workflow.tasks.length} 个；待补论文 ${s.workflow.pending_papers.length} 篇。${s.busy?'正在导入/翻译/发布，请稍候。':''}`;
    $('daily').disabled=s.busy;$('full').disabled=s.busy;
    $('tasks').replaceChildren(...s.workflow.tasks.map(t=>{const p=document.createElement('p');p.textContent=`${t.journal} · ${t.collection==='issue'?'卷期目录':'在线发表'} · ${t.confidence==='paper_detected'?'数据源发现新论文':'疑似更新待核实'}`;return p;}));
    $('runs').replaceChildren(...s.runs.map(r=>{const box=document.createElement('article'),p=document.createElement('p');p.textContent=`${r.mode==='full'?'全刊巡检':'日常增量'} · ${r.created_at} · ${r.message||r.phase}`;box.append(p);
      const a=document.createElement('a');a.href=`catalog.html?run=${r.id}`;a.textContent='继续本批次目录';box.append(a);
      const detail=document.createElement('a');detail.href=`dashboard.html?queue=catalog&run=${r.id}`;detail.textContent=' · 继续详情/提交结果';box.append(detail);
      if(r.phase==='awaiting_publication'){const c=document.createElement('button');c.textContent='核验网站是否已上线';c.onclick=async()=>{try{await workflowRequest('/check-publication',{id:r.id});await refresh();}catch(e){$('status').textContent=e.message;}};box.append(c);}
      if(r.has_export){const b=document.createElement('button');b.textContent=r.phase==='published'&&r.pending_translation_fields?'继续待翻译字段并发布':'导入、翻译并发布';b.disabled=s.busy||r.phase==='awaiting_publication'||(r.phase==='published'&&!r.pending_translation_fields);b.onclick=async()=>{if(!confirm('将核对合格的本批次结果合并到正式库，最多调用 100 次 DeepSeek 翻译并发布网站？原文缺失项保留，线上自动任务仍暂停。'))return;
        try{await workflowRequest('/finish',{id:r.id});await refresh();}catch(e){$('status').textContent=e.message;}};box.append(b);}return box;}));
  }catch{$('status').textContent='未连接正式流程服务。请运行 start-workflow.cmd；不是重新配置 API Key。';$('daily').disabled=true;$('full').disabled=true;}
}
for(const mode of ['daily','full'])$(mode).onclick=async()=>{try{const {run}=await workflowRequest('/start',{mode});await saveRun(run);
  if(!run.jobs.length){$('status').textContent='目前没有待检查目录或到期补采项。可选择全刊巡检兜底。';return;}
  location.href=`catalog.html?run=${run.id}`;}catch(e){$('status').textContent=e.message;}};
$('refresh').onclick=async()=>{try{await workflowRequest('/sync',{});await refresh();}catch(e){$('status').textContent=e.message;}};void refresh();setInterval(refresh,15000);
