// One provider implementation for extension, local Python and scheduled collection.
// Reserve before billing; an interrupted/unknown request is never silently resent.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateReviewInput,validateReviewOutput} from './review-core.js';
import {promptForReview} from './review-prompt.js';
import {ARTICLE_REVIEW_PROTOCOL,expectsAbstract} from './article-review.js';
import {MAX_REVIEW_ATTEMPTS,reviewErrorPolicy} from './retry-policy.js';
export const providerFingerprint=input=>createHash('sha256').update(JSON.stringify({version:2,prompt:promptForReview(input),input})).digest('hex');
export function createSourceReviewer({apiKey,stateDir,fetchImpl=fetch,maxCalls=500,budgetFile=null,beforeRequest=async()=>{},afterRequest=async()=>{}}){
  if(typeof apiKey!=='string'||apiKey.length<16||/\s/.test(apiKey))throw Error('CONFIG_REQUIRED');
  if(!Number.isInteger(maxCalls)||maxCalls<1||maxCalls>3000)throw Error('INVALID_LIMIT');
  let calls=0,busy=false;
  const budgetReady=budgetFile?fs.readFile(budgetFile,'utf8').then(raw=>{
    const b=JSON.parse(raw);if(b.version!==1||!Number.isSafeInteger(b.calls)||b.calls<0)throw Error('INVALID_BUDGET');calls=b.calls;return true;
  }).catch(e=>e.code==='ENOENT'?true:false):Promise.resolve(true);
  const reply=(code,data)=>({code,data});
  async function review(value,{retryHeader}={}){
    if(busy)return reply(409,{error:'BUSY'});
    busy=true;
    try{
      if(!await budgetReady)return reply(500,{error:'BUDGET_UNREADABLE'});
      let input;try{input=validateReviewInput(value);}catch{return reply(400,{error:'INVALID_OR_OVERSIZE_EVIDENCE'});}
      const prompt=promptForReview(input),fingerprint=providerFingerprint(input),file=path.join(stateDir,fingerprint+'.json');
      await fs.mkdir(stateDir,{recursive:true});
      if(retryHeader!==undefined&&!/^[12]$/.test(String(retryHeader)))return reply(400,{error:'INVALID_RETRY_ATTEMPT'});
      let previous=null;
      try{previous=JSON.parse(await fs.readFile(file,'utf8'));previous={...previous,attempt:previous.attempt||1,...reviewErrorPolicy(previous.error)};}
      catch(e){if(e.code!=='ENOENT')throw Error('CACHE_UNREADABLE');}
      if(previous&&!(previous.error&&previous.retryable&&previous.attempt<MAX_REVIEW_ATTEMPTS&&Number(retryHeader)===previous.attempt))
        return reply(200,{...previous,...(previous.output?{verdict:validateReviewOutput(input,previous.output)}:{}),cached:true});
      if(!previous&&retryHeader!==undefined)return reply(409,{error:'RETRY_WITHOUT_PRIOR_ATTEMPT'});
      if(calls>=maxCalls)return reply(429,{error:'SESSION_LIMIT'});
      const attempt=previous?previous.attempt+1:1,started=Date.now();
      const history=previous?.attempt_history||(previous?[{attempt:previous.attempt,error:previous.error,checked_at:previous.checked_at||null}]:[]);
      // The file is also an inter-process claim for the initial request.
      try{await fs.writeFile(file,JSON.stringify({error:'ATTEMPT_UNFINISHED',fingerprint,attempt,attempt_history:history}),{flag:previous?'w':'wx'});}
      catch{return reply(409,{error:'ATTEMPT_ALREADY_RESERVED'});}
      calls++;
      if(budgetFile){await fs.mkdir(path.dirname(budgetFile),{recursive:true});const tmp=budgetFile+'.tmp';await fs.writeFile(tmp,JSON.stringify({version:1,calls}));await fs.rename(tmp,budgetFile);}
      await fs.appendFile(path.join(stateDir,'calls.jsonl'),JSON.stringify({fingerprint,attempt,at:new Date().toISOString(),status:'started'})+'\n');
      await beforeRequest({fingerprint,attempt});
      let result;
      try{
        const response=await fetchImpl('https://api.deepseek.com/chat/completions',{method:'POST',redirect:'error',
          headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(60000),
          body:JSON.stringify({model:'deepseek-flash',stream:false,thinking:{type:'disabled'},temperature:0,max_tokens:8192,response_format:{type:'json_object'},
            messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(input)}]})});
        if(!response.ok)result={error:`PROVIDER_HTTP_${response.status}`,fingerprint};
        else{
          let data;try{data=await response.json();}catch(e){if(['AbortError','TimeoutError'].includes(e.name))throw e;throw Error('PROVIDER_INVALID_ENVELOPE');}
          const choice=data.choices?.[0];
          if(!choice?.message||typeof choice.message.content!=='string')throw Error('PROVIDER_INVALID_ENVELOPE');
          if(choice.finish_reason!=='stop')throw Error('PROVIDER_INCOMPLETE_RESPONSE');
          let output;try{output=JSON.parse(choice.message.content);}catch{throw Error('PROVIDER_INVALID_JSON');}
          if(typeof output?.identity_match!=='boolean'||!output.fields||Array.isArray(output.fields)||typeof output.fields!=='object')throw Error('PROVIDER_INVALID_REVIEW_SHAPE');
          const verdict=validateReviewOutput(input,output);
          result={fingerprint,verdict,output,usage:{prompt_tokens:data.usage?.prompt_tokens??null,completion_tokens:data.usage?.completion_tokens??null},checked_at:new Date().toISOString()};
          if(!input.decision_version&&(input.blocks.some(b=>b.id==='catalog-abstract')||(input.review_protocol===ARTICLE_REVIEW_PROTOCOL&&expectsAbstract(input)))&&verdict.status==='source_checked_candidate'&&!verdict.fields.abstract)
            result.error='PROVIDER_ABSTRACT_NOT_EXTRACTED';
        }
      }catch(e){
        const code=['AbortError','TimeoutError'].includes(e.name)?'PROVIDER_TIMEOUT':
          ['PROVIDER_INVALID_ENVELOPE','PROVIDER_INCOMPLETE_RESPONSE','PROVIDER_INVALID_JSON','PROVIDER_INVALID_REVIEW_SHAPE'].includes(e.message)?e.message:'PROVIDER_NETWORK_ERROR';
        result={error:code,fingerprint};
      }
      result={...result,attempt,max_attempts:MAX_REVIEW_ATTEMPTS,elapsed_ms:Date.now()-started,checked_at:new Date().toISOString(),...reviewErrorPolicy(result.error)};
      result.attempt_history=[...history,{attempt,error:result.error||null,checked_at:result.checked_at,elapsed_ms:result.elapsed_ms,usage:result.usage}];
      // Atomic completion: a torn write must not turn a billed request into a fresh one.
      const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(result));await fs.rename(tmp,file);
      await fs.appendFile(path.join(stateDir,'calls.jsonl'),JSON.stringify({fingerprint,attempt,at:new Date().toISOString(),status:result.error||'completed',elapsed_ms:result.elapsed_ms,usage:result.usage})+'\n');
      await afterRequest({fingerprint,attempt});
      return reply(200,{...result,cached:false});
    }catch(e){return reply(500,{error:e.message==='CACHE_UNREADABLE'?'CACHE_UNREADABLE':'LOCAL_VALIDATION_OR_STORAGE_ERROR'});}
    finally{busy=false;}
  }
  return {review,ready:()=>budgetReady,get calls(){return calls;}};
}
