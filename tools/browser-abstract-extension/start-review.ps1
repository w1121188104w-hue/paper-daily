param([switch]$Configure)
$ErrorActionPreference = 'Stop'
try {
  . (Join-Path $PSScriptRoot 'review-config.ps1')
  $configPath = Join-Path $env:LOCALAPPDATA 'PaperDailyReviewBridge\config.clixml'
  if ($Configure -or -not (Test-Path -LiteralPath $configPath)) {
    Write-Host '论文助手：首次配置，之后不必重复输入。密钥使用当前 Windows 账户加密保存，不要发到聊天。'
    Write-Host '请先刷新扩展到 0.9.0，打开“配置与核对结果”，复制页面显示的扩展 ID。'
    $extensionId = Read-Host '请粘贴扩展 ID（32 个小写字母），然后按回车'
    if ($extensionId -cnotmatch '^[a-p]{32}$') { throw 'Invalid extension ID' }
    $secretValue = Read-Host '请粘贴 DeepSeek API Key，然后按回车（隐藏输入，会加密保存）' -AsSecureString
    Save-PaperReviewConfig -Path $configPath -ExtensionId $extensionId -Secret $secretValue
    $secretValue.Dispose()
    Write-Host '已加密保存。以后启动会直接读取，不再询问。'
  }
  & (Join-Path $PSScriptRoot 'service-launch.ps1') -NoPrompt
} catch { Write-Host '服务未启动，未输出密钥。请检查扩展 ID、配置权限和 Node.js；需要更换配置时运行 configure-review.cmd。' }
finally {
  Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:PAPER_EXTENSION_ID -ErrorAction SilentlyContinue
  Remove-Item Env:PAPER_REVIEW_MAX_CALLS -ErrorAction SilentlyContinue
  Read-Host '按回车关闭启动窗口（后台服务继续运行）'
}
