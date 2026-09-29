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
  if(interrupted?.type!=='assistant/message'||interrupted.data?.interrupted!==true||
      !Array.isArray(interrupted.data.message?.content)||
      !interrupted.data.message.content.some(block=>block?.type==='reasoning'))
    throw new RecoveryStopped('INTERRUPTED_TAIL_UNAVAILABLE');
  if(interrupted.data.message.source?.provider!==provider||
      interrupted.data.message.source?.model!==model)
    throw new RecoveryStopped('RECOVERY_ROUTE_MISMATCH');
  assertInboxUnchanged(parent,parkedInbox);
  const notice=createUserMessage({content:[{type:'text',text:
    'The preceding assistant generation was stopped because its reasoning repeated. Its interrupted output is excluded from this conversation. Continue the unfinished user task from the earlier messages. Check current workspace state before changing it; do not repeat completed operations.'}],
    source:{kind:'plugin',plugin:'dsh-rice-patrol'}});
  // Recheck immediately before the irreversible append. No model call or
  // compaction runs during this handoff.
  if(session.surface.nodes.at(-1)!==lastSeq)throw new RecoveryStopped('HANDOFF_SURFACE_CHANGED');
  session.append('user/message',notice,{surfaceOp:{op:'replace',startSeq:lastSeq,endSeq:lastSeq},
    sourceEventSeqs:[lastSeq]});
  await ctx.sessions.flush(session);
  signal?.throwIfAborted();
  assertInboxUnchanged(parent,parkedInbox);
  const continuation=createUserMessage({content:[{type:'text',text:
    'Continue the unfinished task in this session. Follow any queued user instructions first. Verify the workspace before side effects and do not repeat completed operations.'}],
    source:{kind:'plugin',plugin:'dsh-rice-patrol'}});
  onResumeQueued({messageId:continuation.id});
  if(parkedInbox.nextTurn.length||parkedInbox.nextStep.length)parent.steer(continuation);
  else parent.followup(continuation);
  return {mainAgent:true,modelKey:`${provider}/${model}`,handoffCommitted:true,
    resumeMessageId:continuation.id,shadowedSeq:lastSeq};
}
