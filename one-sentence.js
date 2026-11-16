export function renderOneSentence(paper){
  const content=paper.one_sentence_status==='done'&&typeof paper.one_sentence_zh==='string'?paper.one_sentence_zh.trim():'';
  const section=document.createElement('section');section.className='paper-one-sentence';
  section.setAttribute('aria-label','研究要点');
  const heading=document.createElement('h4');heading.className='one-sentence-heading';
  const ns='http://www.w3.org/2000/svg';
  const icon=document.createElementNS(ns,'svg');
  icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');
  icon.setAttribute('stroke-width','1.6');icon.setAttribute('stroke-linecap','round');icon.setAttribute('stroke-linejoin','round');
  icon.setAttribute('aria-hidden','true');
  for(const d of ['M9 18h6M10 21h4','M9 15.5c0-2-3-3.1-3-6.5a6 6 0 0 1 12 0c0 3.4-3 4.5-3 6.5v.5H9z']){const p=document.createElementNS(ns,'path');p.setAttribute('d',d);icon.append(p);}
  const label=document.createElement('span');label.textContent='研究要点';heading.append(icon,label);
  const text=document.createElement('p');text.className='one-sentence-text';text.textContent=content||'暂无';
  if(!content)text.classList.add('is-empty');
  section.append(heading,text);return section;
}
