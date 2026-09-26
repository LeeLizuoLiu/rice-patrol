import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import * as guard from './plugin.mjs';
import {createObserveLog} from './observe-log.mjs';
import {matchesRoute} from './route.mjs';

export const name='dsh-reasoning-guard-observe';

const safeKind=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,39}$/.test(value)
  ?value.toUpperCase().replaceAll('-','_'):null;

// This module has no provider adapter, credentials, transport, or test workspace.
// Link lifecycle at agent/request; classify only at the final llm/stream route.
export function installObserve(ctx,{provider='*',model='*',logPath,sink:givenSink,enabled=true,externalDetector=false}={}){
  if(typeof provider!=='string'||!provider||typeof model!=='string'||!model)
    throw new Error('observe provider and model are required');
  const sink=givenSink??createObserveLog(logPath);
  if(!sink?.record||!sink?.flush)throw new Error('observe metadata sink required');
  const active=new AsyncLocalStorage();
  const bySignal=new WeakMap(),byStep=new Map(),byTurn=new Map();
  const salt=sink.status.runId;
  const pseudonym=value=>createHash('sha256').update(salt).update(':').update(String(value)).digest('hex').slice(0,16);
  const stepKey=(sid,turn,step)=>`${sid}:${turn}:${step}`;
  const turnKey=(sid,turn)=>`${sid}:${turn}`;
  let requestNo=0,attemptNo=0,disposed=false;
  const offRequest=ctx.on('agent/request',async(payload,next)=>{
    const requestStartMonoMs=performance.now(),requestStartWallTimeMs=Date.now();
    const config=await next();
    const session=pseudonym(payload.agent.session.id);
    // A retry can change route while keeping the same turn signal and step.
    // Retire its prior correlation before any excluded request emits events.
    const previous=bySignal.get(payload.signal);
    if(previous?.request){
      if(!previous.ended)sink.record('REQUEST_END',{request:previous.request,attempt:previous.lastAttempt?.id??null,
        session:previous.session,turn:previous.turn,step:previous.step,reason:previous.lastAttempt?.finish??'REPLACED'});
      previous.ended=true;
      const sk=stepKey(previous.session,previous.turn,previous.step),tk=turnKey(previous.session,previous.turn);
      if(byStep.get(sk)===previous)byStep.delete(sk);
      if(byTurn.get(tk)===previous)byTurn.delete(tk);
    }
    const rec={request:null,session,turn:payload.turn,step:payload.step,
      requestStartMonoMs,requestStartWallTimeMs,lastAttempt:null,ended:false};
    bySignal.set(payload.signal,rec);
    return config;
  });
  const offStream=ctx.on('llm/stream',(options,next)=>{
    if(!matchesRoute({provider,model},options))return next();
    const rec=bySignal.get(options.signal);
    if(!rec){
      // Auxiliary calls have no agent/request event. Their owner records them
      // separately; do not attach them to an unrelated parent request.
      if(options.purpose==='compaction')return next();
      sink.record('OBSERVE_GAP',{reason:'REQUEST_LINK_MISSING'});return next();
    }
    if(!rec.request){
      rec.request=`${salt}:r${++requestNo}`;
      byStep.set(stepKey(rec.session,rec.turn,rec.step),rec);
      byTurn.set(turnKey(rec.session,rec.turn),rec);
      sink.record('REQUEST_START',{request:rec.request,session:rec.session,turn:rec.turn,step:rec.step,
        provider:options.provider,model:options.model,
        requestStartMonoMs:rec.requestStartMonoMs,requestStartWallTimeMs:rec.requestStartWallTimeMs});
    }
    return (async function*(){
      const attempt={id:`${salt}:a${++attemptNo}`,request:rec.request,first:false,text:false,usage:false,
        finish:null,reasoningDeltas:0,reasoningUtf16:0,reasoningBytes:0};
      rec.lastAttempt=attempt;
      sink.record('ATTEMPT_START',{request:rec.request,attempt:attempt.id,session:rec.session,turn:rec.turn,step:rec.step});
      let streamReason='STREAM_INTERRUPTED';
      try{
        const source=next()[Symbol.asyncIterator]();let complete=false;
        try{while(true){
          const result=await active.run(attempt,()=>source.next());
          if(result.done){complete=true;streamReason=attempt.finish??'STREAM_EXHAUSTED';break;}
          const chunk=result.value;
          if(!attempt.first){attempt.first=true;sink.record('FIRST_CHUNK',{request:rec.request,attempt:attempt.id});}
          if(chunk.type==='reasoning-delta'){
            const text=String(chunk.text??'');attempt.reasoningDeltas++;
            attempt.reasoningUtf16+=text.length;attempt.reasoningBytes+=Buffer.byteLength(text);
          }
          if(chunk.type==='text-delta'&&!attempt.text&&String(chunk.text??'').trim()){
            attempt.text=true;sink.record('FIRST_VISIBLE_TEXT',{request:rec.request,attempt:attempt.id});
          }
          if(chunk.type==='block-end'&&chunk.block?.type==='tool-call')
            sink.record('COMPLETE_TOOL_BLOCK',{request:rec.request,attempt:attempt.id,
              tool:pseudonym(chunk.block.id)});
          if(chunk.type==='usage'){
            attempt.usage=true;const u=chunk.usage??{};
            const fields=['inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens'];
            sink.record('PROVIDER_USAGE',{request:rec.request,attempt:attempt.id,
              ...Object.fromEntries(fields.map(k=>[k,Number.isFinite(u[k])?u[k]:null]))});
          }
          if(chunk.type==='finish'){
            attempt.finish=safeKind(chunk.reason?.kind)??'UNKNOWN';
            sink.record('MODEL_FINISH',{request:rec.request,attempt:attempt.id,reason:attempt.finish,
              reasoningDeltas:attempt.reasoningDeltas,reasoningUtf16:attempt.reasoningUtf16,
              reasoningBytes:attempt.reasoningBytes});
          }
          yield chunk;
        }}finally{if(!complete&&typeof source.return==='function')await active.run(attempt,()=>source.return());}
      }catch(error){streamReason='STREAM_ERROR';throw error;
      }finally{sink.record('STREAM_END',{request:rec.request,attempt:attempt.id,reason:streamReason,
        usageObserved:attempt.usage,reasoningDeltas:attempt.reasoningDeltas,
        reasoningUtf16:attempt.reasoningUtf16,reasoningBytes:attempt.reasoningBytes});}
    })();
  });
  const offSession=ctx.on('session/event',(session,event)=>{
    if(!['tool/call','tool/result','assistant/attempt','assistant/message','step/end','turn/end','llm/retry'].includes(event.type))return;
    const sid=pseudonym(session.id),d=event.data??{};
    const rec=Number.isInteger(d.step)?byStep.get(stepKey(sid,d.turn,d.step)):byTurn.get(turnKey(sid,d.turn));
    if(!rec)return; // Other models and archived events never enter the denominator.
    const base={request:rec.request,attempt:rec.lastAttempt?.id??null,session:sid,
      turn:Number.isInteger(d.turn)?d.turn:null,step:Number.isInteger(d.step)?d.step:null,
      archiveSeq:Number.isInteger(event.seq)?event.seq:null};
    if(event.type==='tool/call')sink.record('HOST_TOOL_COMMIT',{...base,tool:pseudonym(d.callId)});
    else if(event.type==='tool/result')sink.record('HOST_TOOL_RESULT',{...base,
      tool:d.message?.content?.[0]?.toolCallId==null?null:pseudonym(d.message.content[0].toolCallId),
      toolError:d.message?.content?.[0]?.isError===true});
    else if(event.type==='assistant/attempt'||event.type==='assistant/message')
      sink.record('ASSISTANT_SETTLEMENT',{...base,kind:safeKind(event.type.replace('/','-')),
        interrupted:d.interrupted===true});
    else if(event.type==='llm/retry')sink.record('RETRY',{...base,delayMs:Number.isFinite(d.delayMs)?d.delayMs:null});
    else if(event.type==='step/end'){
      sink.record('REQUEST_END',{...base,reason:rec.lastAttempt?.finish??'NO_MODEL_FINISH'});
      byStep.delete(stepKey(sid,d.turn,d.step));rec.ended=true;
    }else if(event.type==='turn/end'){
      sink.record('TURN_END',{...base,reason:safeKind(d.reason?.kind),
        cancellationKind:safeKind(d.reason?.reason?.kind)});
      byTurn.delete(turnKey(sid,d.turn));
      rec.ended=true;
      for(const [key,open] of byStep)if(open.session===sid&&open.turn===d.turn)byStep.delete(key);
    }
  });
  const recordGuardEvent=(event,options)=>{
    const rec=bySignal.get(options.signal);
    if(!rec||rec.ended)return;
    const hit=event.status==='WARNING'?event.hit:event.confirmedHit;
    sink.record(event.status==='WARNING'?'WARNING':event.status==='CONFIRMED'?'CONFIRMED':'GUARD_METADATA',
      {request:rec.request,attempt:rec.lastAttempt?.id??null,session:rec.session,turn:rec.turn,step:rec.step,
        line:hit?.lineCount??null,offsetUtf16:hit?.offsetUtf16??null,deltaCount:hit?.deltaCount??null,
        reasoningBytes:event.reasoningBytes,consumed:event.consumed,forwarded:event.forwarded,
        ...(event.reason?{reason:event.reason}:{})});
  };
  const guardPlugin=enabled&&!externalDetector?guard.apply(ctx,{provider,model,mode:'observe'},{onEvent:recordGuardEvent}):null;
  sink.record('OBSERVER_READY',{mode:enabled?'observe':'off',provider,model});
  async function dispose(){
    if(disposed)return;disposed=true;
    guardPlugin?.();offSession();offStream();offRequest();
    sink.record('OBSERVER_STOP',{activeRequests:byStep.size});
    byStep.clear();byTurn.clear();
    await sink.close?.();await sink.flush();
  }
  ctx.effect?.(()=>dispose,'reasoning guard observe listener');
  return {dispose,recordGuardEvent,currentAttempt:()=>active.getStore()?.id??null,
    currentCorrelation:()=>({request:active.getStore()?.request??null,attempt:active.getStore()?.id??null}),
    activeCounts:()=>({steps:byStep.size,turns:byTurn.size})};
}

export function apply(ctx,config){return installObserve(ctx,config).dispose;}
