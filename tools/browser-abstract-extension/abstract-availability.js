import {normalizeDoi,normalizeTitle} from './core.js';
// Explicit user decision, not an inference from an empty page or an AI verdict.
const confirmed={doi:'10.1002/joom.70053',journal:'JOM',
  title:'Bridging Fragmentation in Digital Transformation Research: Building an Interface Between Operations Management and Information Systems',
  source_url:'https://onlinelibrary.wiley.com/doi/10.1002/joom.70053',
  method:'user_confirmed_publisher_has_no_abstract',confirmed_on:'2026-09-23',
  note:'用户检查出版社页面并确认没有独立摘要；页面从 1 Introduction 开始。'};
export function applyAbstractAvailability(record){
  const out={...record};delete out.abstract_absence;
  if(out.abstract_status==='confirmed_absent')out.abstract_status=record.abstract?'source_checked':'missing';
  if(record.abstract)return out; // New source evidence always takes precedence.
  if(normalizeDoi(record.doi)===confirmed.doi&&record.journal===confirmed.journal&&normalizeTitle(record.title)===normalizeTitle(confirmed.title)){
    out.abstract_status='confirmed_absent';out.abstract_absence={...confirmed};
  }
  return out;
}
export const abstractRetryComplete=r=>!!r.abstract||applyAbstractAvailability(r).abstract_status==='confirmed_absent';
