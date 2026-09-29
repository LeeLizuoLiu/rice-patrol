import {createHash} from 'node:crypto';
import {RecoveryStopped} from './recovery-state.mjs';

// Parked input belongs to the host, not the summarizer. Retain it in place,
// including its order and contents, and detect edits while maintenance runs.
export function snapshotInbox(agent){
  const copy=messages=>messages.map(message=>({id:message.id,
    sha256:createHash('sha256').update(JSON.stringify(message)).digest('hex')}));
  return {nextTurn:copy(agent.inbox.nextTurn),nextStep:copy(agent.inbox.nextStep)};
}
export function assertInboxUnchanged(agent,snapshot){
  if(JSON.stringify(snapshotInbox(agent))!==JSON.stringify(snapshot))
    throw new RecoveryStopped('PENDING_INPUT_CHANGED');
}
export const parkedInboxIds=snapshot=>({
  'next-turn':snapshot.nextTurn.map(item=>item.id),'next-step':snapshot.nextStep.map(item=>item.id)
});
export function extendParkedInbox(snapshot,target,message){
  if(!snapshot||!['next-turn','next-step'].includes(target)||typeof message?.id!=='string')
    throw new RecoveryStopped('INVALID_PARKED_INPUT');
  snapshot[target==='next-turn'?'nextTurn':'nextStep'].push({id:message.id,
    sha256:createHash('sha256').update(JSON.stringify(message)).digest('hex')});
}
