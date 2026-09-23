// Reads page preview pixels. An unloaded preview may be scrolled into view to
// trigger normal lazy loading. No URL fetch, cookies or CAPTCHA action.
export function captureJpePreview(paper){
  if(location.hostname!=='www.journals.uchicago.edu'||paper.journal!=='JPE'||!decodeURIComponent(location.pathname).toLowerCase().endsWith('/'+paper.doi.toLowerCase()))return {status:'wrong_page',images:[]};
  const top=document.title+' '+(document.body?.innerText||'').slice(0,3500);
  if(/verify (?:you are|that you)|checking your browser|just a moment|access denied|captcha/i.test(top))return {status:'challenge',images:[]};
  const images=[];let restricted=false;
  const diagnostics={elements:0,not_loaded:0,failed_images:0,too_small:0,hidden:0,unsupported_shape:0,unreadable_frames:0,previews:[]};
  const documents=[document];
  for(const frame of document.querySelectorAll('iframe')){
    try{if(frame.contentDocument&&frame.contentDocument.location.origin===location.origin)documents.push(frame.contentDocument);else diagnostics.unreadable_frames++;}catch{diagnostics.unreadable_frames++;}
  }
  const candidates=documents.flatMap(doc=>[...doc.querySelectorAll('img,canvas')]).sort((a,b)=>{
    const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return br.width*br.height-ar.width*ar.height;
  });
  for(const el of candidates){
    if(el.closest('header,footer,nav,aside,[role="dialog"],.related,.recommended,.references'))continue;
    diagnostics.elements++;
    const rect=el.getBoundingClientRect(),style=el.ownerDocument.defaultView.getComputedStyle(el);
    const width=el.naturalWidth||el.width,height=el.naturalHeight||el.height;
    if(style.visibility==='hidden'||style.display==='none'||rect.width<1||rect.height<1){diagnostics.hidden++;continue;}
    // Ignore UI icons and tracking pixels BEFORE interpreting load state.
    if(rect.width<120||rect.height<100){diagnostics.too_small++;continue;}
    let source=null;
    if(el.tagName==='IMG'){try{const u=new URL(el.currentSrc||el.src,location.href);if(u.protocol==='https:'&&u.hostname==='www.journals.uchicago.edu'&&!u.username&&!u.password){u.search='';u.hash='';source=u.href;}}catch{}}
    const state=el.tagName!=='IMG'?'canvas':!el.complete?'loading':el.naturalWidth>0?'loaded':'failed';
    if(diagnostics.previews.length<8)diagnostics.previews.push({kind:el.tagName,state,source_url:source,render_width:Math.round(rect.width),render_height:Math.round(rect.height),source_width:width,source_height:height});
    if(state==='loading'||state==='failed'){
      if(state==='loading'){
        diagnostics.not_loaded++;
        if(diagnostics.not_loaded===1&&rect.width>=300)el.scrollIntoView({block:'center',behavior:'instant'});
      }else diagnostics.failed_images++;
      continue;
    }
    // Cropped first-page previews and a narrow browser pane are not necessarily
    // small source images. Identity and Abstract are still checked after OCR.
    if(width<400||height<300){diagnostics.too_small++;continue;}
    if(height/width<0.35||height/width>3.5){diagnostics.unsupported_shape++;continue;}
    if(images.length>=2)continue;
    try{
      const scale=Math.max(1,Math.min(3,1600/width)),canvas=document.createElement('canvas');
      canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);
      if(canvas.width*canvas.height>12000000)continue;
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(el,0,0,canvas.width,canvas.height);
      // Measure actual white space, not merely the absence of OCR words. A
      // cropped page bottom alone is never treated as an abstract end marker.
      let layout=null;
      if(ctx.getImageData){
        const w=canvas.width,h=canvas.height,pixels=ctx.getImageData(0,0,w,h).data,bands=[];
        let start=null,footerInk=0;
        for(let y=Math.floor(h*.2);y<h;y++){
          let ink=0;for(let x=0;x<w;x+=2){const n=(y*w+x)*4;if(Math.min(pixels[n],pixels[n+1],pixels[n+2])<190)ink++;}
          const blank=ink<=Math.max(1,Math.floor(w*.001));
          if(y>h*.94)footerInk+=ink;
          if(blank&&start===null)start=y;
          if((!blank||y===h-1)&&start!==null){const end=blank?y+1:y;if(end-start>=Math.max(40,h*.03))bands.push({y0:start,y1:end});start=null;}
        }
        layout={width:w,height:h,blank_bands:bands,footer_ink:footerInk>10,method:'pixel_whitespace_v1'};
      }
      const data=canvas.toDataURL('image/png');if(data.length>5500000)continue;
      images.push({image:data,source_url:source,kind:el.tagName==='IMG'?'loaded_preview_image':'loaded_preview_canvas',source_width:width,source_height:height,width:canvas.width,height:canvas.height,layout});
    }catch{restricted=true;} // Cross-origin pixel restrictions are not bypassed.
  }
  return {status:images.length?'images_ready':restricted?'image_pixels_restricted':diagnostics.not_loaded?'preview_image_loading':diagnostics.failed_images?'preview_image_failed':'no_readable_preview_image',source_url:location.href,images,diagnostics};
}
