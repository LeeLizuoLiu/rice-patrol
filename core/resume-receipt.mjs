import {isAgentLoopRequest} from '@deepseek-ai/dsh-llm';
import {RecoveryStopped} from './recovery-state.mjs';

// Observe the exact queued continuation, not an arbitrary request in the same
// session. No polling or extra model calls. Wait OUTSIDE idle maintenance.
export function createResumeReceipt({ctx,agent,signal,timeoutMs}){
  let messageId,consumed=false,settled=false,timer,resolve;
  const done=new Promise(r=>{resolve=r}),offs=[];
  const finish=error=>{
    if(settled)return;settled=true;clearTimeout(timer);
    signal?.removeEventListener('abort',aborted);
    for(const off of offs.splice(0))off();
    resolve(error?{ok:false,reason:error}:{ok:true});
  };
  const aborted=()=>finish(signal.reason?.code??'USER_INTERRUPTED');
  offs.push(ctx.on('session/event',(session,event)=>{
    if(session.id!==agent.session.id||!messageId)return;
    if(event.type==='user/message'&&event.data.id===messageId)consumed=true;
    if(event.type==='turn/end')finish('RESUME_ENDED_BEFORE_OUTPUT');
  }));
  offs.push(ctx.on('llm/stream',(options,next)=>{
    if(!messageId||!consumed||options.sessionId!==agent.session.id||!isAgentLoopRequest(options))return next();
    return (async function*(){
      try{
        for await(const chunk of next()){
          if((['text-delta','reasoning-delta','tool-call-delta'].includes(chunk.type)&&
              (chunk.text||chunk.argumentsDelta||chunk.name||chunk.id))||
              (chunk.type==='finish'&&['stop','tool-calls'].includes(chunk.reason?.kind)))finish();
          if(chunk.type==='finish'&&['error','aborted','max-tokens'].includes(chunk.reason?.kind))
            finish('RESUME_ENDED_BEFORE_OUTPUT');
          yield chunk;
        }
      }catch(error){finish('RESUME_REQUEST_FAILED');throw error}
    })();
  }));
  signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
  return {
    arm(id){if(messageId||settled)throw new RecoveryStopped('RESUME_RECEIPT_CLOSED');messageId=id},
    async wait(){
      if(!messageId)throw new RecoveryStopped('RESUME_NOT_QUEUED');
      if(!settled)timer=setTimeout(()=>finish('RESUME_START_TIMEOUT'),timeoutMs);
      return done;
    },
    dispose(){finish('RESUME_OBSERVER_CLOSED')}
  };
}
