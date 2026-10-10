import test from 'node:test';
import assert from 'node:assert/strict';
import {markAgentLoopRequest} from '@deepseek-ai/dsh-llm';
import {createHostCancellation} from '../core/host-cancellation.mjs';
import {createGuardedStream} from '../core/controller.mjs';
import {validateConfig} from '../core/config.mjs';
import {matchesRoute} from '../core/route.mjs';
import {validateSettings} from '../settings.mjs';

const loop='OK.\n'.repeat(100);
const finish={type:'finish',reason:{kind:'stop'}};
const collect=async stream=>{const out=[];for await(const chunk of stream)out.push(chunk);return out};
const config=(extra={})=>validateConfig({mode:'enforce',cleanupWaitMs:20,...extra});

function harness(){
  const handlers=new Map(),rows=[];
  const ctx={on(type,fn,{prepend=false}={}){
    const list=handlers.get(type)??[];
    if(prepend)list.unshift(fn);else list.push(fn);
    handlers.set(type,list);
    return ()=>{const index=list.indexOf(fn);if(index>=0)list.splice(index,1)};
  },effect(){}};
  const sink={status:{runId:'synthetic-generic-core'},record(type,data={}){rows.push({type,...data});return true},
    async flush(){},async close(){}};
  async function request({sessionId='session-a',turn=1,step=1,provider='provider-a',model='model-a',
    signal=new AbortController().signal,agent}={}){
    const payload={agent:agent??{session:{id:sessionId}},turn,step,signal};
    let i=0;const list=[...(handlers.get('agent/request')??[])];
    const route=await (async function next(){return i<list.length?list[i++](payload,next):{provider,model}})();
    return markAgentLoopRequest(Object.freeze({sessionId,turn,step,...route,signal}));
  }
  async function stream(options,chunks){
    const list=[...(handlers.get('llm/stream')??[])];let i=0;
    const next=()=>i<list.length?list[i++](options,next):(async function*(){yield* chunks})();
    return collect(next());
  }
  function event(sessionId,type,data,seq=1){
    for(const fn of handlers.get('session/event')??[])fn({id:sessionId},{type,data,seq});
  }
  return {ctx,sink,rows,handlers,request,stream,event};
}

test('public cancellation leases isolate requests, consume one claim and reject stale handles',async()=>{
  const h=harness(),cancellation=createHostCancellation(h.ctx),calls=[];
  const ac=new AbortController(),agent={session:{id:'session-a'},cancel:(...args)=>calls.push(args)};
  const first=await h.request({signal:ac.signal,agent});
  assert.throws(()=>cancellation.claim({...first,sessionId:'other-session'}),/GUARD_CAPABILITY_MISSING/);
  const stale=cancellation.claim(first);
  assert.throws(()=>cancellation.claim(first),/GUARD_CAPABILITY_MISSING/);
  const retry=await h.request({signal:ac.signal,agent});
  const current=cancellation.claim(retry);
  assert.equal(stale.cancel('STALE'),false);
  stale.release();assert.equal(cancellation.activeCount,1);
  assert.equal(current.cancel('CURRENT'),true);
  assert.deepEqual(calls,[[{kind:'hook',reason:'reasoning-guard:CURRENT'},{keepInbox:true}]]);
  current.release();current.release();
  assert.equal(current.cancel('RELEASED'),false);
  assert.equal(cancellation.activeCount,0);
  cancellation.dispose();
  assert.throws(()=>cancellation.claim(retry),/GUARD_CAPABILITY_MISSING/);
});

test('public cancellation uses an immutable JSON cause and preserves an earlier user abort',async()=>{
  const h=harness(),cancellation=createHostCancellation(h.ctx),ac=new AbortController(),calls=[];
  const agent={session:{id:'session-a'},cancel:(cause,options)=>{calls.push({cause,options});ac.abort(cause)}};
  const options=await h.request({signal:ac.signal,agent}),lease=cancellation.claim(options);
  assert.equal(lease.cancel('REASONING_LOOP_CONFIRMED'),true);
  assert.equal(lease.cancel('LATER'),false);
  assert.equal(Object.isFrozen(ac.signal.reason),true);
  assert.throws(()=>Object.defineProperty(ac.signal.reason,'stack',{value:'synthetic stack'}),TypeError);
  assert.deepEqual(Reflect.ownKeys(ac.signal.reason),['kind','reason']);
  assert.deepEqual(JSON.parse(JSON.stringify(ac.signal.reason)),calls[0].cause);
  const user=new AbortController(),userCause={kind:'user'},userCalls=[];
  const second=await h.request({sessionId:'session-b',signal:user.signal,
    agent:{session:{id:'session-b'},cancel:reason=>userCalls.push(reason)}});
  const userLease=cancellation.claim(second);user.abort(userCause);
  assert.equal(userLease.cancel('LATE_GUARD'),false);
  assert.equal(user.signal.reason,userCause);assert.deepEqual(userCalls,[]);
  lease.release();userLease.release();cancellation.dispose();
});

