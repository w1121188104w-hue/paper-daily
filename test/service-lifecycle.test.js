import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../',import.meta.url));
const read=p=>fs.readFile(new URL('../'+p,import.meta.url),'utf8');

test('service lifetime belongs to limited current-user scheduled tasks, not a launcher child',async()=>{
  const manager=await read('scripts/manage-workflow-service.ps1'),start=await read('scripts/start-workflow.ps1');
  assert.match(manager,/-LogonType Interactive -RunLevel Limited/);
  assert.match(manager,/-AtLogOn -User \$userSid/);
  assert.match(manager,/-RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(manager,/-MultipleInstances IgnoreNew/);
  assert.match(manager,/-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(manager,/-WindowStyle Hidden/);
  assert.match(manager,/TASK_OWNERSHIP_CONFLICT/);
  assert.match(manager,/Get-PaperTaskUserSid/);
  assert.match(manager,/-DataRoot/);
  assert.doesNotMatch(manager,/-RunLevel Highest|-Password\b|DEEPSEEK_API_KEY/);
  assert.doesNotMatch(start,/Start-Process|SecureStringToBSTR|PtrToStringBSTR/);
  assert.match(start,/Get-PaperServiceHealth Workflow/);
  assert.match(start,/Get-PaperServiceHealth Review/);
  for(const p of ['scripts/start-workflow.ps1','tools/browser-abstract-extension/service-worker.ps1']) {
    const worker=await read(p);assert.match(worker,/Enter-PaperServiceLock/);assert.match(worker,/ReleaseMutex/);
    assert.match(worker,/NODE_EXIT:/);assert.match(worker,/exit 1/);
    assert.match(worker,/Invoke-PaperServiceProcess/);assert.doesNotMatch(worker,/& \$nodeExecutable/);
  }
  const runtime=await read('tools/browser-abstract-extension/service-runtime.ps1');
  assert.match(runtime,/INVALID_EVENT_CODE/);assert.doesNotMatch(runtime,/Exception\.Message|Secret|apiKey/);
  assert.match(runtime,/GetFinalPathNameByHandleW/);
  assert.match(runtime,/DATA_ROOT_CONFLICT/);
  const review=await read('tools/browser-abstract-extension/service-launch.ps1');
  assert.match(review,/Disable-ScheduledTask/);assert.match(review,/if \(\$disabledForStop\)/);
});

test('Windows resolves physical storage and reuses the registered root without reading credentials', {skip:process.platform!=='win32'}, async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-lifecycle-'));
  try {
    await fs.mkdir(path.join(root,'PaperDailyReviewBridge'));
    await fs.writeFile(path.join(root,'PaperDailyReviewBridge','config.clixml'),'synthetic path test, not a credential');
    const quoted=root.replaceAll("'","''");
    const command=`$ErrorActionPreference='Stop';. ./tools/browser-abstract-extension/service-runtime.ps1; function Get-PaperManagedTask { param($Role) [pscustomobject]@{Actions=@([pscustomobject]@{Arguments='worker -DataRoot "${quoted}"'})} }; $physical=Resolve-PaperPhysicalDataRoot '${quoted}';Set-PaperServiceDataRoot;[pscustomobject]@{physical=$physical;selected=$env:LOCALAPPDATA;sid_matches=((Get-PaperTaskUserSid ([Security.Principal.WindowsIdentity]::GetCurrent().Name)) -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)}|ConvertTo-Json -Compress`;
    const result=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command],{cwd:repo,encoding:'utf8'}));
    assert.equal(result.physical.toLowerCase(),root.toLowerCase());assert.equal(result.selected,result.physical);assert.equal(result.sid_matches,true);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('Windows lifecycle scripts parse, and dry-run plan performs no registration', {skip:process.platform!=='win32'},()=>{
  const files=['scripts/start-workflow.ps1','scripts/manage-workflow-service.ps1','tools/browser-abstract-extension/service-runtime.ps1','tools/browser-abstract-extension/service-worker.ps1','tools/browser-abstract-extension/service-launch.ps1','tools/browser-abstract-extension/start-review.ps1'];
  for(const file of files) {
    const command=`$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) '${file}'),[ref]$tokens,[ref]$errors);if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}`;
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{cwd:repo,stdio:'pipe'});
  }
  const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','scripts/manage-workflow-service.ps1','-Mode','Plan'],{cwd:repo,encoding:'utf8'});
  const plan=JSON.parse(raw);assert.equal(plan.logon_type,'Interactive');assert.equal(plan.run_level,'Limited');
  assert.equal(plan.tasks.length,2);assert.equal(plan.interval_minutes,1);assert.equal(plan.execution_limit,'PT0S');
  assert.equal(new Set(plan.tasks.map(t=>t.Name)).size,2);
  for(const task of plan.tasks) {assert.ok(task.Name.endsWith(plan.user));assert.match(task.Execute,/PaperDaily\.ServiceHost\.exe$/);assert.match(task.Arguments,/-Role (Workflow|Review) -Script /);}
});

test('GUI service host creates no console and propagates worker exit after draining both pipes', {skip:process.platform!=='win32'}, async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-hidden-host-'));
  try {
    const quote=s=>s.replaceAll("'","''");
    const exe=path.join(root,'host.exe'),probe=path.join(root,'probe.ps1');
    // This synthetic worker never reads configuration or calls a network API.
    await fs.writeFile(probe,`param([switch]$Worker,[string]$DataRoot)
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class ConsoleProbe{[DllImport("kernel32.dll")]public static extern IntPtr GetConsoleWindow();}'
$noConsole = [ConsoleProbe]::GetConsoleWindow() -eq [IntPtr]::Zero
[IO.File]::WriteAllText((Join-Path $DataRoot 'result.txt'), [string]$noConsole)
$chunk='x' * 8192
for($i=0;$i -lt 128;$i++){[Console]::Out.Write($chunk);[Console]::Error.Write($chunk)}
exit 17
`);
    const compile=`$ErrorActionPreference='Stop';Add-Type -Path ./tools/browser-abstract-extension/service-host.cs -OutputAssembly '${quote(exe)}' -OutputType WindowsApplication`;
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',compile],{cwd:repo,stdio:'pipe'});
    const pe=await fs.readFile(exe),header=pe.readUInt32LE(0x3c);
    assert.equal(pe.readUInt16LE(header+24+68),2,'host must use Windows GUI subsystem, not Console');
    const {spawnSync}=await import('node:child_process');
    const result=spawnSync(exe,['-Role','Workflow','-Script',probe,'-DataRoot',root],{windowsHide:true,timeout:15000,encoding:'utf8'});
    assert.equal(result.status,17,result.error?.message);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
    assert.equal(await fs.readFile(path.join(root,'result.txt'),'utf8'),'True');
    const helper=`$ErrorActionPreference='Stop';. ./tools/browser-abstract-extension/service-runtime.ps1;$code=Invoke-PaperServiceProcess '${quote(process.execPath)}' '${quote(path.join(root,'probe.js'))}';exit $code`;
    await fs.writeFile(path.join(root,'probe.js'),"process.stdout.write('discarded');process.stderr.write('discarded');process.exitCode=19;");
    const child=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',helper],{cwd:repo,windowsHide:true,timeout:15000,encoding:'utf8'});
    assert.equal(child.status,19,child.stderr);assert.equal(child.stdout,'');assert.equal(child.stderr,'');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
