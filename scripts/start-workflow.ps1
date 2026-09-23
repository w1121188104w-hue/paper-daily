param([switch]$Worker)
$ErrorActionPreference='Stop'
$project = Split-Path -Parent $PSScriptRoot
if (-not $Worker) {
  try {
    $existing = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 17328 -State Listen -ErrorAction SilentlyContinue
    if ($existing) { Write-Host 'Workflow service already listening. Open the extension formal workflow page.'; exit 0 }
    & (Join-Path $project 'tools/browser-abstract-extension/service-launch.ps1') -NoPrompt
    $process = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-Worker')
    for ($attempt=0; $attempt -lt 15; $attempt++) {
      Start-Sleep -Milliseconds 500
      if (Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 17328 -State Listen -ErrorAction SilentlyContinue) { Write-Host 'Workflow service ready. Open the extension formal workflow page.'; exit 0 }
      if ($process.HasExited) { throw 'START_FAILED' }
    }
    throw 'START_TIMEOUT'
  } catch { Write-Host 'Workflow service not ready. Existing data and encrypted key are unchanged.'; exit 1 }
}
try {
  . (Join-Path $project 'tools/browser-abstract-extension/review-config.ps1')
  $config = Read-PaperReviewConfig -Path (Join-Path $env:LOCALAPPDATA 'PaperDailyReviewBridge/config.clixml')
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($config.Secret)
  try { $env:DEEPSEEK_API_KEY=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$config.Secret.Dispose() }
  $env:PAPER_EXTENSION_ID=$config.ExtensionId
  $env:GIT_CONFIG_COUNT='3'
  $env:GIT_CONFIG_KEY_0='http.sslBackend';$env:GIT_CONFIG_VALUE_0='schannel'
  $env:GIT_CONFIG_KEY_1='http.version';$env:GIT_CONFIG_VALUE_1='HTTP/1.1'
  $env:GIT_CONFIG_KEY_2='credential.interactive';$env:GIT_CONFIG_VALUE_2='never'
  $proxy = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  if ($proxy.ProxyEnable -eq 1 -and $proxy.ProxyServer -match '^127\.0\.0\.1:[0-9]{2,5}$') {
    $env:GIT_CONFIG_COUNT='4';$env:GIT_CONFIG_KEY_3='http.proxy';$env:GIT_CONFIG_VALUE_3='http://'+$proxy.ProxyServer
  }
  $nodeCommand=Get-Command node -ErrorAction SilentlyContinue
  $nodeExecutable=if($nodeCommand){$nodeCommand.Source}else{Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'}
  & $nodeExecutable (Join-Path $PSScriptRoot 'collection-service.js')
  if ($LASTEXITCODE -ne 0) { throw 'SERVICE_EXITED' }
} catch { Write-Host 'WORKFLOW_SERVICE_FAILED: no credentials printed.'; exit 1 }
finally { Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue }
