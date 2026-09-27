import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCleanCheckpoint,operationKeyForTool} from '../core/clean-checkpoint.mjs';

function completedHistory(count,{errorAt=-1}={}){
  const events=[];let seq=0;
  const append=(type,data,surfaceOp)=>events.push({seq:++seq,type,data,...(surfaceOp?{surfaceOp}:{})});
  append('turn/start',{turn:1});append('step/start',{turn:1,step:1});
  append('user/message',{role:'user',id:'user-1',source:{kind:'user'},content:[{type:'text',text:'Finish the original task.'}]},'append');
  const keys=[];
  for(let index=0;index<count;index++){
    const callId=`call-${index}`,args=JSON.stringify({label:`operation-${index}`});
    const callSeq=seq+1;
    append('tool/call',{turn:1,step:1,callId,name:'write',arguments:args});
    append('tool/result',{turn:1,step:1,message:{role:'user',id:`result-${index}`,
      source:{kind:'tool',callId},content:[{type:'tool-result',toolCallId:callId,
        content:[{type:'text',text:`done-${index}`}],isError:index===errorAt}]}},'append');
    events.at(-1).sourceEventSeqs=[callSeq];
    keys.push(operationKeyForTool('write',args));
  }
  append('step/end',{turn:1,step:1});append('turn/end',{turn:1,reason:{kind:'completed'}});
  return {events,keys};
}

test('recent operation queue evicts the oldest at 129 while preserving all replay fingerprints',()=>{
  const {events,keys}=completedHistory(130);
  const checkpoint=buildCleanCheckpoint(events,{sessionId:'synthetic-history',modelKey:'synthetic-model',
    guardEpisodeId:'synthetic-episode',turnSettled:true,toolsSettled:true,recentHistory:true,
    maxRecentOperations:128,maxOperations:4096,maxCleanInputChars:128000,maxMandatoryChars:48000});
  const payload=JSON.parse(checkpoint.text),window=payload.mandatoryFacts.recentOperationWindow;
  assert.equal(window.length,128);
  assert.equal(window[0].callSeq,8);
  assert.equal(window.at(-1).callSeq,4+2*129);
  assert.equal(payload.mandatoryFacts.completedOperationLedger.count,130);
  assert.equal(payload.mandatoryFacts.completedOperations.length,16);
  assert.equal(checkpoint.completedOperationKeys.length,130);
  assert.equal(checkpoint.completedSideEffectKeys.length,130);
  assert.ok(checkpoint.completedSideEffectKeys.includes(keys[0]));
  assert.ok(checkpoint.completedSideEffectKeys.includes(keys.at(-1)));
  assert.ok(!window.some(row=>row.callSeq===4));
});

test('settled tool errors remain recorded as uncertain work instead of blocking history parsing',()=>{
  const {events,keys}=completedHistory(3,{errorAt:1});
  const checkpoint=buildCleanCheckpoint(events,{sessionId:'synthetic-errors',modelKey:'synthetic-model',
    guardEpisodeId:'synthetic-episode',turnSettled:true,toolsSettled:true,recentHistory:true});
  assert.equal(checkpoint.mandatoryFacts.completedOperations[1].status,'error-recorded');
  assert.equal(checkpoint.mandatoryFacts.completedOperations[1].isError,true);
  assert.ok(checkpoint.completedSideEffectKeys.includes(keys[1]));
});
