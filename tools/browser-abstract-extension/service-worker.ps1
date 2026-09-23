$ErrorActionPreference = 'Stop'
try {
  . (Join-Path $PSScriptRoot 'review-config.ps1')
  $config = Read-PaperReviewConfig -Path (Join-Path $env:LOCALAPPDATA 'PaperDailyReviewBridge\config.clixml')
  $secretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($config.Secret)
  try { $env:DEEPSEEK_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPtr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPtr); $config.Secret.Dispose() }
  $env:PAPER_EXTENSION_ID = $config.ExtensionId
  $env:PAPER_REVIEW_MAX_CALLS = [string]$config.MaxCalls
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  $nodeExecutable = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
  & $nodeExecutable (Join-Path $PSScriptRoot 'review-bridge.mjs')
} catch { Write-Output 'Local review service could not start. No credentials are included in this message.' }
finally {
  Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:PAPER_EXTENSION_ID -ErrorAction SilentlyContinue
  Remove-Item Env:PAPER_REVIEW_MAX_CALLS -ErrorAction SilentlyContinue
}
