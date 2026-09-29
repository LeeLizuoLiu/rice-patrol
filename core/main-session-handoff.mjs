import {randomUUID} from 'node:crypto';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {compactCheckpointSource,toolPairingBalancedAfter,toolPairingBalancedBefore} from '@deepseek-ai/dsh-compaction';
import {RecoveryStopped} from './recovery-state.mjs';
import {assertInboxUnchanged,snapshotInbox} from './recovery-inbox.mjs';

// Called inside the parent's idle maintenance phase, after the auxiliary
// summary has finished. This is a model-visible surface replacement, not a
// follow-up containing a summary on top of the old reasoning tail.
export async function commitMainSessionHandoff({ctx,parent,checkpoint,images=[],provider,model,signal,
  parkedInbox=snapshotInbox(parent),onResumeQueued=()=>{}}){
  signal?.throwIfAborted();
  const session=parent.session;
  const nodes=[...session.surface.nodes];
  const first=session.eventAt(nodes[0])?.type==='system/message'?1:0;
  const shadowedSeqs=nodes.slice(first);
  if(!shadowedSeqs.length||typeof checkpoint!=='string'||!checkpoint.trim())
    throw new RecoveryStopped('HANDOFF_EMPTY');
  const start=shadowedSeqs[0],end=shadowedSeqs.at(-1);
  if(!toolPairingBalancedBefore(session,start)||!toolPairingBalancedAfter(session,end))
    throw new RecoveryStopped('HANDOFF_UNBALANCED_TOOLS');
  assertInboxUnchanged(parent,parkedInbox);
  const meter=ctx.get('tokenMeter');
  if(!meter?.measure||!meter?.estimateMessage)
    throw new RecoveryStopped('TOKEN_METER_UNAVAILABLE');
  const measured=meter.measure(session);
  if(measured.nodes.length!==nodes.length||nodes.some((seq,i)=>seq!==measured.nodes[i]?.seq))
    throw new RecoveryStopped('HANDOFF_SURFACE_CHANGED');
  const shadowed=measured.nodes.slice(first);
  const compactionId=randomUUID();
  const summary=[{type:'text',text:checkpoint}];
  const message=createUserMessage({content:[
    {type:'text',text:'Rice Patrol clean checkpoint. Continue the unfinished user task from the verified state below. Do not replay completed operations.\n\n'+checkpoint},
    ...images.flatMap(image=>[{type:'text',text:`Original user image ${image.eventId}, block ${image.contentIndex}:`},image.block])
  ],source:compactCheckpointSource(compactionId)});
  // In a short synthetic turn, the verified checkpoint can exceed the old
  // history. Correct exclusion of the bad tail is required; token savings are
  // only an optimization and must not gate recovery.
  // No await between the durable marker, summary, and replacement. An append
  // failure leaves a matching failure end marker where possible and never
  // wakes the parent into an unverified context.
  const marker={compactionId,turn:null};
  const startEvent=session.append('compaction/start',marker);
  try{
    signal?.throwIfAborted();
    const summaryEvent=session.append('compaction/summary',{
      compactionId,summary,shadowedRange:{start,end},shadowedSeqs,
      shadowedTokenCount:shadowed.reduce((sum,node)=>sum+node.heuristicTokens,0),provider,model,
      maxTokens:8192
    });
    session.append('user/message',message,{surfaceOp:{op:'replace',startSeq:start,endSeq:end},
      sourceEventSeqs:[startEvent.seq,summaryEvent.seq,...shadowedSeqs]});
    session.append('compaction/end',marker);
  }catch(error){
    try{session.append('compaction/end',{...marker,error:String(error?.code??error?.message??'HANDOFF_COMMIT_FAILED')})}catch{}
    throw error;
  }
  await ctx.sessions.flush(session);
  signal?.throwIfAborted();
  assertInboxUnchanged(parent,parkedInbox);
  const continuation=createUserMessage({content:[{type:'text',text:
    'Rice Patrol has completed a clean checkpoint for this stopped turn. Resume from that checkpoint. Preserve the authority of queued user instructions; they may change or replace the previous task. Inspect current workspace state before any side effect; do not repeat recorded completed operations.'}],
    source:{kind:'plugin',plugin:'dsh-rice-patrol'}});
  onResumeQueued({messageId:continuation.id,compactionId});
  // Steering is consumed together with the host's next queued user message.
  // Appending another ordinary follow-up would add a stale extra user turn.
  if(parkedInbox.nextTurn.length||parkedInbox.nextStep.length)parent.steer(continuation);
  else parent.followup(continuation);
  return {mainAgent:true,modelKey:`${provider}/${model}`,handoffCommitted:true,
    compactionId,resumeMessageId:continuation.id};
}
