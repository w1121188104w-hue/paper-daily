import fs from 'node:fs/promises';
import path from 'node:path';
import {makeReviewJobs,reviewedCatalogPapers,reviewedCatalogCoverage} from '../../tools/browser-abstract-extension/review-core.js';
import {reviewRecord} from '../../tools/browser-abstract-extension/review-decisions.js';
import {prepareReviewPlan,canRetryReview} from '../../tools/browser-abstract-extension/review-client.js';
import {canonicalEvidence} from '../../tools/browser-abstract-extension/article-review.js';
import {reviewJob} from './sourceReview.js';
import {writeWorkflowJson} from './workflowStorage.js';
export const CATALOG_REVIEW_PATH='data/collection-workflow/catalog-reviews.json';
export async function readCatalogReviews(repo){
  try{const value=JSON.parse(await fs.readFile(path.join(repo,CATALOG_REVIEW_PATH),'utf8'));
    if(value.version!==1||!value.results||Array.isArray(value.results))throw Error('INVALID_CATALOG_REVIEWS');return value.results;
  }catch(e){if(e.code==='ENOENT')return {};throw e;}
}
export async function reviewCatalogPages(repo,pages,{request,maxJobs=500,knownPapers=[],checkpoint=async()=>{}}={}){
  const results=await readCatalogReviews(repo),catalog={pages,review_context:{known_papers:knownPapers.map(reviewRecord)}},plan=await prepareReviewPlan(makeReviewJobs(catalog,null),results);let processed=0;
  for(const job of plan.jobs){
    if(results[job.hash]&&canonicalEvidence(results[job.hash].input)!==canonicalEvidence(job.input))delete results[job.hash];
    const prior=results[job.hash],unbilled=prior&&!prior.fingerprint&&['SESSION_LIMIT','BUSY'].includes(prior.error);
    if((!prior||unbilled||canRetryReview(prior))&&request&&processed<maxJobs){
      try{const {result}=await reviewJob(job.input,request,{cached:prior,retry:true});results[job.hash]=result;processed++;}
      catch{continue;}
      await writeWorkflowJson(path.join(repo,CATALOG_REVIEW_PATH),{version:1,results});await checkpoint();
      if(results[job.hash].global_failure)break;
    }
  }
  return {papers:reviewedCatalogPapers(catalog,plan,results),coverage:reviewedCatalogCoverage(catalog,plan,results),catalog,results,processed};
}
