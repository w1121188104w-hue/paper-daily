# Shared lifecycle helpers. Log only fixed event codes, never secrets or raw errors.
function Get-PaperServiceTaskName {
  param([ValidateSet('Workflow','Review')][string]$Role)
  return ('PaperDaily-' + $Role + '-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
}
function Resolve-PaperPhysicalDataRoot {
  param([string]$DataRoot)
  # Resolve the encrypted file's handle, never its contents. AppData can be
  # virtualized by packaged desktop apps; scheduled tasks run outside that view.
  $file = Join-Path $DataRoot 'PaperDailyReviewBridge/config.clixml'
  if (-not ('PaperDaily.NativePath' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace PaperDaily {
  public static class NativePath {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder path, uint size, uint flags);
  }
}
'@
  }
  $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try {
    $buffer = New-Object Text.StringBuilder 32768
    $length = [PaperDaily.NativePath]::GetFinalPathNameByHandleW($stream.SafeFileHandle.DangerousGetHandle(), $buffer, $buffer.Capacity, 0)
    if (-not $length -or $length -ge $buffer.Capacity) { throw 'DATA_ROOT_UNRESOLVED' }
    $physical = $buffer.ToString()
    if ($physical.StartsWith('\\?\UNC\')) { $physical = '\\' + $physical.Substring(8) }
    elseif ($physical.StartsWith('\\?\')) { $physical = $physical.Substring(4) }
    $folder = Split-Path -Parent $physical
    if ((Split-Path -Leaf $folder) -ne 'PaperDailyReviewBridge') { throw 'UNEXPECTED_CONFIG_LOCATION' }
    return (Split-Path -Parent $folder)
  } finally { $stream.Dispose() }
}
function Get-PaperConfiguredDataRoot {
  param([string]$DataRoot)
  if (-not $DataRoot) {
    $savedRoots = @()
    foreach ($role in @('Workflow','Review')) {
      $task = Get-PaperManagedTask $role
      if ($task -and @($task.Actions).Count -eq 1 -and $task.Actions[0].Arguments -match ' -DataRoot "([^"]+)"$') { $savedRoots += $Matches[1] }
    }
    $savedRoots = @($savedRoots | Select-Object -Unique)
    if ($savedRoots.Count -gt 1) { throw 'DATA_ROOT_CONFLICT' }
    $DataRoot = if ($savedRoots.Count) { $savedRoots[0] } else { $env:LOCALAPPDATA }
  }
  return $DataRoot
}
function Set-PaperServiceDataRoot {
  param([string]$DataRoot)
  # Process-local only, not the Windows user/system environment.
  $env:LOCALAPPDATA = Resolve-PaperPhysicalDataRoot (Get-PaperConfiguredDataRoot $DataRoot)
}
function Write-PaperServiceEvent {
  param([ValidateSet('Workflow','Review')][string]$Role, [string]$Code)
  if ($Code -cnotmatch '^[A-Z0-9_:-]{1,80}$') { throw 'INVALID_EVENT_CODE' }
  try {
    $folder = Join-Path $env:LOCALAPPDATA 'PaperDailyWorkflow\service-logs'
    [void][IO.Directory]::CreateDirectory($folder)
    $line = [DateTime]::UtcNow.ToString('o') + ' ' + $Role + ' pid=' + $PID + ' ' + $Code + [Environment]::NewLine
    [IO.File]::AppendAllText((Join-Path $folder ($Role.ToLowerInvariant() + '.log')), $line)
  } catch { } # Diagnostics must not stop an otherwise healthy service.
}
function Get-PaperServiceHealth {
  param([ValidateSet('Workflow','Review')][string]$Role, [string]$ExtensionId)
  if ($ExtensionId -cnotmatch '^[a-p]{32}$') { throw 'INVALID_EXTENSION_ID' }
  $port = if ($Role -eq 'Workflow') { 17328 } else { 17327 }
  $header = if ($Role -eq 'Workflow') { 'X-Paper-Workflow' } else { 'X-Paper-Review' }
  try {
    $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/health') -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 3 -Headers @{Origin=('chrome-extension://' + $ExtensionId); $header='1'}
    if ($health.status -ne 'ready') { return $null }
    if ($Role -eq 'Workflow' -and ($health.service -ne 'paper-daily-workflow' -or $health.version -ne 2)) { return $null }
    if ($Role -eq 'Review' -and ($health.version -ne '0.9.5' -or -not $health.api_key_configured)) { return $null }
    return $health
  } catch { return $null }
}
function Get-PaperManagedTask {
  param([ValidateSet('Workflow','Review')][string]$Role)
  $task = Get-ScheduledTask -TaskName (Get-PaperServiceTaskName $Role) -TaskPath '\' -ErrorAction SilentlyContinue
  if ($task -and $task.Description -ne ('Paper Daily managed local ' + $Role + ' service v1')) { throw 'TASK_OWNERSHIP_CONFLICT' }
  return $task
}
function Get-PaperTaskUserSid {
  param([string]$UserId)
  if ($UserId -match '^S-1-') { return $UserId }
  return (New-Object Security.Principal.NTAccount($UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
}
function Write-PaperServiceFailure {
  param([ValidateSet('Workflow','Review')][string]$Role, [string]$Stage, $Failure)
  Write-PaperServiceEvent $Role ('FAILED:' + $Stage)
  # Type/line only: exception messages or source lines may contain credentials.
  $type = $Failure.Exception.GetType().Name.ToUpperInvariant()
  if ($type -cmatch '^[A-Z]{1,60}$') { Write-PaperServiceEvent $Role ('ERROR_TYPE:' + $type) }
  Write-PaperServiceEvent $Role ('ERROR_LINE:' + [int]$Failure.InvocationInfo.ScriptLineNumber)
  $configPath = Join-Path $env:LOCALAPPDATA 'PaperDailyReviewBridge/config.clixml'
  if (Test-Path -LiteralPath $configPath) { Write-PaperServiceEvent $Role CONFIG_PRESENT }
  else { Write-PaperServiceEvent $Role CONFIG_ABSENT }
  if ($env:LOCALAPPDATA -eq [Environment]::GetFolderPath('LocalApplicationData')) { Write-PaperServiceEvent $Role STANDARD_PROFILE }
  else { Write-PaperServiceEvent $Role NONSTANDARD_PROFILE }
}
function Enter-PaperServiceLock {
  param([ValidateSet('Workflow','Review')][string]$Role)
  $mutex = New-Object Threading.Mutex($false, ('Local\' + (Get-PaperServiceTaskName $Role)))
  $acquired = $false
  try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { $mutex.Dispose(); return $null }
  return $mutex
}
