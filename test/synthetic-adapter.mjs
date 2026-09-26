import assert from 'node:assert/strict';
import {host} from './host-runtime.mjs';

const {LlmAdapter,attributionHeaders}=await host('@deepseek-ai/dsh-llm');

// Test-only, credential-free adapter. All generation uses DSH's public
// prepareCall/stream contract and its supplied AbortSignal, never a guard bridge.
export class SyntheticHttpAdapter extends LlmAdapter {
  constructor(origin,trace,{ignoreCancellation=false}={}){
    super();
    assert.equal(new URL(origin).hostname,'127.0.0.1');
    this.origin=origin;this.trace=trace;this.ignoreCancellation=ignoreCancellation;
  }
  providerInfo(id){return {id,name:`Synthetic ${id}`}}
  async resolveModel(provider,model,signal){
    signal?.throwIfAborted();
    return {provider,id:model,name:model,...(model==='reasoning-model-a'?{reasoning:{efforts:[{id:'high',name:'High'}]}}:{})};
  }
  async prepareCall(provider,model,signal){
    signal?.throwIfAborted();
    this.trace.prepared.push({provider,model});
    return {model:await this.resolveModel(provider,model,signal),stream:options=>{
      const stream=this.dispatch(options);
      if(!this.ignoreCancellation)return stream;
      // A deliberately broken provider used solely to prove recovery refuses
      // to start a second generation while cleanup cannot be confirmed.
      this.trace.releaseIgnored.push(()=>stream.return());
      return {next:()=>stream.next(),return:()=>new Promise(()=>{}),[Symbol.asyncIterator](){return this}};
    }};
  }
  stream(){throw Error('The prepared call must use its captured dispatch, not adapter.stream')}
  async *dispatch(options){
    // AgentLoop freezes its request; auxiliary callers may pass mutable options.
    if(options.purpose!=='compaction')assert.ok(Object.isFrozen(options));
    assert.ok(options.signal instanceof AbortSignal);
    const request={provider:options.provider,model:options.model,sessionId:options.sessionId,
      purpose:options.purpose,messages:options.messages,
      ...(options.reasoningEffort===undefined?{}:{reasoningEffort:options.reasoningEffort})};
    const entry={...request,aborted:false};this.trace.streams.push(entry);
    const aborted=()=>{entry.aborted=true};
    options.signal.addEventListener('abort',aborted,{once:true});
    let reader;
    try{
      const response=await fetch(`${this.origin}/synthetic-stream`,{method:'POST',
        headers:{'content-type':'application/json',...attributionHeaders()},
        body:JSON.stringify(request),...(this.ignoreCancellation?{}:{signal:options.signal})});
      assert.equal(response.status,200);
      reader=response.body.getReader();
      const decoder=new TextDecoder();let pending='';
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        pending+=decoder.decode(value,{stream:true});
        let end;
        while((end=pending.indexOf('\n'))>=0){
          const line=pending.slice(0,end);pending=pending.slice(end+1);
          if(line)yield JSON.parse(line);
        }
      }
      assert.equal(pending,'','fake upstream always ends on a full chunk boundary');
    }finally{
      options.signal.removeEventListener('abort',aborted);
      await reader?.cancel().catch(()=>{});reader?.releaseLock();
    }
  }
}

export const chunk=(response,value)=>response.write(`${JSON.stringify(value)}\n`);
export function finish(response,text='SYNTHETIC_FINISHED'){
  chunk(response,{type:'block-start',index:0,blockType:'text'});
  chunk(response,{type:'text-delta',index:0,text});
  chunk(response,{type:'block-end',index:0,block:{type:'text',text}});
  chunk(response,{type:'finish',reason:{kind:'stop'}});response.end();
}
export function tool(response,name,id,args={}){
  chunk(response,{type:'block-start',index:0,blockType:'tool-call'});
  chunk(response,{type:'tool-call-delta',index:0,id,name,argumentsDelta:JSON.stringify(args)});
  chunk(response,{type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}});
  chunk(response,{type:'finish',reason:{kind:'tool-calls'}});response.end();
}
export function loop(response,{complete=false}={}){
  const text='Let me try.\n'.repeat(100);
  chunk(response,{type:'block-start',index:1,blockType:'reasoning'});
  chunk(response,{type:'reasoning-delta',index:1,text});
  if(complete)chunk(response,{type:'block-end',index:1,block:{type:'reasoning',text}});
}
