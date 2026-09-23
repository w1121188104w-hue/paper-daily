import { ACTIVE_CATALOG_TASKS as CATALOG_TASKS, catalogUrl } from './catalog-core.js';
import {safeSourceUrl} from './core.js';
const $ = id => document.getElementById(id);
let selectedTab,articleMode=false;
async function init() {
  [selectedTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tasks = CATALOG_TASKS.filter(t => catalogUrl(selectedTab?.url, t));
  for (const task of tasks) { const opt = document.createElement('option'); opt.value = task.id; opt.textContent = `${task.journal} · ${task.label}`; opt.selected = catalogUrl(selectedTab.url, task) === task.url; $('task').append(opt); }
  articleMode=!tasks.length && !!safeSourceUrl(selectedTab?.url);
  $('read').disabled = !tasks.length&&!articleMode;
  $('task').hidden=articleMode;
  $('message').textContent = tasks.length ? '请保留目录任务面板。仅读取你当前选中的这一页。' : '当前不是支持的期刊目录。请先手动打开官网目录。';
  if(articleMode)$('message').textContent='仅读取本页并核对是否为详情队列当前论文。请保留详情任务面板；手动标签页不会被改动。';
}
$('read').addEventListener('click', async () => {
  $('read').disabled = true;
  try {
    const reply = await chrome.runtime.sendMessage({ type: articleMode?'article-adopt-manual':'catalog-adopt-manual', tabId: selectedTab.id, taskId: $('task').value });
    $('message').textContent = reply?.message || '请先打开目录任务面板，再回到目录网页点击本按钮。';
  } catch { $('message').textContent = '请先打开目录任务面板并关闭其他助手面板，再回到目录网页点击本按钮。'; }
  finally { $('read').disabled = false; }
});
init().catch(() => { $('message').textContent = '无法读取当前网址，请确认扩展已获该网站权限。'; });
