// Injected into the current article. Only touches the labelled author drawer,
// never account/access dialogs, CAPTCHA controls, or external author links.
export function jpeAuthorPanel(action,paper){
  if(location.hostname!=='www.journals.uchicago.edu'||paper.journal!=='JPE'||!decodeURIComponent(location.pathname).toLowerCase().endsWith('/'+paper.doi.toLowerCase()))return {status:'wrong_page'};
  if(/verify (?:you are|that you)|checking your browser|just a moment|access denied|captcha/i.test(document.title+' '+(document.body?.innerText||'').slice(0,3500)))return {status:'challenge'};
  const label=el=>(el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||'').replace(/\s+/g,' ').trim();
  const visible=(el,onScreen=false)=>{
    if(!el)return false;
    for(let ancestor=el;ancestor;ancestor=ancestor.parentElement){
      const s=getComputedStyle(ancestor);
      if(ancestor.hidden||ancestor.getAttribute('aria-hidden')==='true'||ancestor.hasAttribute('inert')||s.visibility==='hidden'||s.display==='none'||Number(s.opacity)===0)return false;
    }
    const r=el.getBoundingClientRect();
    return r.width>0&&r.height>0&&(!onScreen||(r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight));
  };
  const controls=root=>[...root.querySelectorAll('button,[role="button"],a[href^="#"]')];
  const opener=controls(document).find(el=>/^(?:author info(?:rmation)? and affiliations|authors and affiliations|author affiliations)$/i.test(label(el))&&visible(el));
  const closer=panel=>controls(panel).find(el=>/^(?:close(?: (?:panel|dialog|drawer|modal))?|dismiss|×|✕|✖|x)$/i.test(label(el)));
  const isPanel=el=>el&&el!==document.body&&el!==document.documentElement&&/information\s*&\s*authors/i.test(el.textContent||'')&&/affiliations/i.test(el.textContent||'');
  let panel=null;
  const ref=opener?.getAttribute('aria-controls')||opener?.getAttribute('href')?.replace(/^#/, '');
  if(ref&&!ref.includes('/')&&isPanel(document.getElementById(ref)))panel=document.getElementById(ref);
  if(!panel){
    for(const heading of document.querySelectorAll('h1,h2,h3,h4,[role="heading"],span,div')){
      if(!/^information\s*&\s*authors$/i.test((heading.textContent||'').trim()))continue;
      for(let el=heading.parentElement,depth=0;el&&depth<6;el=el.parentElement,depth++)if(isPanel(el)){panel=el;break;}
      if(panel)break;
    }
  }
  // A visible outer wrapper does not mean its off-screen/hidden drawer is open.
  // Check the actual drawer heading; a hidden close button is not proof of closure.
  const panelVisible=()=>panel&&visible(panel,true)&&[...panel.querySelectorAll('h1,h2,h3,h4,[role="heading"],span,div')].some(el=>/^information\s*&\s*authors$/i.test((el.textContent||'').trim())&&visible(el,true));
  const owned=panel?.dataset.paperJpeOwned===paper.doi||opener?.dataset.paperAffiliationExpanded==='1';
  const closed=()=>{if(owned){if(panel)delete panel.dataset.paperJpeOwned;if(opener)delete opener.dataset.paperAffiliationExpanded;}return {status:'closed'};};
  if(action==='prepare'||action==='close'){
    if(!panelVisible())return closed();
    if(!owned)return {status:'user_panel_open'};
    const close=closer(panel);if(!visible(close,true))return {status:'close_unavailable'};
    close.click();return {status:'closing'};
  }
  if(action==='state')return panelVisible()?{status:owned?'owned_panel_open':'user_panel_open'}:closed();
  if(action==='open'){
    if(panelVisible())return {status:owned?'owned_panel_open':'user_panel_open'};
    // Do not open an unknown widget unless its scoped close action is known.
    if(!opener||!panel||!closer(panel))return {status:'unsupported_panel'};
    panel.dataset.paperJpeOwned=paper.doi;opener.dataset.paperAffiliationExpanded='1';opener.click();return {status:'opening'};
  }
  if(action==='expand'&&panelVisible()&&owned){
    // Scope Expand All to the Affiliations section, not notes or access widgets.
    const expand=controls(panel).find(el=>/^expand all$/i.test(label(el))&&visible(el)&&el.getAttribute('aria-expanded')!=='true');
    if(expand){expand.click();return {status:'expanding'};}
    return {status:'no_expand_control'};
  }
  return {status:'no_action'};
}

export async function closeOwnedJpePanel(execute,paper,wait){
  const call=async action=>(await execute(jpeAuthorPanel,[action,paper]))?.[0]?.result;
  const result=await call('prepare');
  if(result?.status==='closing'){
    for(let n=0;n<4;n++){await wait(150);const state=await call('state');if(state?.status==='closed')return state;}
    return {status:'close_failed'};
  }
  return result;
}

// Reading author metadata is a transaction AFTER the original abstract capture.
// Always close our drawer, even when extraction throws. Never replace that
// original capture with the darkened/overlaid page capture.
export async function collectJpeAffiliations(execute,paper,read,wait){
  const call=async action=>(await execute(jpeAuthorPanel,[action,paper]))?.[0]?.result;
  let capture=null,status='not_started',cleanup='closed';
  try{
    const opened=await call('open');status=opened?.status||'panel_unavailable';
    if(['opening','owned_panel_open'].includes(status)){
      await wait(250);await call('expand');await wait(350);
      capture=await read();status='read';
    }
  }catch{status='read_failed';}
  finally{
    const result=await closeOwnedJpePanel(execute,paper,wait).catch(()=>({status:'close_failed'}));
    cleanup=result?.status||'close_failed';
  }
  return {status,capture,cleanup};
}

export function mergeJpeAffiliations(capture,extra){
  if(extra?.url!==capture.url||extra.challenge)return capture;
  const additions=(extra.evidence||[]).filter(b=>b.affiliation_record),evidence=[...(capture.evidence||[])];
  for(const b of additions){
    if(evidence.some(x=>x.affiliation_record&&x.text===b.text))continue;
    let index=evidence.length,id;do{id='jpe-affiliation-'+index++;}while(evidence.some(x=>x.id===id));
    evidence.push({...b,id});
  }
  return {...capture,evidence,affiliation_extraction_version:1,affiliation_candidates:evidence.filter(b=>b.affiliation_record).map(b=>({...b.affiliation_record,block_id:b.id}))};
}
