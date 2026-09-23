param(
  [Parameter(Mandatory=$true)][string[]]$File,
  [Parameter(Mandatory=$true)][string]$Library,
  [string]$Build,
  [switch]$Save,
  [switch]$Translate,
  [switch]$InitializeTranslationLedger,
  [switch]$RemoteCheckpoints,
  [int]$MaxRequests = 10
)
$ErrorActionPreference = 'Stop'
$oldKey = $env:DEEPSEEK_API_KEY
try {
  $project = Split-Path -Parent $PSScriptRoot
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  $nodeExecutable = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
  if ($Translate) {
    if (-not $Save) { throw 'SAVE_REQUIRED' }
    . (Join-Path $project 'tools/browser-abstract-extension/review-config.ps1')
    $reviewConfig = Read-PaperReviewConfig -Path (Join-Path $env:LOCALAPPDATA 'PaperDailyReviewBridge/config.clixml')
    $secretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($reviewConfig.Secret)
    try { $env:DEEPSEEK_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPtr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPtr); $reviewConfig.Secret.Dispose() }
  }
  $importArgs = @((Join-Path $PSScriptRoot 'browser-import.js'), '--library', $Library)
  foreach ($inputFile in $File) { $importArgs += @('--file', $inputFile) }
  if ($Save) { $importArgs += '--save' }
  if ($Translate) { $importArgs += @('--translate', '--max-requests', [string]$MaxRequests) }
  if ($InitializeTranslationLedger) { $importArgs += '--init-translation-ledger' }
  if ($RemoteCheckpoints) { $importArgs += '--remote-checkpoints' }
  if ($Build) { $importArgs += @('--build', $Build) }
  & $nodeExecutable @importArgs
  if ($LASTEXITCODE -ne 0) { throw 'IMPORT_INCOMPLETE' }
} catch { Write-Host 'Local import did not finish. No credentials printed. Keep the export, library and translation ledger.'; exit 1 }
finally { $env:DEEPSEEK_API_KEY = $oldKey }
