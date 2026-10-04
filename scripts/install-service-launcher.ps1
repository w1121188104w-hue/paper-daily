param([string]$DataRoot)
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
. (Join-Path $project 'tools/browser-abstract-extension/service-runtime.ps1')
. (Join-Path $project 'tools/browser-abstract-extension/review-config.ps1')
Set-PaperServiceDataRoot $DataRoot
$config=Read-PaperReviewConfig -Path (Join-Path $env:LOCALAPPDATA 'PaperDailyReviewBridge/config.clixml')
$config.Secret.Dispose()
$source=Join-Path $project 'tools/browser-abstract-extension/native-service-host.cs'
$hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
$directory=Join-Path $env:LOCALAPPDATA ('PaperDailyWorkflow/native-launcher/'+$hash)
$executable=Join-Path $directory 'PaperDaily.NativeServices.exe'
$manifest=Join-Path $directory 'org.paper_daily.services.json'
[void][IO.Directory]::CreateDirectory($directory)
if(-not (Test-Path -LiteralPath $executable)){
  $temporary=Join-Path $directory ([Guid]::NewGuid().ToString('N')+'.exe')
  Add-Type -Path $source -ReferencedAssemblies System.Web.Extensions,System -OutputAssembly $temporary -OutputType WindowsApplication
  [IO.File]::Move($temporary,$executable)
}
$utf8=New-Object Text.UTF8Encoding($false)
$origin='chrome-extension://'+$config.ExtensionId+'/'
$settings=@{origin=$origin;script=(Join-Path $project 'scripts/manage-workflow-service.ps1');data_root=$env:LOCALAPPDATA}
[IO.File]::WriteAllText((Join-Path $directory 'launcher.json'),($settings | ConvertTo-Json -Compress),$utf8)
$registration=@{name='org.paper_daily.services';description='Start the current user Paper Daily services';path=$executable;type='stdio';allowed_origins=@($origin)}
[IO.File]::WriteAllText($manifest,($registration | ConvertTo-Json -Compress),$utf8)
foreach($browser in @('Microsoft\Edge','Google\Chrome')){
  $key='HKCU:\Software\'+$browser+'\NativeMessagingHosts\org.paper_daily.services'
  if(Test-Path -LiteralPath $key){
    $existing=(Get-Item -LiteralPath $key).GetValue('')
    $ownedBase=(Join-Path $env:LOCALAPPDATA 'PaperDailyWorkflow/native-launcher').TrimEnd('\','/')
    if($existing -and -not ([IO.Path]::GetFullPath($existing).StartsWith($ownedBase+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase))){throw 'LAUNCHER_REGISTRATION_CONFLICT'}
  }
  New-Item -Path $key -Force | Out-Null
  Set-Item -LiteralPath $key -Value $manifest
}
Write-Output 'SERVICE_LAUNCHER_INSTALLED'
