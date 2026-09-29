import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import z from '@deepseek-ai/schemastery';
import * as guard from './core/plugin.mjs';
import {BoundedRecovery,RecoveryStopped} from './core/recovery-state.mjs';
import {createRecoveryLedger,recoverOnce} from './core/recovery-ledger.mjs';
import {commitDirectResume} from './core/direct-resume.mjs';
import {interceptRecoveryIntent} from './core/recovery-host-controls.mjs';
import {snapshotInbox,assertInboxUnchanged,extendParkedInbox} from './core/recovery-inbox.mjs';
import {createResumeReceipt} from './core/resume-receipt.mjs';
import {installObserve} from './core/observe-plugin.mjs';
import {createObserveLog} from './core/observe-log.mjs';
import {createStatusStore} from './status-store.mjs';
import {registerGuardRpc} from './web-rpc.mjs';
import {validateSettings} from './settings.mjs';
export const name='dsh-rice-patrol';
export const inject=['llm','tools','agents','sessions','tokenMeter','connection','settings','jobs'];
const ModeSettings=z.object({mode:z.string().default('stop')});
const endReason=agent=>agent.session.log.filter(e=>e.type==='turn/end').at(-1)?.data?.reason;
const guardEnded=agent=>endReason(agent)?.reason?.reason==='reasoning-guard:REASONING_LOOP_CONFIRMED';
const stoppedTurnId=agent=>{
  const start=agent.session.log.filter(e=>e.type==='turn/start').at(-1);
  const end=agent.session.log.filter(e=>e.type==='turn/end').at(-1);
  // Tie the allowance to the latest explicit user input, not a host-created
  // turn number. Automatic internal turns must not mint new recovery attempts.
  const user=agent.session.log.filter(e=>e.type==='user/message'&&e.data?.source?.kind==='user').at(-1);
  if(!Number.isSafeInteger(start?.seq)||start.seq<0||
      !Number.isSafeInteger(end?.seq)||end.seq<=start.seq||
      !Number.isSafeInteger(start.data?.turn)||start.data.turn<1||
      end.data?.turn!==start.data.turn||
      !Number.isSafeInteger(user?.seq)||user.seq<0||user.seq>=end.seq)
    throw new RecoveryStopped('TURN_ID_UNAVAILABLE');
  return String(user.seq);
};
const activeStates=new Set(['STOPPING','PREPARING','COMPACTING','RECOVERING','WAITING_RESUME']);
export async function apply(ctx,raw){
  const base=validateSettings(raw);
  // User choices are stored in DSH's settings document. A mode change applies
  // on the next host start, so in-flight turns keep their original guard.
  const scope=ctx.settings.register('rice-patrol',ModeSettings,{base:{mode:base.mode},
    applies:'restart',validate:value=>{if(!['observe','stop','recover'].includes(value.mode))throw Error('invalid guard mode')}});
  const config=validateSettings({...base,mode:scope.get().mode});
  const runtime=await installRuntime(ctx,config);
  ctx.effect(()=>async()=>{await runtime.dispose()},'research guard shutdown');
}
export async function installRuntime(ctx,raw){
  const config=validateSettings(raw),{provider,model}=config;
  await mkdir(config.stateDirectory,{recursive:true,mode:0o700});
  let observer,sink;const offs=[];
  try{
  const status=await createStatusStore(join(config.stateDirectory,'status'));
  sink=createObserveLog(join(config.stateDirectory,`events-${randomUUID()}.jsonl`));
  observer=installObserve(ctx,{provider,model,sink,externalDetector:true});
  const ledger=createRecoveryLedger(join(config.stateDirectory,'recovery'));
  const recovery=new BoundedRecovery(config);
  const active=new Map(),held=new Map(),jobs=new Set(),cleanups=new WeakMap();
  let disposed=false;
  const publish=async(record,state,reason)=>{
    const data={episodeId:record.episodeId,state,
      ...(reason?{reason}:{}),
      ...(recovery.status(record.taskId)?{compactCalls:recovery.status(record.taskId).compactCalls}:{})};
    record.state=state;
    await status.set(record.taskId,data);
    sink.record('RECOVERY_STAGE',{reason:state});
  };
  const interrupt=(record,reason='USER_STOPPED')=>{
    if(record.interrupted)return;
    record.interrupted=true;record.interruptReason=reason;
    record.userInterrupted=['USER_STOPPED','NEW_USER_INPUT'].includes(reason);
    recovery.userInterruption(record.taskId);record.controller.abort(new RecoveryStopped(reason));
    if(record.resumeMessageId){
      // Remove only our queued wake. Never discard the user's parked input.
      let removed=false;
      for(const [target,list] of [['next-turn',record.parent.inbox.nextTurn],['next-step',record.parent.inbox.nextStep]]){
        const index=list.findIndex(message=>message.id===record.resumeMessageId);
        if(index>=0){record.parent.inbox.splice(target,index,1,[]);removed=true}
      }
      if(!removed)record.parent.cancel({kind:'hook',reason:`rice-patrol:${reason}`},{keepInbox:true});
    }
  };
  // Direct resume leaves completed tool history in DSH. It does not inspect
  // other plugins' tool payloads or intercept their future executions.
  offs.push(registerGuardRpc(ctx,
    async(endpoint,payload)=>{
      if(!['research-guard/status','research-guard/stop','research-guard/dismiss'].includes(endpoint))return {ok:false,error:{code:'gateway/not-found',message:'Unknown endpoint',details:{}}};
      if(typeof payload?.sessionId!=='string'||!payload.sessionId||payload.sessionId.length>256)
        return {ok:false,error:{code:'gateway/bad-request',message:'Invalid session',details:{}}};
      if(endpoint==='research-guard/status'){let latest=await status.get(payload.sessionId);const live=active.has(payload.sessionId)&&recovery.status(payload.sessionId);if(latest?.dismissed)latest=null;if(latest&&live)latest={...latest,compactCalls:live.compactCalls};return {ok:true,value:{schema:1,episodes:latest?[latest]:[]}}}
      if(endpoint==='research-guard/dismiss'){
        if(typeof payload.episodeId!=='string'||!payload.episodeId||payload.episodeId.length>180)
          return {ok:false,error:{code:'gateway/bad-request',message:'Invalid episode',details:{}}};
        return {ok:true,value:{dismissed:await status.dismiss(payload.sessionId,payload.episodeId)}};
      }
      const record=active.get(payload.sessionId);
      const accepted=!!record&&record.episodeId===payload.episodeId&&activeStates.has(record.state);
      if(accepted)interrupt(record);
      return {ok:true,value:{accepted}};
    }));
  const offGuard=guard.apply(ctx,{provider,model,mode:config.mode==='observe'?'observe':'enforce',
    cancellation:config.mode==='observe'?null:'host-turn'},
    {onEvent:(event,options)=>{
      observer.recordGuardEvent(event,options);
      if(event.status==='STREAM_CLEANUP'){
        cleanups.get(options)?.(event.reason);cleanups.delete(options);return;
      }
      if(!['CONFIRMED','TERMINATED'].includes(event.status))return;
      const parent=ctx.agents.get(options.sessionId);if(!parent)return;
      if(config.mode==='observe'){
        if(event.status==='CONFIRMED')void status.set(parent.session.id,{episodeId:randomUUID(),state:'OBSERVED',reason:'REPETITION_CONFIRMED'}).catch(()=>{});
        return;
      }
      if(event.status!=='TERMINATED'||event.reason!=='REASONING_LOOP_CONFIRMED')return;
      // UI branches also have parentSession. Only delegated subagents are
      // excluded; a user-created branch remains an ordinary recovery root.
      if(parent.session.header.origin==='subagent'||disposed)return;
      const cleanup=new Promise(resolve=>cleanups.set(options,resolve));
      const previous=active.get(parent.session.id);
      if(previous){previous.nextGuard={parent,options,cleanup};return}
      beginRecovery(parent,options,cleanup);
    }});
  function beginRecovery(parent,options,cleanup){
      const record={taskId:parent.session.id,parent,episodeId:randomUUID(),state:'STOPPING',cleanup,
        userRevision:recovery.revision(parent.session.id),
        controller:new AbortController(),provider:options.provider,model:options.model,effort:options.reasoningEffort};
      active.set(record.taskId,record);
      record.offIntent=interceptRecoveryIntent(parent,reason=>{
        if(held.get(record.taskId)===record){
          held.delete(record.taskId);record.offIntent();return;
        }
        interrupt(record,reason);
      },{
        onBeforePark:()=>{if(record.parkedInbox)try{assertInboxUnchanged(parent,record.parkedInbox)}
          catch{record.inputChanged=true}},
        onPark:(target,message)=>{if(record.parkedInbox)extendParkedInbox(record.parkedInbox,target,message)}
      });
      const job=run(record).catch(async error=>{
        await publish(record,record.userInterrupted?'INTERRUPTED':'BLOCKED',record.interruptReason??error?.code??'INTEGRATION_ERROR').catch(()=>{});
      }).finally(()=>{
        record.receipt?.dispose();active.delete(record.taskId);jobs.delete(job);
        if(!record.interrupted&&['BLOCKED','STOPPED'].includes(record.state)){
          // Keep the Agent stopped when a child reports after recovery failed.
          // An explicit user prompt or stop releases the gate; the host then
          // processes the durable queued report under the user's direction.
          held.set(record.taskId,record);
        }else record.offIntent();
        // A very fast resumed response may loop before the old handoff finishes
        // publishing. Preserve that stop and its cleanup rather than dropping it.
        if(record.nextGuard&&!record.interrupted&&!disposed&&record.state!=='BLOCKED'){
          const next=record.nextGuard;beginRecovery(next.parent,next.options,next.cleanup);
        }
      });
      jobs.add(job);
  }
  async function run(record){
    const {parent,taskId,episodeId,provider,model}=record,modelKey=`${provider}/${model}`;
    await publish(record,'STOPPING');
    let timeout;
    let cleanup;
    try{[,cleanup]=await Promise.race([Promise.all([parent.whenIdle(),record.cleanup]),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new RecoveryStopped('STOP_TIMEOUT')),config.stopTimeoutMs)})])}
    finally{clearTimeout(timeout)}
    if(record.interrupted)throw new RecoveryStopped(record.interruptReason);
    if(!guardEnded(parent))throw new RecoveryStopped('STOP_NOT_SETTLED');
    if(cleanup!=='SETTLED')throw new RecoveryStopped('STREAM_CLEANUP_UNSETTLED');
    if(config.mode==='stop'){await publish(record,'STOPPED','REASONING_LOOP_CONFIRMED');return}
    const parkedInbox=record.parkedInbox=snapshotInbox(parent);
    const turnId=stoppedTurnId(parent);
    await publish(record,'PREPARING');
    // Completed PTC calls are historical evidence, not active jobs. The host's
    // job registry reports work that can outlive the tool call which started it.
    const hasProgramTools=parent.session.log.some(e=>e.type==='tool/ptc-dispatch-start'||
      e.type==='tool/call'&&e.data.name==='run_code');
    if(hasProgramTools&&!ctx.jobs?.list)throw new RecoveryStopped('JOB_REGISTRY_UNAVAILABLE');
    if(ctx.jobs?.list){
      let snapshots;
      try{snapshots=ctx.jobs.list(parent)}catch{throw new RecoveryStopped('JOB_REGISTRY_UNAVAILABLE')}
      if(!Array.isArray(snapshots)||snapshots.some(job=>
        !['completed','killed','failed'].includes(job.status)||job.reported!==true))
        throw new RecoveryStopped('ACTIVE_OR_UNREPORTED_JOB');
    }
    const result=await parent.runMaintenance(parentSignal=>{
      const signal=AbortSignal.any([parentSignal,record.controller.signal]);
      return recoverOnce({ledger,recovery,trigger:{taskId,turnId,modelKey,guardEpisodeId:episodeId,
        reason:'guard-confirmed',parentSignal:signal,userRevision:record.userRevision,completedOperationKeys:[]},adapter:{
        waitForStop:async({signal})=>{signal.throwIfAborted();if(record.inputChanged)throw new RecoveryStopped('PENDING_INPUT_CHANGED');
          assertInboxUnchanged(parent,parkedInbox);return {guardCancelled:guardEnded(parent),turnClosed:true,
          toolsSettled:true,guardEpisodeId:episodeId,completedOperationKeys:[]}},
        resumeWithoutCompaction:async({signal})=>{
          if(record.inputChanged)throw new RecoveryStopped('PENDING_INPUT_CHANGED');
          assertInboxUnchanged(parent,parkedInbox);
          await publish(record,'RECOVERING');
          record.receipt=createResumeReceipt({ctx,agent:parent,signal:record.controller.signal,timeoutMs:config.resumeTimeoutMs});
          return commitDirectResume({ctx,parent,provider,model,signal,parkedInbox,
            onResumeQueued:({messageId})=>{record.resumeMessageId=messageId;record.receipt.arm(messageId)}});
        }
      }});
    });
    if(result.state==='completed'){
      await publish(record,'WAITING_RESUME');
      const receipt=await record.receipt.wait();
      if(!receipt.ok){
        // The deadline only covers the first resumed response, never the
        // duration or tool/request count of the resumed task.
        if(receipt.reason==='RESUME_START_TIMEOUT')interrupt(record,receipt.reason);
        throw new RecoveryStopped(receipt.reason);
      }
    }
    const state=result.state==='completed'?'COMPLETED':result.state==='user_interrupted'?'INTERRUPTED':'BLOCKED';
    await publish(record,state,record.interruptReason??result.reason??undefined);
  }
  return {status,async stop(sessionId){const record=active.get(sessionId);if(record)interrupt(record);return !!record},
    async dispose(){if(disposed)return;disposed=true;for(const r of active.values())interrupt(r,'HOST_SHUTDOWN');
      for(const r of held.values())r.offIntent();held.clear();
      await Promise.allSettled([...jobs]);offGuard();for(const off of offs.reverse())await off();
      await observer.dispose();await status.flush();},config};
  }catch(error){for(const off of offs.reverse()){try{off()}catch{}}try{await observer?.dispose()}catch{}try{await sink?.close()}catch{}throw error}
}
