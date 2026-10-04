import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {startLocalServices} from '../tools/browser-abstract-extension/service-launcher.js';

test('button sends only the fixed native startup request and reports unavailable installation',async()=>{
  let sent;await startLocalServices({sendNativeMessage:async(...args)=>{sent=args;return {ok:true,code:'START_REQUESTED'};}});
  assert.deepEqual(sent,['org.paper_daily.services',{action:'start_services'}]);
  await assert.rejects(startLocalServices({sendNativeMessage:async()=>{throw Error('private native detail');}}),/重新加载/);
  await assert.rejects(startLocalServices({sendNativeMessage:async()=>({ok:false,code:'START_FAILED'})}),/未完成/);
});
test('native host validates framed input and origin, starts fixed services without a console or arbitrary commands',{skip:process.platform!=='win32'},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paper-native-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const exe=path.join(root,'host.exe'),script=path.join(root,'manage-workflow-service.ps1'),origin='chrome-extension://'+'a'.repeat(32)+'/';
  await fs.writeFile(script,`param([string]$Mode,[string]$DataRoot)\n[IO.File]::WriteAllText((Join-Path $DataRoot 'started.txt'),$Mode)\nWrite-Output 'private worker output'\n`);
  await fs.writeFile(path.join(root,'launcher.json'),JSON.stringify({origin,script,data_root:root}));
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop';Add-Type -Path ./tools/browser-abstract-extension/native-service-host.cs -ReferencedAssemblies System.Web.Extensions,System -OutputAssembly '${exe.replaceAll("'","''")}' -OutputType WindowsApplication`],{windowsHide:true,stdio:'pipe'});
  const invoke=(request,caller=origin)=>{
    const body=Buffer.from(JSON.stringify(request)),length=Buffer.alloc(4);length.writeUInt32LE(body.length);
    const result=spawnSync(exe,[caller],{input:Buffer.concat([length,body]),windowsHide:true,timeout:15000});
    assert.equal(result.status,0,result.stderr?.toString());assert.equal(result.stderr.length,0);
    assert.equal(result.stdout.readUInt32LE(0),result.stdout.length-4);return JSON.parse(result.stdout.subarray(4));
  };
  assert.equal(invoke({action:'start_services'},'chrome-extension://'+'b'.repeat(32)+'/').code,'ORIGIN_REJECTED');
  assert.equal(invoke({action:'start_services',command:'untrusted'}).code,'REQUEST_REJECTED');
  await assert.rejects(fs.stat(path.join(root,'started.txt')));
  assert.equal(invoke({action:'start_services'}).ok,true);assert.equal(await fs.readFile(path.join(root,'started.txt'),'utf8'),'Start');
  const pe=await fs.readFile(exe);assert.equal(pe.readUInt16LE(pe.readUInt32LE(0x3c)+24+68),2);
});
