import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRecoveryPrompt,verifyRecoveryImages} from '../core/recovery-prompt.mjs';
import {BoundedRecovery} from '../core/recovery-state.mjs';

const ref={attachmentId:`sha256:${'b'.repeat(64)}`,mediaType:'image/png',bytes:4,width:1,height:1};
const images=[{eventId:'session#2',contentIndex:1,block:{type:'image',attachment:ref}}];

test('recovery preflights durable images and gives only the fresh Agent structured user images',async()=>{
  const checked=[];
  const store={async readImage(value){checked.push(value);return {ref:value,data:new Uint8Array(4)}}};
  await verifyRecoveryImages(images,store);
  const prompt=await buildRecoveryPrompt('CLEAN_SUMMARY',images,store);
  assert.deepEqual(checked,[ref,ref]);
  assert.equal(prompt.length,3);
  assert.match(prompt[0].text,/CLEAN_SUMMARY/);
  assert.strictEqual(prompt[2],images[0].block);
  assert.equal(JSON.stringify(prompt).includes('SINGING_SECRET'),false);
});

test('missing image store or failed verification stops before constructing a child prompt',async()=>{
  await assert.rejects(buildRecoveryPrompt('summary',images,undefined),error=>error.code==='USER_IMAGE_UNAVAILABLE');
  await assert.rejects(buildRecoveryPrompt('summary',images,{readImage:async()=>{throw Error('missing')}}),
    error=>error.code==='USER_IMAGE_UNAVAILABLE');
  assert.equal((await buildRecoveryPrompt('summary',[],undefined)).length,1);
});

test('recovery carries verified image handoff into the main Agent continuation',async()=>{
  const recovery=new BoundedRecovery({compactAboveChars:10000});
  const trigger={taskId:'image-task',turnId:'1',modelKey:'synthetic/model',guardEpisodeId:'guard-one',
    reason:'guard-confirmed',userRevision:0,completedOperationKeys:[]};
  const facts={userMessages:[{eventId:'session#2',messageId:'user',text:'Inspect the image.',
    images:[{contentIndex:1,attachmentId:ref.attachmentId,mediaType:ref.mediaType,bytes:ref.bytes}]}],
    completedOperations:[],constraints:{source:'explicit-user-messages-preserved-verbatim'}};
  let received;
  const adapter={
    waitForStop:async()=>({guardCancelled:true,turnClosed:true,toolsSettled:true,
      guardEpisodeId:'guard-one',completedOperationKeys:[]}),
    prepareCleanCheckpoint:async()=>({modelKey:'synthetic/model',excludedGuardTail:true,
      provenance:'deterministic-clean',sourceEpisodeId:'guard-one',text:'summary',
      mandatoryFacts:facts,handoffImages:images}),
    resume:async args=>{received=args.handoffImages;return {mainAgent:true,handoffCommitted:true,modelKey:'synthetic/model'}}
  };
  const state=await recovery.recover(trigger,adapter);
  assert.equal(state.state,'completed');
  assert.strictEqual(received,images);
});
