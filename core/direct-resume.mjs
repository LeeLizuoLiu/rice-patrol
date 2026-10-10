import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {RecoveryStopped} from './recovery-state.mjs';
import {assertInboxUnchanged,snapshotInbox} from './recovery-inbox.mjs';

// Shadow only the interrupted model output. The original event remains in the
// append-only log for the UI and audit, but cannot enter the next model request.
export async function commitDirectResume({ctx,parent,provider,model,signal,
  parkedInbox=snapshotInbox(parent),onResumeQueued=()=>{}}){
  signal?.throwIfAborted();
  const session=parent.session;
  const nodes=[...session.surface.nodes];
  const lastSeq=nodes.at(-1);
  const interrupted=session.eventAt(lastSeq);
  // 0.2 records a cancelled, unfinished stream as assistant/attempt rather
  // than committing an interrupted assistant/message onto the surface.
  const latestAttempt=session.log.filter(e=>e.type==='assistant/attempt').at(-1);
  const latestEnd=session.log.filter(e=>e.type==='turn/end').at(-1);
  const request=session.log.filter(e=>e.type==='request/context'&&e.seq<latestAttempt?.seq).at(-1);
  const cancelledAttempt=latestAttempt&&latestEnd&&latestAttempt.seq>lastSeq&&
    latestEnd.data?.turn===latestAttempt.data?.turn&&latestEnd.seq>latestAttempt.seq&&
    latestEnd.data?.reason?.kind==='aborted'&&
    latestEnd.data?.reason?.reason?.reason==='reasoning-guard:REASONING_LOOP_CONFIRMED'&&
    latestAttempt.data?.stream?.some(item=>item.chunk?.blockType==='reasoning')&&
    !session.log.some(e=>e.type==='assistant/message'&&e.seq>latestAttempt.seq);
  if(!cancelledAttempt&&(interrupted?.type!=='assistant/message'||interrupted.data?.interrupted!==true||
      !Array.isArray(interrupted.data.message?.content)||
      !interrupted.data.message.content.some(block=>block?.type==='reasoning')))
    throw new RecoveryStopped('INTERRUPTED_TAIL_UNAVAILABLE');
  const route=cancelledAttempt?request?.data:interrupted.data.message.source;
  if(route?.provider!==provider||route?.model!==model)
    throw new RecoveryStopped('RECOVERY_ROUTE_MISMATCH');
  assertInboxUnchanged(parent,parkedInbox);
  const notice=createUserMessage({content:[{type:'text',text:
    'The preceding assistant generation was stopped because its reasoning repeated. Its interrupted output is excluded from this conversation. Continue the unfinished user task from the earlier messages. Check current workspace state before changing it; do not repeat completed operations.'}],
    source:{kind:'plugin:dsh-rice-patrol'}});
  // Recheck immediately before the irreversible append. No model call or
  // compaction runs during this handoff.
  if(session.surface.nodes.at(-1)!==lastSeq)throw new RecoveryStopped('HANDOFF_SURFACE_CHANGED');
  session.append('user/message',notice,{surfaceOp:cancelledAttempt?'append':{op:'replace',startSeq:lastSeq,endSeq:lastSeq},
    sourceEventSeqs:[cancelledAttempt?latestAttempt.seq:lastSeq]});
  await ctx.sessions.flush(session);
  signal?.throwIfAborted();
  assertInboxUnchanged(parent,parkedInbox);
  const continuation=createUserMessage({content:[{type:'text',text:
    'Continue the unfinished task in this session. Follow any queued user instructions first. Verify the workspace before side effects and do not repeat completed operations.'}],
    source:{kind:'plugin:dsh-rice-patrol'}});
  onResumeQueued({messageId:continuation.id});
  if(parkedInbox.nextTurn.length||parkedInbox.nextStep.length)parent.steer(continuation);
  else parent.followup(continuation);
  return {mainAgent:true,modelKey:`${provider}/${model}`,handoffCommitted:true,
    resumeMessageId:continuation.id,shadowedSeq:cancelledAttempt?null:lastSeq,attemptSeq:cancelledAttempt?latestAttempt.seq:undefined};
}
