# Interactive input only. Never save or print the API key.
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
try {
  Write-Host 'Six-journal Zhipu Pro test. Maximum 6 search calls, existing monthly ledger limit 2000.'
  Write-Host 'No SerpAPI, no translations, no paper imports, no website publication.'
  $secret=Read-Host 'Paste Zhipu API key here (hidden, not saved)' -AsSecureString
  if ($secret.Length -lt 8) {throw 'INVALID_KEY'}
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  try {$env:ZHIPU_DISCOVERY_API_KEY=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}
  finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$secret.Dispose()}
  $credentialLines=@("protocol=https`nhost=github.com`n`n" | git -c credential.interactive=never credential fill)
  if ($LASTEXITCODE -ne 0) {throw 'LOGIN_UNAVAILABLE'}
  $secretLine=$credentialLines | Where-Object {$_.StartsWith('password=')} | Select-Object -First 1
  if (-not $secretLine) {throw 'LOGIN_UNAVAILABLE'}
  $env:GITHUB_TOKEN=$secretLine.Substring(9)
  $env:PAPER_DISCOVERY_LOCAL_TEST='1'
  $nodeCommand=Get-Command node -ErrorAction SilentlyContinue
  $nodeExecutable=if($nodeCommand){$nodeCommand.Source}else{Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'}
  Push-Location -LiteralPath $project
  try {& $nodeExecutable (Join-Path $PSScriptRoot 'discovery-search-probe.js') --run-local;if ($LASTEXITCODE -ne 0) {throw 'PROBE_FAILED'}}
  finally {Pop-Location}
  Write-Host ('Report: '+(Join-Path $env:LOCALAPPDATA 'PaperDailySearchProbe/report.json'))
} catch {Write-Host 'TEST NOT COMPLETE. No key or remote error body printed. Do not repeatedly retry uncertain paid requests.'}
finally {
  $credentialLines=$null;$secretLine=$null
  Remove-Item Env:ZHIPU_DISCOVERY_API_KEY,Env:GITHUB_TOKEN,Env:PAPER_DISCOVERY_LOCAL_TEST -ErrorAction SilentlyContinue
  Read-Host 'Press Enter to close'
}
