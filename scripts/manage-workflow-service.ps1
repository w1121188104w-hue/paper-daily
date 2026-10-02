param([ValidateSet('Install','Disable','Status','Plan')][string]$Mode='Status', [string]$DataRoot)
$ErrorActionPreference='Stop'
$project = Split-Path -Parent $PSScriptRoot
. (Join-Path $project 'tools/browser-abstract-extension/service-runtime.ps1')
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if ($Mode -eq 'Install') {
  try { Set-PaperServiceDataRoot $DataRoot; $DataRoot = $env:LOCALAPPDATA }
  catch { Write-Host 'SERVICE_DATA_ROOT_FAILED: cannot locate existing configuration; no new configuration was created.'; exit 1 }
} elseif ($Mode -ne 'Plan') {
  # Status/disable must work even if configuration is missing or damaged.
  try { $DataRoot = Get-PaperConfiguredDataRoot $DataRoot }
  catch { Write-Host 'SERVICE_DATA_ROOT_CONFLICT: inspect the two managed task actions.'; exit 1 }
} elseif (-not $DataRoot) { $DataRoot = $env:LOCALAPPDATA }
$definitions = @(
  @{Role='Workflow'; Script=(Join-Path $PSScriptRoot 'start-workflow.ps1'); Extra=' -Worker'},
  @{Role='Review'; Script=(Join-Path $project 'tools/browser-abstract-extension/service-worker.ps1'); Extra=''}
)
# Current-user interactive tasks can read the existing DPAPI configuration.
# They store no passwords, do not elevate, and never create collection jobs.
foreach ($definition in $definitions) {
  $definition.Name = Get-PaperServiceTaskName $definition.Role
  $definition.LegacyArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $definition.Script + '"' + $definition.Extra
  $definition.Arguments = $definition.LegacyArguments + ' -DataRoot "' + $DataRoot + '"'
  $definition.Description = 'Paper Daily managed local ' + $definition.Role + ' service v1'
}
if ($Mode -eq 'Plan') {
  [pscustomobject]@{user=$userSid;logon_type='Interactive';run_level='Limited';interval_minutes=1;multiple_instances='IgnoreNew';execution_limit='PT0S';tasks=$definitions} | ConvertTo-Json -Depth 4
  exit 0
}
try {
  # Validate all targets first. Never replace a task from a different installation.
  foreach ($definition in $definitions) {
    $task = Get-PaperManagedTask $definition.Role
    if ($task -and (@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ne $powershellPath -or ($task.Actions[0].Arguments -cne $definition.Arguments -and $task.Actions[0].Arguments -cne $definition.LegacyArguments) -or (Get-PaperTaskUserSid $task.Principal.UserId) -ne $userSid)) { throw 'TASK_OWNERSHIP_CONFLICT' }
  }
  if ($Mode -eq 'Install') {
    . (Join-Path $project 'tools/browser-abstract-extension/review-config.ps1')
    $config = Read-PaperReviewConfig -Path (Join-Path $env:LOCALAPPDATA 'PaperDailyReviewBridge/config.clixml')
    $config.Secret.Dispose()
    foreach ($definition in $definitions) {
      if (-not (Test-Path -LiteralPath $definition.Script)) { throw 'WORKER_MISSING' }
      $action = New-ScheduledTaskAction -Execute $powershellPath -Argument $definition.Arguments -WorkingDirectory $project
      $triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $userSid), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)))
      $principal = New-ScheduledTaskPrincipal -UserId $userSid -LogonType Interactive -RunLevel Limited
      $settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
      Register-ScheduledTask -TaskName $definition.Name -TaskPath '\' -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description $definition.Description -Force | Out-Null
      Start-ScheduledTask -TaskName $definition.Name -TaskPath '\'
    }
    Write-Host 'Automatic startup and recovery enabled for the current user. No collection job was created.'
  } elseif ($Mode -eq 'Disable') {
    foreach ($definition in $definitions) {
      if (Get-PaperManagedTask $definition.Role) { Disable-ScheduledTask -TaskName $definition.Name -TaskPath '\' | Out-Null }
    }
    Write-Host 'Automatic startup/recovery disabled. Running services and saved data were not interrupted.'
  }
  foreach ($definition in $definitions) {
    $task = Get-PaperManagedTask $definition.Role
    if ($task) {
      $info = Get-ScheduledTaskInfo -TaskName $definition.Name -TaskPath '\'
      [pscustomobject]@{role=$definition.Role;state=[string]$task.State;last_result=$info.LastTaskResult;last_run=$info.LastRunTime;next_run=$info.NextRunTime} | ConvertTo-Json -Compress
    } else { Write-Host ($definition.Role + ': NOT_INSTALLED') }
  }
} catch {
  Write-Host 'SERVICE_TASK_SETUP_FAILED: existing keys and collection data are unchanged. Check task registration permissions or task ownership.'
  exit 1
}
