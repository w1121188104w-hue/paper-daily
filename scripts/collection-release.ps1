# Fixed repository and read-only website verification. Never output credentials.
param([ValidateSet('Publish','Check')][string]$Mode='Check',[string]$BatchId,[string]$ExportHash,[string]$PublicationId)
$ErrorActionPreference='Stop'
try {
  if ($Mode -eq 'Check') {
    if ($BatchId -notmatch '^[a-f0-9-]{36}$' -or $ExportHash -notmatch '^[a-f0-9]{64}$' -or $PublicationId -notmatch '^[a-f0-9-]{36}$') { throw 'INVALID_BATCH' }
    $page = Invoke-RestMethod -Uri ('https://w1121188104w-hue.github.io/paper-daily/data.json?workflow='+$PublicationId) -TimeoutSec 25
    $found = @($page.collection_workflow.receipts | Where-Object {$_.id -eq $BatchId -and $_.input_sha256 -eq $ExportHash -and $_.publication_id -eq $PublicationId}).Count -gt 0
    @{published=$found} | ConvertTo-Json -Compress
  } else {
    $lines = @("protocol=https`nhost=github.com`n`n" | git -c credential.interactive=never credential fill)
    if ($LASTEXITCODE -ne 0) { throw 'LOGIN_UNAVAILABLE' }
    $secretLine = $lines | Where-Object {$_.StartsWith('password=')} | Select-Object -First 1
    if (-not $secretLine) { throw 'LOGIN_UNAVAILABLE' }
    $headers = @{Authorization=('Bearer '+$secretLine.Substring(9));Accept='application/vnd.github+json';'X-GitHub-Api-Version'='2022-11-28'}
    Invoke-RestMethod -Method Post -Uri 'https://api.github.com/repos/w1121188104w-hue/paper-daily/actions/workflows/deploy-pages.yml/dispatches' -Headers $headers -ContentType 'application/json' -Body '{"ref":"master"}' -TimeoutSec 25 | Out-Null
    '{"dispatched":true,"published":false}'
  }
} catch { '{"error":"RELEASE_NOT_CONFIRMED"}'; exit 1 }
finally {$lines=$null;$secretLine=$null;$headers=$null}
