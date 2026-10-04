export async function startLocalServices(runtime=chrome.runtime){
  let result;
  try{result=await runtime.sendNativeMessage('org.paper_daily.services',{action:'start_services'});}
  catch{throw Error('本机启动组件尚未连接。更新插件后请重新加载；首次安装需运行一次 start-workflow.cmd。');}
  if(!result?.ok)throw Error(result?.code==='START_TIMEOUT'?'启动响应超时，请稍后刷新状态。':'本机服务启动未完成，请检查安装配置后重试。');
  return result;
}
