param([string]$DataRoot)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'service-runtime.ps1')
$serviceLock = $null
$stage='CONFIG_LOADING'
try {
  $serviceLock = Enter-PaperServiceLock Review
  if (-not $serviceLock) { exit 0 }
  Set-PaperServiceDataRoot $DataRoot
  Write-PaperServiceEvent Review $stage
  . (Join-Path $PSScriptRoot 'review-config.ps1')
  $config = Read-PaperReviewConfig -Path (Join-Path $env:LOCALAPPDATA 'PaperDailyReviewBridge\config.clixml')
  if (Get-PaperServiceHealth Review $config.ExtensionId) { $config.Secret.Dispose(); Write-PaperServiceEvent Review ALREADY_READY; exit 0 }
  $stage='PORT_CHECK'
  if (Get-NetTCPConnection -LocalPort 17327 -State Listen -ErrorAction SilentlyContinue) { $config.Secret.Dispose(); throw 'PORT_IN_USE' }
  $secretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($config.Secret)
  try { $env:DEEPSEEK_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPtr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPtr); $config.Secret.Dispose() }
  $env:PAPER_EXTENSION_ID = $config.ExtensionId
  $env:PAPER_REVIEW_MAX_CALLS = [string]$config.MaxCalls
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  $nodeExecutable = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
  $stage='NODE_RUNNING'
  Write-PaperServiceEvent Review STARTING
  & $nodeExecutable (Join-Path $PSScriptRoot 'review-bridge.mjs')
  Write-PaperServiceEvent Review ('NODE_EXIT:' + $LASTEXITCODE)
  throw 'SERVICE_EXITED'
} catch { Write-PaperServiceFailure Review $stage $_; Write-Output 'Local review service exited or could not start. No credentials are included in this message.' }
finally {
  Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:PAPER_EXTENSION_ID -ErrorAction SilentlyContinue
  Remove-Item Env:PAPER_REVIEW_MAX_CALLS -ErrorAction SilentlyContinue
  if ($serviceLock) { $serviceLock.ReleaseMutex(); $serviceLock.Dispose() }
}
exit 1
