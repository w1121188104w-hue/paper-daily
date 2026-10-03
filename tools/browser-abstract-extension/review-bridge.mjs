// Optional local bridge. No production access or search; explicit bounded retries.
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import {runLocalOcr} from './ocr-service.mjs';
import {createSourceReviewer} from './review-provider.mjs';
export {REVIEW_PROMPT,promptForReview} from './review-prompt.js';
export function createReviewServer({ extensionId, apiKey, stateDir, fetchImpl = fetch, maxCalls = 500, ocrImpl=runLocalOcr, budgetFile = null }) {
  if (!/^[a-p]{32}$/.test(extensionId || '') || typeof apiKey !== 'string' || apiKey.length < 16 || /\s/.test(apiKey)) throw Error('CONFIG_REQUIRED');
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 3000) throw Error('INVALID_LIMIT');
  const origin = `chrome-extension://${extensionId}`; let busy = false;
  const reviewer = createSourceReviewer({apiKey,stateDir,fetchImpl,maxCalls,budgetFile});
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (code, data) => { res.writeHead(code); res.end(JSON.stringify(data)); };
    if (req.headers.host !== `127.0.0.1:${req.socket.localPort}` || req.headers.origin !== origin) return send(403, { error: 'ORIGIN_DENIED' });
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET,POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Paper-Review,X-Paper-Retry'); return send(204, {}); }
    // GET remains available for the local PowerShell launcher, which explicitly
    // sends Origin. Extension clients use POST so Chromium supplies Origin.
    if (['GET','POST'].includes(req.method) && req.url === '/health' && req.headers['x-paper-review'] === '1') {
      req.resume();
      if(!await reviewer.ready())return send(500,{error:'BUDGET_UNREADABLE'});
      return send(200, { status: 'ready', version: '0.9.5', api_key_configured: true, calls_this_session: reviewer.calls, max_calls: maxCalls,
        calls_in_budget:reviewer.calls,budget_scope:budgetFile?'persistent_allowance':'process_session' });
    }
    if (req.method === 'POST' && req.url === '/shutdown' && req.headers['x-paper-review'] === '1') {
      if (busy) return send(409, {error:'REVIEW_IN_PROGRESS'});
      send(200, {status:'stopping'}); req.socket.server.close(); return;
    }
    if(req.method==='POST' && req.url==='/ocr' && req.headers['x-paper-review']==='1' && /^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){
      if(busy)return send(409,{error:'BUSY'});busy=true;
      try{
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>5600000)return send(413,{error:'OCR_IMAGE_TOO_LARGE'});chunks.push(chunk);}
        let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send(400,{error:'INVALID_OCR_IMAGE'});}
        const result=await ocrImpl(input,stateDir);return send(200,result);
      }catch(e){return send(400,{error:['INVALID_OCR_IMAGE','INVALID_OCR_DIMENSIONS','OCR_TIMEOUT','LOCAL_OCR_UNAVAILABLE','OCR_CACHE_UNREADABLE'].includes(e.message)?e.message:'LOCAL_OCR_FAILED'});}
      finally{busy=false;}
    }
    if (req.method !== 'POST' || req.url !== '/review' || req.headers['x-paper-review'] !== '1' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return send(400, { error: 'INVALID_REQUEST' });
    if (busy) return send(409, { error: 'BUSY' });
    busy = true;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 320000) throw Error('REQUEST_TOO_LARGE'); chunks.push(chunk); }
      const body = Buffer.concat(chunks).toString('utf8');
      let input; try { input = JSON.parse(body); } catch { return send(400,{error:'INVALID_OR_OVERSIZE_EVIDENCE'}); }
      const result=await reviewer.review(input,{retryHeader:req.headers['x-paper-retry']});
      return send(result.code,result.data);
    } catch(e) { return send(500, { error: e.message === 'CACHE_UNREADABLE' ? 'CACHE_UNREADABLE' : 'LOCAL_VALIDATION_OR_STORAGE_ERROR' }); }
    finally { busy = false; }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const stateDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'PaperDailyReviewBridge');
    const server = createReviewServer({ extensionId: process.env.PAPER_EXTENSION_ID, apiKey: process.env.DEEPSEEK_API_KEY, stateDir,
      maxCalls: Number(process.env.PAPER_REVIEW_MAX_CALLS || 500),budgetFile:path.join(stateDir,'review-budget.json') });
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    server.on('error', () => { console.error('本地服务启动失败，请检查 17327 端口。'); process.exitCode = 1; });
    server.listen(17327, '127.0.0.1', () => console.log('原文核对服务 0.9.5 已启动。调用计数持久保留；每份证据最多三次。'));
  } catch { console.error('请通过启动脚本设置扩展 ID 和 DeepSeek 密钥。未调用 API。'); process.exitCode = 1; }
}
