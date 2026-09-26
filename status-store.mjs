import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
const states=new Set(['STOPPING','PREPARING','COMPACTING','RECOVERING','COMPLETED','FAILED','STOPPED','INTERRUPTED','BLOCKED','OBSERVED']);
const active=new Set(['STOPPING','PREPARING','COMPACTING','RECOVERING']);
const key=id=>createHash('sha256').update(id).digest('hex');
export async function createStatusStore(directory){
  await mkdir(directory,{recursive:true,mode:0o700});
  const current=new Map(),tails=new Map();
  const path=id=>join(directory,`${key(id)}.json`);
  return {
    async set(sessionId,value){
      if(typeof sessionId!=='string'||!sessionId||!states.has(value.state)||!value.episodeId)throw Error('INVALID_STATUS');
      const data={schema:1,episodeId:value.episodeId,state:value.state,updatedAt:Date.now()};
      for(const name of ['reason','childSessionId','requests','compactCalls'])if(value[name]!==undefined)data[name]=value[name];
      if(JSON.stringify(data).length>2048)throw Error('STATUS_TOO_LARGE');
      current.set(sessionId,data);
      const tail=(tails.get(sessionId)??Promise.resolve()).catch(()=>{}).then(async()=>{
        const tmp=`${path(sessionId)}.${randomUUID()}.tmp`;
        await writeFile(tmp,JSON.stringify(data)+'\n',{flag:'wx',mode:0o600});await rename(tmp,path(sessionId));
      });tails.set(sessionId,tail);try{await tail}finally{if(tails.get(sessionId)===tail)tails.delete(sessionId)}
      return data;
    },
    async get(sessionId){
      if(current.has(sessionId))return current.get(sessionId);
      try{
        if((await stat(path(sessionId))).size>2048)throw Error('INVALID_STATUS');
        const data=JSON.parse(await readFile(path(sessionId),'utf8'));
        // A persisted active state after restart is evidence of interruption,
        // never an instruction to silently launch another recovery.
        return active.has(data.state)?{...data,state:'BLOCKED',reason:'HOST_RESTARTED'}:data;
      }catch(e){if(e.code==='ENOENT')return null;throw e}
    },
    async flush(){await Promise.allSettled([...tails.values()])},
  };
}
