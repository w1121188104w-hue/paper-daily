import {captureJpePreview} from './ocr-capture.js';
import {appendOcrEvidence,validOcrPage} from './ocr-core.js';
const pending=new Map();
export const resetOcrSession=()=>pending.clear();
export async function enrichJpePreview(tabId,paper,capture,env={}){
  if(!validOcrPage(paper,capture.url)||capture.challenge)return capture;
  const execute=env.execute||((func,args)=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},func,args}));
  const wait=env.wait||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  let pixels;const loadAttempts=[];
  // Scrolling can trigger lazy loading. Re-read pixels, never refresh the page
  // or change the source URL; cap the extra waiting at 3.5 seconds per read.
  for(const delay of [0,1000,2500]){
    if(delay)await wait(delay);
    pixels=(await execute(captureJpePreview,[paper]))?.[0]?.result;
    loadAttempts.push(pixels?.status||'preview_read_failed');
    if(pixels?.source_url&&pixels.source_url!==capture.url)return {...capture,ocr:{status:'page_changed'}};
    if(pixels?.status!=='preview_image_loading')break;
  }
  if(pixels?.diagnostics)pixels.diagnostics.load_attempts=loadAttempts;
  if(!pixels?.images?.length)return {...capture,ocr:{status:pixels?.status||'preview_read_failed',capture_diagnostics:pixels?.diagnostics}};
  if(pixels.source_url!==capture.url)return {...capture,ocr:{status:'page_changed'}};
  let last=capture;const attempts=[];
  for(const image of pixels.images){
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(image.image));
    const key=paper.doi+':'+[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
    if(!pending.has(key)){
      if(pending.size>100)pending.clear();
      pending.set(key,(async()=>{
        try{
          const response=await (env.fetch||fetch)('http://127.0.0.1:17327/ocr',{method:'POST',headers:{'Content-Type':'application/json','X-Paper-Review':'1'},
            body:JSON.stringify({paper:{title:paper.title,doi:paper.doi,journal:paper.journal},source_url:capture.url,image:image.image}),signal:AbortSignal.timeout(55000)});
          if(!response.ok)return {error:'OCR_BRIDGE_HTTP_'+response.status};
          return await response.json();
        }catch{return {error:'OCR_SERVICE_UNAVAILABLE'};}
      })());
    }
    const result=await pending.get(key);
    if(result.error){attempts.push({status:result.error});if(!last.ocr?.lines)last={...capture,ocr:{status:result.error}};continue;}
    if(!/^[a-f0-9]{64}$/.test(result.image_sha256||'')){attempts.push({status:'INVALID_OCR_RESPONSE'});if(!last.ocr?.lines)last={...capture,ocr:{status:'INVALID_OCR_RESPONSE'}};continue;}
    for(const variant of [result,...(result.alternatives||[]).slice(0,2).map(a=>({...a,image_sha256:result.image_sha256,version:result.version,checked_at:result.checked_at,original_lines:result.lines}))]){
      const enriched=appendOcrEvidence(capture,paper,variant,image);
      attempts.push({image_sha256:result.image_sha256,engine:variant.engine,status:enriched.ocr.extraction.status,line_count:variant.lines?.length||0});
      // A later irrelevant image must not erase a useful earlier transcript.
      if(enriched.ocr.extraction.abstract||(enriched.ocr.lines?.length||0)>(last.ocr?.lines?.length||0))last=enriched;
      if(last.ocr?.extraction?.abstract)return {...last,ocr:{...last.ocr,capture_diagnostics:pixels.diagnostics,attempts}};
    }
  }
  return {...last,ocr:{...last.ocr,capture_diagnostics:pixels.diagnostics,attempts}};
}
