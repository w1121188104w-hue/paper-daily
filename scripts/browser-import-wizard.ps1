# ASCII source for Windows PowerShell 5.1 without UTF-8 BOM.
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  $project = Split-Path -Parent $PSScriptRoot
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = 'Select the exported paper detail JSON'
  $dialog.Filter = 'Paper export (*.json)|*.json'
  $dialog.InitialDirectory = Join-Path $env:USERPROFILE 'Downloads'
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }
  $file = $dialog.FileName
  $library = Join-Path $project 'data/browser-workspace/library'
  $site = Join-Path $project 'data/browser-workspace/site'
  Write-Host 'LOCAL WORKSPACE ONLY. Does not publish or overwrite the online library.'
  Write-Host ('Library: ' + $library)
  & (Join-Path $PSScriptRoot 'browser-import-local.ps1') -File $file -Library $library
  if ($LASTEXITCODE -ne 0) { throw 'PREVIEW_FAILED' }
  $answer = Read-Host 'Type YES to import, translate (maximum 10 requests) and build the local website'
  if ($answer -cne 'YES') { Write-Host 'Cancelled. No library changes or paid requests.'; return }
  & (Join-Path $PSScriptRoot 'browser-import-local.ps1') -File $file -Library $library -Save -Translate -MaxRequests 10 -Build $site -InitializeTranslationLedger
  Write-Host 'No deployment was requested. Keep the export and the library for future merges.'
} catch { Write-Host 'Local workflow stopped. Keep all existing data. No credentials were printed.' }
