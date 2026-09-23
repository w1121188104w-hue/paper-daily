// Isolated, English-only local OCR. All model/worker assets come from installed
// pinned npm packages; no runtime downloads and no API credential environment.
import {createWorker,PSM} from 'tesseract.js';
import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
const require=createRequire(import.meta.url);
let worker;
try{
  const langPath=path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')),'4.0.0_best_int');
  await fs.access(path.join(langPath,'eng.traineddata.gz'));
  worker=await createWorker('eng',1,{langPath,cacheMethod:'none',gzip:true,logger:()=>{},errorHandler:()=>{}});
  await worker.setParameters({tessedit_pageseg_mode:PSM.AUTO,user_defined_dpi:'150'});
  const {data}=await worker.recognize(await fs.readFile(process.argv[2]),{},{text:true,blocks:true});
  const lines=(data.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>(p.lines||[]).map(l=>({text:l.text.trim(),confidence:l.confidence,
    bbox:l.bbox,words:(l.words||[]).map(w=>({text:w.text,confidence:w.confidence,bbox:w.bbox}))})))).sort((a,b)=>a.bbox.y0-b.bbox.y0||a.bbox.x0-b.bbox.x0);
  const alternatives=[];let retryError=null;
  try{
  const head=lines.findIndex(l=>/^abstract\s*[:.]?$/i.test(l.text));
  if(head>=0){
    let end=lines.length;
    for(let i=head+1;i<lines.length;i++){
      const l=lines[i],prev=lines[i-1];
      if(/^(?:JEL\b|Key\s*words\b|Introduction\b|Acknowledg(?:e)?ments\b)/i.test(l.text)||
        (l.bbox.y0-prev.bbox.y1>=Math.max(18,(prev.bbox.y1-prev.bbox.y0)*1.2)&&/^[*†‡“"']|^(?:We|I) (?:thank|am grateful)/.test(l.text))){end=i;break;}
    }
    const suspicious=lines.map((l,i)=>i>head&&i<end&&(l.confidence<88||/(?:^|\s)[|\[]\s+[A-Za-z]/.test(l.text))?i:-1).filter(i=>i>=0);
    if(suspicious.length>0&&suspicious.length<=4){
      let revised=structuredClone(lines),passes=[];
      for(const mode of [{psm:PSM.SINGLE_LINE,threshold:'2',pad:5,name:'single_line_sauvola'},{psm:PSM.RAW_LINE,threshold:'0',pad:8,name:'raw_line_otsu'}]){
      const remaining=suspicious.filter(i=>revised[i].confidence<88||/(?:^|\s)[|\[]\s+[A-Za-z]/.test(revised[i].text));
      if(!remaining.length)break;
      revised=structuredClone(revised);passes=[...passes];
      await worker.setParameters({tessedit_pageseg_mode:mode.psm,thresholding_method:mode.threshold});
      for(const index of remaining){
        const box=lines[index].bbox;
        const rectangle={left:Math.max(0,box.x0-mode.pad),top:Math.max(0,box.y0-mode.pad),width:box.x1-Math.max(0,box.x0-mode.pad)+mode.pad,height:box.y1-Math.max(0,box.y0-mode.pad)+mode.pad};
        const {data:retry}=await worker.recognize(await fs.readFile(process.argv[2]),{rectangle},{text:true,blocks:true});
        const found=(retry.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>p.lines||[]));
        if(found.length===1){
          const l=found[0];
          // Keep separate raw OCR evidence; no spelling substitution, model
          // rewriting or mixing words from different recognitions.
          revised[index]={text:l.text.trim(),confidence:l.confidence,bbox:box,words:(l.words||[]).map(w=>({text:w.text,confidence:w.confidence,bbox:w.bbox}))};
          passes.push({line_index:index,rectangle,mode:mode.name});
        }
      }
      if(passes.length)alternatives.push({engine:mode.name==='single_line_sauvola'?'tesseract.js-6.0.1-eng-line-pass':'tesseract.js-6.0.1-eng-raw-line-pass',language:'en',lines:revised,recognition_passes:passes});
      }
    }
  }
  }catch{retryError='LOCAL_LINE_OCR_FAILED';}
  console.log(JSON.stringify({engine:'tesseract.js-6.0.1-eng',language:'en',confidence:data.confidence,lines,alternatives,retry_error:retryError}));
}catch{console.log(JSON.stringify({error:'LOCAL_OCR_FAILED'}));process.exitCode=1;}
finally{await worker?.terminate();}
