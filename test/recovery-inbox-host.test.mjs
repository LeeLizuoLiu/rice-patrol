import test from 'node:test';
import assert from 'node:assert/strict';
import {interceptRecoveryIntent} from '../core/recovery-host-controls.mjs';
import {snapshotInbox,assertInboxUnchanged,extendParkedInbox} from '../core/recovery-inbox.mjs';

function fakeAgent(){
  const calls={wakes:0,cancels:0};
  const inbox={nextTurn:[],nextStep:[],splice(target,_start,_removed,inserted){
    this[target==='next-turn'?'nextTurn':'nextStep'].push(...inserted);
  }};
  const agent={inbox,send(message,target,wakeup){inbox.splice(target,Infinity,0,[message]);if(wakeup)calls.wakes++},
    followup(message){this.send(message,'next-turn',true)},
    steer(message){this.send(message,'next-step',true)},
    cancel(){calls.cancels++}};
  return {agent,calls};
}
const message=(id,kind)=>({id,source:{kind,...(kind==='plugin'?{plugin:'dsh-rice-patrol'}:{})},
  content:[{type:'text',text:id}]});

test('child relays remain durable and cannot wake the Agent during recovery',()=>{
  const {agent,calls}=fakeAgent(),snapshot=snapshotInbox(agent),interrupts=[];
  const restore=interceptRecoveryIntent(agent,reason=>interrupts.push(reason),{
    onBeforePark:()=>assertInboxUnchanged(agent,snapshot),
    onPark:(target,item)=>extendParkedInbox(snapshot,target,item)});
  agent.followup(message('relay','agent-message'));
  agent.steer(message('notice','subagent-settled'));
  assert.equal(calls.wakes,0);
  assert.deepEqual(agent.inbox.nextTurn.map(item=>item.id),['relay']);
  assert.deepEqual(agent.inbox.nextStep.map(item=>item.id),['notice']);
  assertInboxUnchanged(agent,snapshot);
  agent.followup(message('handoff','plugin:dsh-rice-patrol'));
  assert.equal(calls.wakes,1,'only the verified handoff wakes the Agent');
  assert.deepEqual(interrupts,[]);
  restore();
});

test('a later explicit user prompt releases the gate and preserves parked child results',()=>{
  const {agent,calls}=fakeAgent(),interrupts=[];
  let restore;
  restore=interceptRecoveryIntent(agent,reason=>{interrupts.push(reason);restore()});
  agent.followup(message('relay','agent-message'));
  assert.equal(calls.wakes,0);
  agent.followup(message('new-prompt','user'));
  assert.deepEqual(interrupts,['NEW_USER_INPUT']);
  assert.equal(calls.wakes,1);
  assert.deepEqual(agent.inbox.nextTurn.map(item=>item.id),['relay','new-prompt']);
});
