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
  const persisted=async sessionId=>{
    try{
      if((await stat(path(sessionId))).size>2048)throw Error('INVALID_STATUS');
      return JSON.parse(await readFile(path(sessionId),'utf8'));
    }catch(e){if(e.code==='ENOENT')return null;throw e}
  };
  const write=async(sessionId,data)=>{
    const tmp=`${path(sessionId)}.${randomUUID()}.tmp`;
    await writeFile(tmp,JSON.stringify(data)+'\n',{flag:'wx',mode:0o600});await rename(tmp,path(sessionId));
  };
  return {
    async set(sessionId,value){
      if(typeof sessionId!=='string'||!sessionId||!states.has(value.state)||!value.episodeId)throw Error('INVALID_STATUS');
      const data={schema:1,episodeId:value.episodeId,state:value.state,updatedAt:Date.now()};
      for(const name of ['reason','childSessionId','requests','compactCalls'])if(value[name]!==undefined)data[name]=value[name];
      if(value.compactionFallback==='max-tokens')data.compactionFallback='max-tokens';
      if(JSON.stringify(data).length>2048)throw Error('STATUS_TOO_LARGE');
      current.set(sessionId,data);
      const tail=(tails.get(sessionId)??Promise.resolve()).catch(()=>{}).then(async()=>{
        await write(sessionId,data);
      });tails.set(sessionId,tail);try{await tail}finally{if(tails.get(sessionId)===tail)tails.delete(sessionId)}
      return data;
    },
    async get(sessionId){
      if(current.has(sessionId))return current.get(sessionId);
      const data=await persisted(sessionId);
      // A persisted active state after restart is evidence of interruption,
      // never an instruction to silently launch another recovery.
      return data&&active.has(data.state)?{...data,state:'BLOCKED',reason:'HOST_RESTARTED'}:data;
    },
    async dismiss(sessionId,episodeId){
      if(typeof sessionId!=='string'||!sessionId||typeof episodeId!=='string'||!episodeId)
        throw Error('INVALID_STATUS');
      const tail=(tails.get(sessionId)??Promise.resolve()).catch(()=>{}).then(async()=>{
        const live=current.get(sessionId),data=live??await persisted(sessionId);
        if(!data||data.episodeId!==episodeId||live&&active.has(data.state))return false;
        if(data.dismissed===true)return true;
        const dismissed={...data,dismissed:true};
        if(JSON.stringify(dismissed).length>2048)throw Error('STATUS_TOO_LARGE');
        await write(sessionId,dismissed);current.set(sessionId,dismissed);
        return true;
      });
      tails.set(sessionId,tail);try{return await tail}finally{if(tails.get(sessionId)===tail)tails.delete(sessionId)}
    },
    async flush(){await Promise.allSettled([...tails.values()])},
  };
}
