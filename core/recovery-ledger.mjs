import {mkdir,open,readFile,writeFile,rename} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';

// Crash-safe, content-free deduplication of one stopped generation. Later
// stopped generations can recover without requiring a new user message.
export function createRecoveryLedger(directory){
  if(typeof directory!=='string'||!directory)throw new TypeError('ledger directory required');
  const key=taskId=>{
    if(typeof taskId!=='string'||!taskId)throw new TypeError('taskId required');
    return createHash('sha256').update(taskId).digest('hex');
  };
  const pathFor=(taskId,turnId)=>{
    if(typeof turnId!=='string'||!turnId)throw new TypeError('turnId required');
    return join(directory,`${createHash('sha256').update(taskId).update('\0').update(turnId).digest('hex')}.json`);
  };
  return {
    async claim(taskId,{turnId,modelKey,guardEpisodeId}={}){
      if(!modelKey||!guardEpisodeId)throw new TypeError('model and guard episode required');
      key(taskId);
      await mkdir(directory,{recursive:true,mode:0o700});
      const path=pathFor(taskId,turnId);
      let handle;
      try{handle=await open(path,'wx',0o600)}catch(error){
        if(error?.code==='EEXIST')return {claimed:false,path};
        throw error;
      }
      const entry={schema:3,task:key(taskId),turnId,modelKey,guardEpisodeId,state:'reserved',time:Date.now()};
      try{await handle.writeFile(JSON.stringify(entry)+'\n');await handle.sync()}
      finally{await handle.close()}
      return {claimed:true,path};
    },
    async finish(taskId,turnId,result){
      key(taskId);
      const path=pathFor(taskId,turnId);
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
    async read(taskId,turnId){
      key(taskId);
      try{return JSON.parse(await readFile(pathFor(taskId,turnId),'utf8'))}
      catch(error){if(error?.code==='ENOENT')return null;throw error}
    }
  };
}

export async function recoverOnce({ledger,recovery,trigger,adapter}){
  if(!ledger?.claim||!ledger?.finish||!recovery?.recover)throw new TypeError('ledger and recovery required');
  const reservation=await ledger.claim(trigger.taskId,{turnId:trigger.turnId,
    modelKey:trigger.modelKey,guardEpisodeId:trigger.guardEpisodeId});
  if(!reservation.claimed)return {state:'ineligible',reason:'RECOVERY_ALREADY_HANDLED_THIS_STOP'};
  let result;
  try{result=await recovery.recover(trigger,adapter)}
  catch(error){result={state:'failed',reason:error?.code??'RECOVERY_EXCEPTION'}}
  // If this write fails, the reservation remains and future attempts fail closed.
  await ledger.finish(trigger.taskId,trigger.turnId,result);
  return result;
}