test('failed request admission cannot issue cancellation and dispose cancels only live leases',async()=>{
  const h=harness(),cancellation=createHostCancellation(h.ctx),calls=[];
  const badSignal=new AbortController().signal;
  const offFail=h.ctx.on('agent/request',async()=>{throw new Error('synthetic admission failure')});
  await assert.rejects(h.request({signal:badSignal}),/admission failure/);
  assert.throws(()=>cancellation.claim({signal:badSignal,sessionId:'session-a'}),/GUARD_CAPABILITY_MISSING/);
  offFail();
  for(const id of ['a','b']){
    const options=await h.request({sessionId:id,agent:{session:{id},cancel:reason=>calls.push({id,reason})}});
    const lease=cancellation.claim(options);if(id==='a')lease.release();
  }
  cancellation.dispose();cancellation.dispose();
  assert.deepEqual(calls,[{id:'b',reason:{kind:'hook',reason:'reasoning-guard:PLUGIN_DISPOSED'}}]);
  assert.equal(cancellation.activeCount,0);
});

test('wildcard defaults cover arbitrary providers and models with optional exact filters',()=>{
  const defaultDirectory=validateSettings().stateDirectory;
  assert.ok(defaultDirectory.endsWith('/rice-patrol-state'));
  assert.ok(defaultDirectory.startsWith('/'));
  const defaults=validateSettings({stateDirectory:'/tmp/synthetic-guard'});
  assert.equal(defaults.provider,'*');assert.equal(defaults.model,'*');
  assert.equal(matchesRoute(defaults,{provider:'vendor-x',model:'model-without-effort'}),true);
  assert.equal(matchesRoute({...defaults,provider:'vendor-x'},{provider:'vendor-y',model:'any'}),false);
  assert.equal(matchesRoute({...defaults,model:'model-x'},{provider:'vendor-y',model:'model-x'}),true);
  assert.equal(matchesRoute({provider:'vendor-*',model:'*'},{provider:'vendor-x',model:'model-x'}),false);
  assert.equal(matchesRoute(defaults,{provider:'vendor-x'}),false);
  assert.deepEqual([validateConfig().provider,validateConfig().model],['*','*']);
  for(const value of ['',null,14,'   ']){
    assert.throws(()=>validateSettings({stateDirectory:'/tmp/synthetic-guard',provider:value}),/provider/);
    assert.throws(()=>validateConfig({model:value}),/model/);
  }
});

test('generic stream emits settled cleanup after a confirmed stop without replacing the reason',async()=>{
  const events=[],cancel=[];let returned=0;
  const source=()=>({[Symbol.asyncIterator](){return {
    async next(){return {done:false,value:{type:'reasoning-delta',text:loop}}},
    async return(){returned++;return {done:true}}
  }}});
  await assert.rejects(collect(createGuardedStream({},source,config(),{
    cancelTransport:reason=>cancel.push(reason),onEvent:event=>events.push(event)
  })),error=>error.code==='REASONING_LOOP_CONFIRMED');
  assert.deepEqual(cancel,['REASONING_LOOP_CONFIRMED']);assert.equal(returned,1);
  assert.deepEqual(events.filter(e=>e.status==='STREAM_CLEANUP').map(e=>e.reason),['SETTLED']);
  assert.equal(events.filter(e=>e.status==='TERMINATED').length,1);
  assert.equal(events.at(-1).status,'STREAM_CLEANUP');
});

test('async return rejection is failed cleanup and never overwrites the guard decision',async()=>{
  const events=[];
  const source=()=>({[Symbol.asyncIterator](){return {
    async next(){return {done:false,value:{type:'reasoning-delta',text:loop}}},
    async return(){await Promise.resolve();throw new Error('synthetic cleanup failure')}
  }}});
  await assert.rejects(collect(createGuardedStream({},source,config(),{
    cancelTransport:()=>{},onEvent:event=>events.push(event)
  })),error=>error.code==='REASONING_LOOP_CONFIRMED');
  assert.deepEqual(events.filter(e=>e.status==='STREAM_CLEANUP').map(e=>e.reason),['FAILED']);
  assert.deepEqual(events.filter(e=>e.status==='TERMINATED').map(e=>e.reason),['REASONING_LOOP_CONFIRMED']);
});

test('unsettled cleanup is bounded and a later return does not revise its outcome',async()=>{
  const events=[];let release;
  const source=()=>({[Symbol.asyncIterator](){return {
    async next(){return {done:false,value:{type:'reasoning-delta',text:loop}}},
    return(){return new Promise(resolve=>{release=resolve})}
  }}});
  await assert.rejects(collect(createGuardedStream({},source,config({cleanupWaitMs:5}),{
    cancelTransport:()=>{},onEvent:event=>events.push(event)
  })),error=>error.code==='REASONING_LOOP_CONFIRMED');
  assert.deepEqual(events.filter(e=>e.status==='STREAM_CLEANUP').map(e=>e.reason),['UNSETTLED']);
  release({done:true});await Promise.resolve();await Promise.resolve();
  assert.equal(events.filter(e=>e.status==='STREAM_CLEANUP').length,1);
});

test('ordinary finish passes through with settled cleanup and no active cancellation',async()=>{
  const events=[],cancel=[];
  const output=[{type:'text-delta',text:'Synthetic complete answer.'},finish];
  const stream=createGuardedStream({},()=>({async *[Symbol.asyncIterator](){yield* output}}),config(),{
    cancelTransport:reason=>cancel.push(reason),onEvent:event=>events.push(event)
  });
  assert.deepEqual(await collect(stream),output);assert.deepEqual(cancel,[]);
  assert.deepEqual(events.filter(e=>e.status==='STREAM_CLEANUP').map(e=>e.reason),['SETTLED']);
  assert.equal(events.some(e=>e.status==='TERMINATED'),false);
});
