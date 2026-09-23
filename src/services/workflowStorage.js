import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
// Windows readers/antivirus can momentarily hold the destination. Retrying the
// SAME rename is safe: no destructive unlink, no retry of a billable operation.
export async function writeWorkflowJson(file,data){
  await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';
  const h=await fs.open(tmp,'wx');try{await h.writeFile(JSON.stringify(data)+'\n');await h.sync();}finally{await h.close();}
  for(let attempt=0;;attempt++){
    try{await fs.rename(tmp,file);return;}catch(e){if(!['EPERM','EBUSY','EACCES'].includes(e.code)||attempt>=12)throw e;await delay(50);}
  }
}
