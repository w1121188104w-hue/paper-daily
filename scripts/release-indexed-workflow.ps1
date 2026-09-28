# Fixed-scope deployment control. Never prints credentials or secret values.
param([ValidateSet('Audit','Prepare','Activate','Publish','Discover','Status')][string]$Mode='Audit',[string]$ExpectedCommit,[long]$RunId=0)
$ErrorActionPreference='Stop'
$base='https://api.github.com/repos/w1121188104w-hue/paper-daily'
$retired=@('daily-collect.yml','enrich-library.yml','search-preflight.yml','abstract-extraction-probe.yml','translate-library.yml','translate-pilot.yml','discovery-search-probe.yml','discovery-search-probe-v2.yml')
$off=@('JOURNAL_AUTOMATION_ENABLED','JOURNAL_ENRICHMENT_ENABLED','JOURNAL_SEARCH_ENABLED','JOURNAL_TRANSLATION_ENABLED','JOURNAL_DISCOVERY_SEARCH_ENABLED')
try {
 $lines=@("protocol=https`nhost=github.com`n`n"|git -c credential.interactive=never credential fill)
 $secret=$lines|Where-Object {$_.StartsWith('password=')}|Select-Object -First 1
 if(!$secret){throw 'LOGIN_UNAVAILABLE'}
 $headers=@{Authorization=('Bearer '+$secret.Substring(9));Accept='application/vnd.github+json';'X-GitHub-Api-Version'='2022-11-28'}
 function Api($route,$method='Get',$body=$null){
  $options=@{Uri=($base+$route);Method=$method;Headers=$headers;TimeoutSec=30}
  if($null-ne $body){$options.ContentType='application/json';$options.Body=($body|ConvertTo-Json -Depth 8 -Compress)}
  try{Invoke-RestMethod @options}catch{
   $http=if($_.Exception.Response){[int]$_.Exception.Response.StatusCode}else{0}
   Write-Host ('API_FAILED '+$method+' '+$route+' HTTP='+$http+' STATUS='+$_.Exception.Status)
   if($http -eq 403){
    try{$detail=$_.ErrorDetails.Message|ConvertFrom-Json;Write-Host ('GITHUB_DETAIL '+$detail.message+' '+$detail.error)}catch{Write-Host ('ERROR_BODY_FORMAT '+$_.Exception.GetType().Name)}
    try{$reader=[IO.StreamReader]::new($_.Exception.Response.GetResponseStream());$errorData=$reader.ReadToEnd()|ConvertFrom-Json;$reader.Dispose();Write-Host ('GITHUB_ERROR '+$errorData.message)}catch{}
   }
   throw
  }
 }
 function CheckRetired {
  $flows=(Api '/actions/workflows').workflows;$variables=(Api '/actions/variables').variables
  foreach($file in $retired){$item=$flows|Where-Object path -eq ('.github/workflows/'+$file);if($item -and $item.state-ne 'disabled_manually' -and $item.state-ne 'deleted'){throw 'LEGACY_WORKFLOW_NOT_DISABLED'}}
  foreach($name in $off){if(($variables|Where-Object name -eq $name).value-ne 'false'){throw 'LEGACY_SWITCH_NOT_OFF'}}
  foreach($status in @('queued','in_progress','waiting','pending','requested')){
   $runs=(Api ('/actions/runs?per_page=100&status='+$status)).workflow_runs
   foreach($run in $runs){if($retired -contains ($run.path -replace '^.github/workflows/','')){
    # GitHub returns queued but zero jobs and 409 to both cancellation endpoints
    # for this exact historical run. Keep its first checkout Action forbidden.
    if(!(IsBlockedHistoricalRun $run)){throw 'LEGACY_RUN_STILL_ACTIVE'}
   }}
  }
 }
 function IsBlockedHistoricalRun($run){
  $blocked=@{'35945650331'='7a9a2947c37a0f194b4705f67e9a647a3b4f4ad5';'35873380116'='aff7d99f957a1196f1b53b091a2c9ec44722f884';'35851898631'='2f0fc9ee35eb5eb2ddbaeff779539885d6d29fb0'}
  if($blocked[[string]$run.id] -ne $run.head_sha -or $run.status -ne 'queued'){return $false}
  if((Api ('/actions/runs/'+$run.id+'/jobs')).total_count -ne 0){return $false}
  $policy=Api '/actions/permissions'
  if($policy.allowed_actions-eq 'local_only'){return $true}
  if($policy.allowed_actions-ne 'selected'){return $false}
  $allowed=Api '/actions/permissions/selected-actions'
  return (!$allowed.github_owned_allowed -and !$allowed.verified_allowed -and
   !@($allowed.patterns_allowed|Where-Object { 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803' -like $_ }).Count)
 }
 if($Mode-eq 'Prepare'){
  $before=(Api '/actions/workflows').workflows
  foreach($file in $retired){$item=$before|Where-Object path -eq ('.github/workflows/'+$file);if($item -and $item.state -ne 'disabled_manually' -and $item.state -ne 'deleted'){Api ('/actions/workflows/'+$file+'/disable') 'Put'|Out-Null}}
  foreach($name in ($off+@('JOURNAL_DISCOVERY_ENABLED'))){Api ('/actions/variables/'+$name) 'Patch' @{name=$name;value='false'}|Out-Null}
  foreach($status in @('queued','in_progress','waiting','pending','requested')){
   $runs=(Api ('/actions/runs?per_page=100&status='+$status)).workflow_runs
   foreach($run in $runs){if($retired -contains ($run.path -replace '^.github/workflows/','')){
    try{Api ('/actions/runs/'+$run.id+'/cancel') 'Post'|Out-Null}catch{
     if([int]$_.Exception.Response.StatusCode -ne 409){throw}
     try{Api ('/actions/runs/'+$run.id+'/force-cancel') 'Post'|Out-Null}catch{
      if([int]$_.Exception.Response.StatusCode -ne 409 -or !(IsBlockedHistoricalRun $run)){throw}
      Write-Output 'HISTORICAL_RUN_BLOCKED: 35945650331 has zero jobs; its checkout remains disallowed.'
     }
    }
   }}
  }
  CheckRetired
  Write-Output 'PREPARED: legacy paid workflows disabled; discovery still paused.'
 }
 if($Mode-in @('Activate','Publish','Discover')){
  if($ExpectedCommit -notmatch '^[a-f0-9]{40}$' -or (Api '/git/ref/heads/master').object.sha-ne $ExpectedCommit){throw 'UNEXPECTED_MASTER'}
  CheckRetired
  # Only this reviewed, search-free command may be activated.
  $entry=Api '/contents/.github/workflows/collection-discovery.yml?ref=master'
  $flowText=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($entry.content))
  if($flowText -match 'ZHIPU|SERPAPI|--search|SEARCH_ENABLED' -or $flowText -notmatch 'node scripts/discover-collection.js --run --save-sources'){throw 'UNSAFE_DISCOVERY_WORKFLOW'}
 }
 if($Mode-eq 'Activate'){
  Api '/actions/permissions' 'Put' @{enabled=$true;allowed_actions='selected'}|Out-Null
  Api '/actions/permissions/selected-actions' 'Put' @{github_owned_allowed=$false;verified_allowed=$false;patterns_allowed=@(
   'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
   'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
   'actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b',
   'actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9',
   'actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e',
   'actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f'
  )}|Out-Null
  if((Api '/actions/workflows/collection-discovery.yml').state -ne 'active'){Api '/actions/workflows/collection-discovery.yml/enable' 'Put'|Out-Null}
  Api '/actions/variables/JOURNAL_DISCOVERY_ENABLED' 'Patch' @{name='JOURNAL_DISCOVERY_ENABLED';value='true'}|Out-Null
  CheckRetired
  Write-Output 'ACTIVATED: three-source discovery only; search and legacy workflows remain off.'
 }
 if($Mode-in @('Publish','Discover')){
  $file=if($Mode-eq 'Publish'){'deploy-pages.yml'}else{'collection-discovery.yml'}
  $prior=(Api ('/actions/workflows/'+$file+'/runs?per_page=20')).workflow_runs
  foreach($run in @($prior|Where-Object status -ne 'completed')){
   if(IsBlockedHistoricalRun $run){Write-Output ('SKIPPED_ISOLATED_HISTORICAL_RUN '+$run.id);continue}
   throw 'WORKFLOW_ALREADY_RUNNING'
  }
  Api ('/actions/workflows/'+$file+'/dispatches') 'Post' @{ref='master'}|Out-Null
  Write-Output ('DISPATCHED '+$file+' '+$ExpectedCommit)
 }
 if($Mode-eq 'Audit'){
  @{permissions=(Api '/actions/permissions');variables=@((Api '/actions/variables').variables|Where-Object name -match '^JOURNAL_.*ENABLED$'|Select-Object name,value);workflows=@((Api '/actions/workflows').workflows|Select-Object path,state)}|ConvertTo-Json -Depth 7
 }
 if($Mode-eq 'Status'){
  if($RunId){
   Api ('/actions/runs/'+$RunId)|Select-Object id,path,status,conclusion,head_sha,html_url|ConvertTo-Json
   $jobs=(Api ('/actions/runs/'+$RunId+'/jobs')).jobs
   $jobs|Select-Object id,name,status,conclusion,steps|ConvertTo-Json -Depth 7
   foreach($job in $jobs){if($job.conclusion -eq 'failure' -and $job.check_run_url.StartsWith($base)){
    foreach($note in (Api ($job.check_run_url.Substring($base.Length)+'/annotations'))){$note|Select-Object annotation_level,message|ConvertTo-Json -Depth 4}
   }}
   (Api ('/actions/runs/'+$RunId+'/pending_deployments'))|Select-Object environment,wait_timer,reviewers|ConvertTo-Json -Depth 4
  }else{(Api '/actions/runs?per_page=6').workflow_runs|Select-Object id,path,status,conclusion,head_sha,html_url|ConvertTo-Json}
 }
}catch{Write-Output ('RELEASE_CONTROL_FAILED '+$_.Exception.GetType().Name+' LINE '+$_.InvocationInfo.ScriptLineNumber);exit 1}
finally{$headers=$null;$secret=$null;$lines=$null}
