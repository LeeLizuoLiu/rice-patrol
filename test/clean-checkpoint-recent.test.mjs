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

test('a prior Rice Patrol child catalog is metadata; other subagent catalogs still block handoff',()=>{
  const {events}=completedHistory(0);
  const catalog={seq:events.at(-1).seq+1,type:'subagent/catalog',data:{version:0,
    childId:'synthetic-child',childCreatedAt:1,mode:'one-shot',label:'Research Guard recovery'}};
  const options={sessionId:'synthetic-history',modelKey:'synthetic-model',
    guardEpisodeId:'synthetic-episode',turnSettled:true,toolsSettled:true,recentHistory:true};
  assert.ok(buildCleanCheckpoint([...events,catalog],options).text);
  assert.throws(()=>buildCleanCheckpoint([...events,{...catalog,data:{...catalog.data,
    label:'unrelated subagent'}}],options),error=>error.code==='UNSUPPORTED_SESSION_EVENT');
});

test('clean checkpoint preserves a user image by durable reference without copying interrupted reasoning',()=>{
  const ref={attachmentId:`sha256:${'a'.repeat(64)}`,mediaType:'image/png',bytes:128,width:8,height:8,name:'diagram.png'};
  const events=[
    {seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'user/message',surfaceOp:'append',data:{role:'user',id:'image-user',source:{kind:'user'},
      content:[{type:'text',text:'Inspect the diagram.'},{type:'image',attachment:ref}]}},
    {seq:2,type:'step/start',data:{turn:1,step:1}},
    {seq:3,type:'assistant/message',surfaceOp:'append',data:{message:{content:[{type:'reasoning',text:'SINGING_SECRET'}]},interrupted:true}},
    {seq:4,type:'step/end',data:{turn:1,step:1}},
    {seq:5,type:'turn/end',data:{turn:1,reason:{kind:'aborted'}}}
  ];
  const opts={sessionId:'image-session',modelKey:'synthetic/model',guardEpisodeId:'image-episode',
    turnSettled:true,toolsSettled:true,recentHistory:true};
  const checkpoint=buildCleanCheckpoint(events,opts);
  assert.equal(checkpoint.handoffImages.length,1);
  assert.deepEqual(checkpoint.handoffImages[0],{eventId:'image-session#1',contentIndex:1,
    block:{type:'image',attachment:ref}});
  assert.deepEqual(checkpoint.mandatoryFacts.userMessages[0].images,
    [{contentIndex:1,attachmentId:ref.attachmentId,mediaType:ref.mediaType,bytes:ref.bytes}]);
  assert.ok(!checkpoint.text.includes('SINGING_SECRET'));
  assert.ok(!checkpoint.text.includes('diagram.png'));
  const bad=structuredClone(events);delete bad[1].data.content[1].attachment.attachmentId;
  assert.throws(()=>buildCleanCheckpoint(bad,opts),error=>error.code==='UNSUPPORTED_USER_CONTENT');
});

test('many validated historical compactions use a bounded provenance ledger in the handoff',()=>{
  const events=[];let seq=0;
  const append=(type,data,extra={})=>{const event={seq:++seq,type,data,...extra};events.push(event);return event};
  append('turn/start',{turn:1});
  const user=append('user/message',{role:'user',id:'user-1',source:{kind:'user'},
    content:[{type:'text',text:'Complete the original task.'}]},{surfaceOp:'append'});
  append('step/start',{turn:1,step:1});
  let current=user.seq;
  let shadowedIdChars=0;
  for(let index=0;index<16;index++){
    const compactionId=`compaction-${index}`;
    const shadowedSeqs=[current];
    for(let row=0;row<140;row++){
      const message=append('assistant/message',{message:{content:[]}}, {surfaceOp:'append'});
      shadowedSeqs.push(message.seq);
    }
    shadowedIdChars+=shadowedSeqs.reduce((sum,value)=>sum+`compacted-session#${value}`.length,0);
    append('compaction/start',{compactionId,turn:1});
    append('compaction/summary',{compactionId,shadowedRange:{start:current,end:shadowedSeqs.at(-1)},
      shadowedSeqs,summary:[{type:'text',text:`model summary ${index}`}]});
    const replacement=append('user/message',{role:'user',id:`summary-${index}`,
      source:{kind:'plugin',plugin:'compact',compactionId},
      content:[{type:'text',text:`model summary ${index}`}]},
    {surfaceOp:{op:'replace',startSeq:current,endSeq:shadowedSeqs.at(-1)},sourceEventSeqs:shadowedSeqs});
    append('compaction/end',{compactionId,turn:1});
    current=replacement.seq;
  }
  append('step/end',{turn:1,step:1});append('turn/end',{turn:1,reason:{kind:'completed'}});
  const checkpoint=buildCleanCheckpoint(events,{sessionId:'compacted-session',modelKey:'test-model',
    guardEpisodeId:'guard-1',turnSettled:true,toolsSettled:true,recentHistory:true,
    maxCleanInputChars:128000,maxMandatoryChars:48000});
  assert.equal(checkpoint.mandatoryFacts.historicalCompactionLedger.count,16);
  assert.ok(shadowedIdChars>48000,'full historical compaction ids would exceed the mandatory facts budget');
  assert.match(checkpoint.mandatoryFacts.historicalCompactionLedger.sha256,/^[0-9a-f]{64}$/);
  assert.equal(checkpoint.mandatoryFacts.historicalCompactionLedger.latestEndEventId,`compacted-session#${current+1}`);
  assert.ok(!checkpoint.text.includes('model summary'));
  assert.equal(checkpoint.mandatoryFacts.userMessages[0].text,'Complete the original task.');
});
