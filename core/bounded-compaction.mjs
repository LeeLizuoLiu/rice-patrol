import {ShortLineDetector} from './detector.mjs';

export class CompactionStopError extends Error {
  constructor(code,{cause}={}){super(code,{cause});this.name='CompactionStopError';this.code=code}
}

const positive=(name,value)=>{
  if(!Number.isSafeInteger(value)||value<=0)throw new TypeError(`${name} must be a positive integer`);
};

// Only the one explicit auxiliary call owned by this recovery episode is admitted.
// A timed-out call that has not settled is left guarded and recovery must stop.
export async function runBoundedCompaction({ctx,compact,agent,provider,model,signal,
  maxMs,maxDeltas,maxBytes,cleanupWaitMs=100,onEvent=()=>{}}){
  if(!ctx?.on||typeof compact!=='function'||!agent?.session?.id||!provider||!model)
    throw new TypeError('explicit compaction context, route and agent required');
  for(const [name,value] of Object.entries({maxMs,maxDeltas,maxBytes,cleanupWaitMs}))positive(name,value);
  const controller=new AbortController();
  const detector=new ShortLineDetector();
  let calls=0,deltas=0,bytes=0,settled=false;
  const stop=code=>{
    if(!controller.signal.aborted){
      controller.abort(new CompactionStopError(code));
      try{onEvent({type:'COMPACTION_STOP',code,calls,deltas,bytes})}catch{}
    }
  };
  const externalAbort=()=>stop('COMPACTION_USER_CANCELLED');
  signal?.addEventListener('abort',externalAbort,{once:true});
  if(signal?.aborted)externalAbort();
  const off=ctx.on('llm/stream',(options,next)=>{
    if(options.purpose!=='compaction'||options.sessionId!==agent.session.id)return next();
    calls++;
    if(options.provider!==provider||options.model!==model){stop('COMPACTION_ROUTE_MISMATCH');throw controller.signal.reason}
    if(calls>1){stop('COMPACTION_CALL_LIMIT');throw controller.signal.reason}
    return (async function*(){
      for await(const chunk of next()){
        if(controller.signal.aborted)throw controller.signal.reason;
        if(chunk?.type==='reasoning-delta'||chunk?.type==='text-delta'){
          const piece=String(chunk.text??'');deltas++;bytes+=Buffer.byteLength(piece);
          if(deltas>maxDeltas||bytes>maxBytes){stop('COMPACTION_RESOURCE_LIMIT');throw controller.signal.reason}
          if(detector.feed(piece)?.status==='CONFIRMED'){
            stop('COMPACTION_LOOP_CONFIRMED');throw controller.signal.reason;
          }
        }
        yield chunk;
      }
    })();
  });
  let offDone=false;
  const release=()=>{if(!offDone){offDone=true;off()}};
  const timer=setTimeout(()=>stop('COMPACTION_DEADLINE'),maxMs);
  let cleanupTimer;
  const operation=Promise.resolve().then(()=>{
    controller.signal.throwIfAborted();
    return compact(agent,controller.signal);
  }).then(value=>({type:'result',value}),error=>({type:'error',error})).finally(()=>{settled=true;release()});
  const stopped=new Promise(resolve=>controller.signal.addEventListener('abort',()=>resolve({type:'abort'}),{once:true}));
  try{
    const first=await Promise.race([operation,stopped]);
    if(first.type==='abort'){
      const drained=await Promise.race([operation,new Promise(resolve=>{cleanupTimer=setTimeout(()=>resolve({type:'unsettled'}),cleanupWaitMs)})]);
      if(drained.type==='unsettled')throw new CompactionStopError('COMPACTION_UNSETTLED',{cause:controller.signal.reason});
      throw controller.signal.reason;
    }
    if(controller.signal.aborted)throw controller.signal.reason;
    if(first.type==='error')throw first.error;
    return {result:first.value,auxiliaryCalls:calls,deltas,bytes};
  }finally{
    clearTimeout(timer);clearTimeout(cleanupTimer);
    signal?.removeEventListener('abort',externalAbort);
    // The listener remains until the still-running operation settles.
    if(settled)release();
  }
}
