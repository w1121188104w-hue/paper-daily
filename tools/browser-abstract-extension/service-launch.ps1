param([switch]$Stop, [switch]$NoPrompt)
$ErrorActionPreference = 'Stop'
try {
  . (Join-Path $PSScriptRoot 'review-config.ps1')
  $configPath = Join-Path $env:LOCALAPPDATA 'PaperDailyReviewBridge\config.clixml'
  if (-not (Test-Path -LiteralPath $configPath)) { throw 'Configuration required' }
  $config = Read-PaperReviewConfig -Path $configPath
  $headers = @{Origin=('chrome-extension://' + $config.ExtensionId); 'X-Paper-Review'='1'}
  $config.Secret.Dispose()
  if ($Stop) {
    Invoke-RestMethod -Uri 'http://127.0.0.1:17327/shutdown' -Method Post -Headers $headers -TimeoutSec 5 | Out-Null
    Write-Host '已停止本地服务。若正在核对，请先在扩展暂停，等本条结束后再停止。'
    return
  }
  $health = $null
  try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17327/health' -Headers $headers -TimeoutSec 3 } catch { }
  if ($health.status -eq 'ready') {
    Write-Host ('服务已经运行，版本 ' + $health.version + '；没有重复启动，也没有调用付费 API。')
    if ($health.version -ne '0.9.5') { Write-Host '检测到旧服务。请先运行 stop-review.cmd，再启动新版。' }
  } else {
    $workerPath = Join-Path $PSScriptRoot 'service-worker.ps1'
    $workerArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $workerPath + '"'
    Start-Process -FilePath 'powershell.exe' -ArgumentList $workerArgs -WindowStyle Hidden | Out-Null
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
      Start-Sleep -Milliseconds 500
      try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17327/health' -Headers $headers -TimeoutSec 2 } catch { }
      if ($health.status -eq 'ready') { break }
    }
    if ($health.status -ne 'ready') { throw 'Service did not become ready' }
    Write-Host '本地服务已在后台启动；关闭启动窗口不会停止它。Key 无需重输。'
  }
  Write-Host '保留扩展采集面板；等待连接的任务会自动继续。停止服务请双击 stop-review.cmd。电脑重启后再启动。'
} catch { Write-Host '操作未完成。请检查旧服务是否仍运行、扩展 ID、端口及配置权限；未输出密钥。' }
finally { if (-not $NoPrompt) { Read-Host '按回车关闭启动窗口' } }
