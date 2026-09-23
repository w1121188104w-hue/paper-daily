import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validOcrPage,OCR_VERSION} from './ocr-core.js';
export function decodeOcrRequest(input){
  if(!validOcrPage(input?.paper,input?.source_url)||typeof input.image!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(input.image)||input.image.length>5500000)throw Error('INVALID_OCR_IMAGE');
  const bytes=Buffer.from(input.image.slice(22),'base64');
  if(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString('ascii',12,16)!=='IHDR')throw Error('INVALID_OCR_IMAGE');
  const w=bytes.readUInt32BE(16),h=bytes.readUInt32BE(20);
  if(w<300||h<300||w>10000||h>10000||w*h>25000000)throw Error('INVALID_OCR_DIMENSIONS');
  return bytes;
}
export function recognizeFile(imagePath){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('./ocr-worker.mjs',import.meta.url)),imagePath],
      {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:process.env.TEMP,TMP:process.env.TMP,PATH:process.env.PATH,USERPROFILE:process.env.USERPROFILE,LOCALAPPDATA:process.env.LOCALAPPDATA}});
    let out='',overflow=false;const timer=setTimeout(()=>{child.kill();reject(Error('OCR_TIMEOUT'));},45000);
    child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{out+=data;if(out.length>400000){overflow=true;child.kill();}});child.stderr.resume();
    child.on('error',()=>{clearTimeout(timer);reject(Error('LOCAL_OCR_UNAVAILABLE'));});
    child.on('close',code=>{clearTimeout(timer);try{if(code!==0||overflow)throw Error();const result=JSON.parse(out.replace(/^\uFEFF/,''));if(result.error||!Array.isArray(result.lines))throw Error();resolve(result);}catch{reject(Error('LOCAL_OCR_FAILED'));}});
  });
}
export async function runLocalOcr(input,stateDir,recognize=recognizeFile){
  const bytes=decodeOcrRequest(input),digest=crypto.createHash('sha256').update(bytes).digest('hex');
  const dir=path.join(stateDir,'ocr'),base=path.join(dir,digest),cache=base+'.'+OCR_VERSION+'-line-pass-v3.json';
  await fs.mkdir(dir,{recursive:true});
  try{const saved=JSON.parse(await fs.readFile(cache,'utf8'));return {...saved,cached:true};}catch(e){if(e.code!=='ENOENT')throw Error('OCR_CACHE_UNREADABLE');}
  await fs.writeFile(base+'.png',bytes); // Keep the source image for audit, never fetch URLs or arbitrary client paths.
  const result={...await recognize(base+'.png'),image_sha256:digest,version:OCR_VERSION,checked_at:new Date().toISOString(),paid_api_calls:0};
  await fs.writeFile(cache,JSON.stringify(result));return {...result,cached:false};
}
