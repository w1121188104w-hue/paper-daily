import {groupPaperIdentities,findPaper} from './paper-identity.js';
import {activeMissingFields} from './collection-policy.js';

export function summarizePending(workflow={}) {
  const known=workflow.known_papers||[];
  const candidates=[...(workflow.processing_papers||[]),...(workflow.pending_papers||[]),...(workflow.field_tasks||[]).filter(p=>
    (!p.status||p.status==='pending')&&activeMissingFields(p.missing_fields).length)];
  const groups=groupPaperIdentities(candidates.filter(p=>['awaiting_upload','awaiting_publication','awaiting_translation'].includes(p.processing_stage)||!findPaper(p,known)?.complete));
  const stages={missing:0,awaiting_review:0,awaiting_import:0,awaiting_upload:0,awaiting_publication:0,awaiting_translation:0};
  const reasons={not_queued:0,read_failed:0,abstract_not_found:0,classification_pending:0};
  for(const group of groups){
    const state=['awaiting_publication','awaiting_upload','awaiting_import','awaiting_review','awaiting_translation'].find(s=>group.some(p=>p.processing_stage===s))||'missing';
    stages[state]++;
    if(state!=='awaiting_translation'&&group.some(p=>p.translation_pending))stages.awaiting_translation++;
    if(state==='missing'){
      const reason=['read_failed','classification_pending','abstract_not_found'].find(r=>group.some(p=>p.reason===r))||'not_queued';reasons[reason]++;
    }
  }
  return {abstracts:stages.missing,otherOnly:0,total:groups.length,stages,reasons};
}
export function captureProgress(raw,checked){
  const row={doi:raw.doi||null,journal:raw.journal,title:raw.title,url:raw.url||raw.source_url};
  if(checked?.abstract||checked?.abstract_status==='confirmed_absent')return {...row,processing_stage:'awaiting_import'};
  if(raw.evidence_version===2&&raw.evidence?.length&&(!checked||checked.review_status==='pending'))return {...row,processing_stage:'awaiting_review'};
  return {...row,processing_stage:'missing',reason:['needs_user_verification','access_denied','capture_failed','page_unavailable','rate_limited','unsupported_page'].includes(raw.status)?'read_failed':
    checked?.review_status==='identity_unconfirmed'||checked?.review_decisions?.article_type?.value==='uncertain'?'classification_pending':'abstract_not_found'};
}
