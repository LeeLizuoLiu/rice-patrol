import {mkdir,open,readFile,writeFile,rename} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';

// Crash-safe, content-free one-recovery-per-task reservation. A stale claim
// deliberately blocks another attempt until a human reviews the task state.
export function createRecoveryLedger(directory){
  if(typeof directory!=='string'||!directory)throw new TypeError('ledger directory required');
  const key=taskId=>{
    if(typeof taskId!=='string'||!taskId)throw new TypeError('taskId required');
    return createHash('sha256').update(taskId).digest('hex');
  };
  return {
    async claim(taskId,{modelKey,guardEpisodeId}={}){
      if(!modelKey||!guardEpisodeId)throw new TypeError('model and guard episode required');
      await mkdir(directory,{recursive:true,mode:0o700});
      const path=join(directory,`${key(taskId)}.json`);
      let handle;
      try{handle=await open(path,'wx',0o600)}catch(error){
        if(error?.code==='EEXIST')return {claimed:false,path};
        throw error;
      }
      const entry={schema:1,task:key(taskId),modelKey,guardEpisodeId,state:'reserved',time:Date.now()};
      try{await handle.writeFile(JSON.stringify(entry)+'\n');await handle.sync()}
      finally{await handle.close()}
      return {claimed:true,path};
    },
    async finish(taskId,result){
      const path=join(directory,`${key(taskId)}.json`);
      const old=JSON.parse(await readFile(path,'utf8'));
      if(old.state!=='reserved')throw new Error('recovery ledger already terminal');
      const state=result?.state;
      if(!['completed','failed','budget_exhausted','user_interrupted','ineligible'].includes(state))
        throw new TypeError('terminal recovery state required');
      const entry={...old,state,reason:typeof result.reason==='string'?result.reason:null,finishedAt:Date.now()};
      const tmp=`${path}.${randomUUID()}.tmp`;
      await writeFile(tmp,JSON.stringify(entry)+'\n',{flag:'wx',mode:0o600});
      await rename(tmp,path);
      return entry;
    },
    async read(taskId){
      try{return JSON.parse(await readFile(join(directory,`${key(taskId)}.json`),'utf8'))}
      catch(error){if(error?.code==='ENOENT')return null;throw error}
    }
  };
}

export async function recoverOnce({ledger,recovery,trigger,adapter}){
  if(!ledger?.claim||!ledger?.finish||!recovery?.recover)throw new TypeError('ledger and recovery required');
  const reservation=await ledger.claim(trigger.taskId,{modelKey:trigger.modelKey,guardEpisodeId:trigger.guardEpisodeId});
  if(!reservation.claimed)return {state:'ineligible',reason:'recovery already reserved or consumed'};
  let result;
  try{result=await recovery.recover(trigger,adapter)}
  catch(error){result={state:'failed',reason:error?.code??'RECOVERY_EXCEPTION'}}
  // If this write fails, the reservation remains and future attempts fail closed.
  await ledger.finish(trigger.taskId,result);
  return result;
}
