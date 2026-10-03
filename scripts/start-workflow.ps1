param([switch]$Worker, [string]$DataRoot)
$ErrorActionPreference='Stop'
$project = Split-Path -Parent $PSScriptRoot
. (Join-Path $project 'tools/browser-abstract-extension/service-runtime.ps1')
if (-not $Worker) {
  try {
    Set-PaperServiceDataRoot $DataRoot
    # Task Scheduler owns the workers independently of this shell/Codex process.
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'manage-workflow-service.ps1') -Mode Install
    if ($LASTEXITCODE -ne 0) { throw 'TASK_SETUP_FAILED' }
    . (Join-Path $project 'tools/browser-abstract-extension/review-config.ps1')
    $config = Read-PaperReviewConfig -Path (Join-Path $env:LOCALAPPDATA 'PaperDailyReviewBridge/config.clixml')
    $config.Secret.Dispose()
    for ($attempt=0; $attempt -lt 20; $attempt++) {
      $workflow = Get-PaperServiceHealth Workflow $config.ExtensionId
      $review = Get-PaperServiceHealth Review $config.ExtensionId
      if ($workflow -and $review) { Write-Host 'Both services are ready. Automatic login startup and exit recovery are enabled; this window can be closed.'; exit 0 }
      Start-Sleep -Milliseconds 500
    }
    throw 'START_TIMEOUT'
  } catch { Write-Host 'Workflow not ready. See %LOCALAPPDATA%\PaperDailyWorkflow\service-logs; existing data and encrypted key are unchanged.'; exit 1 }
}
$serviceLock=$null
$stage='CONFIG_LOADING'
try {
  $serviceLock = Enter-PaperServiceLock Workflow
  if (-not $serviceLock) { exit 0 }
  Set-PaperServiceDataRoot $DataRoot
  Write-PaperServiceEvent Workflow $stage
  . (Join-Path $project 'tools/browser-abstract-extension/review-config.ps1')
  $config = Read-PaperReviewConfig -Path (Join-Path $env:LOCALAPPDATA 'PaperDailyReviewBridge/config.clixml')
  # The local workflow never decrypts a translation key. The separate source
  # review bridge still uses its existing encrypted configuration.
  $config.Secret.Dispose()
  Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  if (Get-PaperServiceHealth Workflow $config.ExtensionId) { Write-PaperServiceEvent Workflow ALREADY_READY; exit 0 }
  $stage='PORT_CHECK'
  if (Get-NetTCPConnection -LocalPort 17328 -State Listen -ErrorAction SilentlyContinue) { throw 'PORT_IN_USE' }
  $env:PAPER_EXTENSION_ID=$config.ExtensionId
  $env:GIT_CONFIG_COUNT='3'
  $env:GIT_CONFIG_KEY_0='http.sslBackend';$env:GIT_CONFIG_VALUE_0='schannel'
  $env:GIT_CONFIG_KEY_1='http.version';$env:GIT_CONFIG_VALUE_1='HTTP/1.1'
  $env:GIT_CONFIG_KEY_2='credential.interactive';$env:GIT_CONFIG_VALUE_2='never'
  $stage='RUNTIME_LOADING'
  $proxy = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy([uri]'https://github.com')
  if ($proxy.Scheme -eq 'http' -and $proxy.Host -eq '127.0.0.1' -and -not $proxy.UserInfo) {
    $env:GIT_CONFIG_COUNT='4';$env:GIT_CONFIG_KEY_3='http.proxy';$env:GIT_CONFIG_VALUE_3=$proxy.AbsoluteUri
  }
  $nodeCommand=Get-Command node -ErrorAction SilentlyContinue
  $nodeExecutable=if($nodeCommand){$nodeCommand.Source}else{Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'}
  $stage='NODE_RUNNING'
  Write-PaperServiceEvent Workflow STARTING
  $nodeExit = Invoke-PaperServiceProcess $nodeExecutable (Join-Path $PSScriptRoot 'collection-service.js')
  Write-PaperServiceEvent Workflow ('NODE_EXIT:' + $nodeExit)
  throw 'SERVICE_EXITED'
} catch { Write-PaperServiceFailure Workflow $stage $_; Write-Host 'WORKFLOW_SERVICE_FAILED: no credentials printed.' }
finally {
  Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  if ($serviceLock) { $serviceLock.ReleaseMutex(); $serviceLock.Dispose() }
}
exit 1
