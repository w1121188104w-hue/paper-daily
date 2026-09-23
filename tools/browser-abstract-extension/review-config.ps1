# Windows DPAPI protects SecureString through Export-Clixml for the current user.
# No plaintext credential is written to disk or emitted by these helpers.
function Save-PaperReviewConfig {
  param([string]$Path, [string]$ExtensionId, [Security.SecureString]$Secret)
  if ($ExtensionId -cnotmatch '^[a-p]{32}$' -or $Secret.Length -lt 16 -or $Secret.Length -gt 256) { throw 'INVALID_CONFIG' }
  $folder = Split-Path -Parent $Path
  [void][IO.Directory]::CreateDirectory($folder)
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [IO.Directory]::GetAccessControl($folder, [Security.AccessControl.AccessControlSections]::Access)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  [IO.Directory]::SetAccessControl($folder, $acl)
  $value = [pscustomobject]@{ Version = 1; ExtensionId = $ExtensionId; Secret = $Secret; MaxCalls = 500 }
  $temporary = Join-Path $folder ('config-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $value | Export-Clixml -LiteralPath $temporary -Depth 3
  # Same-directory atomic replacement; a failed write leaves the old config intact.
  if (Test-Path -LiteralPath $Path) {
    $backup = Join-Path $folder ('previous-' + [Guid]::NewGuid().ToString('N') + '.clixml')
    [IO.File]::Replace($temporary, $Path, $backup)
  }
  else { [IO.File]::Move($temporary, $Path) }
}
function Read-PaperReviewConfig {
  param([string]$Path)
  $value = Import-Clixml -LiteralPath $Path
  if ($value.Version -ne 1 -or $value.ExtensionId -cnotmatch '^[a-p]{32}$' -or $value.Secret -isnot [Security.SecureString] -or
    $value.Secret.Length -lt 16 -or $value.Secret.Length -gt 256 -or $value.MaxCalls -lt 1 -or $value.MaxCalls -gt 3000) { throw 'INVALID_CONFIG' }
  return $value
}
