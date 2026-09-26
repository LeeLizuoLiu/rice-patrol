// Pure checkpoint construction for DSH 0.1.6-alpha.2 session events. No model,
// filesystem, tool dispatch, or credential access occurs in this module.
import {createHash} from 'node:crypto';

export class CleanCheckpointError extends Error {
  constructor(code) { super(code); this.name='CleanCheckpointError'; this.code=code; }
}
const fail=code=>{throw new CleanCheckpointError(code)};
const sha=text=>createHash('sha256').update(text).digest('hex');
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=512;

// Canonicalization both makes fingerprints stable and refuses unsupported data.
// Bounds apply before allocating a complete serialization of an untrusted result.
function canonical(value,{maxChars=8_000_000,maxNodes=100_000}={}) {
  let chars=0,nodes=0;
  const seen=new Set();
  const visit=(item,depth)=>{
    if(++nodes>maxNodes||depth>40)fail('CHECKPOINT_CONTENT_LIMIT');
    let result;
    if(item===null)result='null';
    else if(typeof item==='string'){chars+=item.length;if(chars>maxChars)fail('CHECKPOINT_CONTENT_LIMIT');result=JSON.stringify(item)}
    else if(typeof item==='number'&&Number.isFinite(item))result=JSON.stringify(item);
    else if(typeof item==='boolean')result=String(item);
    else if(Array.isArray(item)||isObject(item)){
      if(seen.has(item))fail('CHECKPOINT_NON_JSON_CONTENT');
      seen.add(item);
      if(Array.isArray(item))result=`[${item.map(value=>visit(value,depth+1)).join(',')}]`;
      else result=`{${Object.keys(item).sort().map(key=>{
        chars+=key.length;if(chars>maxChars)fail('CHECKPOINT_CONTENT_LIMIT');
        return `${JSON.stringify(key)}:${visit(item[key],depth+1)}`;
      }).join(',')}}`;
      seen.delete(item);
    }else fail('CHECKPOINT_NON_JSON_CONTENT');
    if(result.length>maxChars)fail('CHECKPOINT_CONTENT_LIMIT');
    return result;
  };
  return visit(value,0);
}

function normalizedArguments(name,args,maxChars) {
  if(!identity(name)||typeof args!=='string'||args.length>maxChars)fail('INVALID_TOOL_CALL');
  let parsed;
  try{parsed=JSON.parse(args)}catch{fail('INVALID_TOOL_ARGUMENTS')}
  if(!isObject(parsed))fail('INVALID_TOOL_ARGUMENTS');
  return canonical(parsed,{maxChars});
}

// This is an exact normalized operation fingerprint, not proof of semantic
// equivalence or idempotence. Different shell strings can still do the same work.
export function operationKeyForTool(name,args,{maxChars=1_000_000}={}) {
  return `tool-sha256:${sha(canonical({name,arguments:normalizedArguments(name,args,maxChars)},{maxChars:maxChars+1024}))}`;
}

const SKIPPABLE=new Set([
  'assistant/message','assistant/attempt','system/message','session/end-seed',
  'request/header','request/context','model/selection','session/title',
  'session/title-llm-request',
  'sandbox/mode','permission/preset','approval/asked','approval/decided','approval/policy',
  'llm/retry','llm/retry-started','agent-preset/selected','plan/mode',
]);

/**
 * Construct a checkpoint only after the caller has awaited host/tool idle and
 * reconciled live external jobs. Logged brackets independently reject unfinished
 * work. Events are the complete immutable log, not a provider transcript.
 *
 * Supports text-only explicit user input and append-only native/nested PTC tool
 * records. Complete compaction brackets are validated against the historical
 * surface while original user/tool events remain authoritative. Their generated
 * summaries are never copied. Other rewrites, unknown required events,
 * multimodal input and repaired/unpaired tool records require reconciliation.
 */
function construct(events,{
  sessionId,modelKey,guardEpisodeId,turnSettled=false,toolsSettled=false,
  maxCleanInputChars=64_000,maxMandatoryChars=12_000,maxUserChars=8_000,
  maxToolEvidenceChars=2_000,maxArgumentExcerptChars=600,
  maxEvents=20_000,maxOperations=128,maxContentChars=8_000_000,
}={},ledgerOnly=false) {
  for(const limit of [maxCleanInputChars,maxMandatoryChars,maxUserChars,maxToolEvidenceChars,
    maxArgumentExcerptChars,maxEvents,maxOperations,maxContentChars])if(!positive(limit))throw new TypeError('checkpoint limits must be positive integers');
  if(!identity(sessionId)||(!ledgerOnly&&(!identity(modelKey)||!identity(guardEpisodeId))))fail('CHECKPOINT_IDENTITY_REQUIRED');
  if(!ledgerOnly&&(turnSettled!==true||toolsSettled!==true))fail('STOP_NOT_SETTLED');
  if(!Array.isArray(events)||!events.length||events.length>maxEvents)fail('CHECKPOINT_EVENT_LIMIT');
  const users=[],operations=[],evidence=[],native=new Map(),ptc=new Map();
  const surface=[],compactions=[],todoSnapshots=[],compactionIds=new Set();
  let compaction=null;
  const inbox={'next-turn':[],'next-step':[]};
  const seenMessageIds=new Set();
  let lastSeq=-1,openTurn=null,openStep=null,lastTurn=0,lastStep=0,userChars=0,totalContentChars=0;
  const eventId=event=>`${sessionId}#${event.seq}`;
  const inStep=data=>{
    if(openTurn===null||openStep===null||data.turn!==openTurn||data.step!==openStep)fail('TOOL_SCOPE_MISMATCH');
  };
  const inspectContent=value=>{
    const serialized=canonical(value,{maxChars:maxContentChars});
    totalContentChars+=serialized.length;
    if(totalContentChars>maxContentChars)fail('CHECKPOINT_CONTENT_LIMIT');
    return serialized;
  };
  const record=(call,event,{content,isError,error})=>{
    if(operations.length>=maxOperations)fail('CHECKPOINT_OPERATION_LIMIT');
    if(typeof isError!=='boolean')fail('INVALID_TOOL_RESULT');
    if(isError)fail('TOOL_REPORTED_ERROR');
    if(!Array.isArray(content))fail('INVALID_TOOL_RESULT');
    if(error!==undefined&&(!isError||!isObject(error)))fail('INVALID_TOOL_RESULT');
    const resultText=inspectContent({content,isError,...(error===undefined?{}:{error})});
    const facts={callEventId:eventId(call.event),resultEventId:eventId(event),
      toolId:call.id,toolName:call.name,operationKey:call.operationKey,
      argumentsSha256:sha(call.rawArguments),resultSha256:sha(resultText),
      status:'result-recorded',isError,
      ...(call.rootCallId?{rootToolId:call.rootCallId,parentToolId:call.parentCallId}:{}),
    };
    operations.push(facts);
    evidence.push({operationKey:call.operationKey,resultEventId:eventId(event),trust:'untrusted-tool-evidence',
      arguments:{excerpt:call.rawArguments.slice(0,maxArgumentExcerptChars),chars:call.rawArguments.length,
        truncated:call.rawArguments.length>maxArgumentExcerptChars,sha256:facts.argumentsSha256},
      result:{excerpt:resultText.slice(0,maxToolEvidenceChars),chars:resultText.length,
        truncated:resultText.length>maxToolEvidenceChars,sha256:facts.resultSha256},
    });
    call.resultEvent=event;
  };
  for(const event of events){
    if(!isObject(event)||!Number.isSafeInteger(event.seq)||event.seq<0||event.seq<=lastSeq||
      typeof event.type!=='string'||!isObject(event.data))fail('INVALID_SESSION_EVENT');
    lastSeq=event.seq;
    const data=event.data;
    if(event.type==='user/message'&&data.source?.kind==='plugin'&&data.source?.plugin==='compact'&&
      (!isObject(event.surfaceOp)||event.surfaceOp.op!=='replace'))fail('INVALID_COMPACTION_PROVENANCE');
    // Only this host's fully linked compaction replacement is understood.
    // Even normally skippable events must not hide a different surface rewrite.
    if(event.surfaceOp==='append'){
      if(!['system/message','user/message','assistant/message','tool/result'].includes(event.type))fail('UNSUPPORTED_SURFACE_REWRITE');
      surface.push(event.seq);
    }else if(event.surfaceOp!==undefined){
      const op=event.surfaceOp;
      if(event.type!=='user/message'||!isObject(op)||op.op!=='replace'||
        data.source?.kind!=='plugin'||data.source?.plugin!=='compact')fail('UNSUPPORTED_SURFACE_REWRITE');
      if(!compaction?.summary||compaction.replacement||data.source.compactionId!==compaction.id||
        data.role!=='user'||!identity(data.id)||!Array.isArray(data.content)||
        op.startSeq!==compaction.range.start||op.endSeq!==compaction.range.end)fail('INVALID_COMPACTION_PROVENANCE');
      const links=event.sourceEventSeqs;
      const legacy=compaction.shadowedSeqs;
      const current=[compaction.start.seq,compaction.summary.seq,...legacy];
      if(!Array.isArray(links)||!(sameSeqs(links,legacy)||sameSeqs(links,current)))fail('INVALID_COMPACTION_PROVENANCE');
      const start=surface.indexOf(op.startSeq),end=surface.indexOf(op.endSeq);
      if(start<0||end<start||!sameSeqs(surface.slice(start,end+1),legacy))fail('INVALID_COMPACTION_PROVENANCE');
      surface.splice(start,end-start+1,event.seq);
      compaction.replacement=event;
    }
    if(event.type==='compaction/start'){
      if(compaction||!identity(data.compactionId)||compactionIds.has(data.compactionId)||
        data.turn!==openTurn)fail('INVALID_COMPACTION_PROVENANCE');
      compactionIds.add(data.compactionId);
      compaction={id:data.compactionId,start:event};
    }else if(event.type==='compaction/summary'){
      const range=data.shadowedRange,seqs=data.shadowedSeqs;
      if(!compaction||compaction.summary||data.compactionId!==compaction.id||
        !isObject(range)||!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||
        range.start<0||range.end<range.start||range.end>=compaction.start.seq||
        !Array.isArray(seqs)||!seqs.length||!Array.isArray(data.summary)||!data.summary.length)
        fail('INVALID_COMPACTION_PROVENANCE');
      const start=surface.indexOf(range.start),end=surface.indexOf(range.end);
      if(start<0||end<start||!sameSeqs(surface.slice(start,end+1),seqs))fail('INVALID_COMPACTION_PROVENANCE');
      compaction.summary=event;compaction.range={...range};compaction.shadowedSeqs=[...seqs];
    }else if(event.type==='compaction/end'){
      if(!compaction||data.compactionId!==compaction.id||data.turn!==compaction.start.data.turn||
        !compaction.summary||!compaction.replacement||data.error!==undefined)fail('COMPACTION_NOT_COMMITTED');
      compactions.push({startEventId:eventId(compaction.start),summaryEventId:eventId(compaction.summary),
        replacementEventId:eventId(compaction.replacement),endEventId:eventId(event),
        shadowedEventIds:compaction.shadowedSeqs.map(seq=>`${sessionId}#${seq}`),
        generatedSummaryExcluded:true,originalLogRetained:true});
      compaction=null;
    }else if(event.type==='todo/write'){
      if(event.surfaceOp!==undefined||!Array.isArray(data.todos)||data.todos.some(todo=>
        !isObject(todo)||typeof todo.content!=='string'||!todo.content.trim()||
        !['pending','in_progress','completed'].includes(todo.status)||
        Object.keys(todo).some(key=>key!=='content'&&key!=='status')))fail('INVALID_TODO_METADATA');
      const serialized=inspectContent(data.todos);
      todoSnapshots.push({eventId:eventId(event),trust:'untrusted-model-plan',
        completionClaimsAreNotExecutionEvidence:true,sha256:sha(serialized),
        todos:data.todos.map(todo=>({...todo}))});
    }else if(event.type==='agent/inbox/spliced'){
      if(data.target!=='next-turn'&&data.target!=='next-step')fail('INVALID_INBOX_STATE');
      const pending=inbox[data.target],removed=data.removedCount??0;
      if(!Number.isSafeInteger(data.start)||data.start<0||data.start>pending.length||
        !Number.isSafeInteger(removed)||removed<0||data.start+removed>pending.length||
        !Array.isArray(data.inserted)||data.inserted.some(message=>!identity(message?.id)))fail('INVALID_INBOX_STATE');
      pending.splice(data.start,removed,...data.inserted.map(message=>message.id));
      const ids=[...inbox['next-turn'],...inbox['next-step']];
      if(new Set(ids).size!==ids.length)fail('INVALID_INBOX_STATE');
    }else if(event.type==='turn/start'){
      if(openTurn!==null||!positive(data.turn)||data.turn<=lastTurn)fail('TURN_SCOPE_MISMATCH');
      openTurn=data.turn;lastStep=0;
    }else if(event.type==='turn/end'){
      if(openTurn!==data.turn||openTurn===null||openStep!==null)fail('TURN_SCOPE_MISMATCH');
      lastTurn=openTurn;openTurn=null;
    }else if(event.type==='step/start'){
      if(openTurn!==data.turn||openTurn===null||openStep!==null||!positive(data.step)||data.step<=lastStep)fail('STEP_SCOPE_MISMATCH');
      openStep=data.step;
    }else if(event.type==='step/end'){
      inStep(data);
      if([...native.values(),...ptc.values()].some(call=>!call.resultEvent))fail('TOOL_NOT_SETTLED');
      lastStep=openStep;openStep=null;
    }else if(event.type==='user/message'){
      if(data.source?.kind!=='user')continue;
      if(data.role!=='user'||!identity(data.id)||seenMessageIds.has(data.id)||!Array.isArray(data.content)||!data.content.length)fail('INVALID_USER_MESSAGE');
      // Unsupported blocks cannot be silently discarded: a file/image can hold
      // a critical correction that a text-only checkpoint would otherwise lose.
      if(data.content.some(block=>block?.type!=='text'||typeof block.text!=='string'))fail('UNSUPPORTED_USER_CONTENT');
      const content=data.content.map(block=>({type:'text',text:block.text}));
      const text=content.map(block=>block.text).join('\n');
      userChars+=text.length;
      if(userChars>maxUserChars)fail('USER_INSTRUCTIONS_TOO_LARGE');
      users.push({eventId:eventId(event),messageId:data.id,text});
      seenMessageIds.add(data.id);
    }else if(event.type==='tool/call'){
      inStep(data);
      if(!identity(data.callId)||native.has(data.callId)||ptc.has(data.callId))fail('DUPLICATE_OR_INVALID_TOOL_CALL');
      const normalized=normalizedArguments(data.name,data.arguments,maxContentChars);
      totalContentChars+=data.arguments.length;
      if(totalContentChars>maxContentChars)fail('CHECKPOINT_CONTENT_LIMIT');
      native.set(data.callId,{event,id:data.callId,name:data.name,rawArguments:data.arguments,
        normalizedArguments:normalized,operationKey:operationKeyForTool(data.name,data.arguments,{maxChars:maxContentChars})});
    }else if(event.type==='tool/result'){
      inStep(data);
      if(event.surfaceOp!=='append')fail('UNSUPPORTED_SURFACE_REWRITE');
      const message=data.message,block=message?.content?.[0],id=message?.source?.callId,call=native.get(id);
      if(!call||call.resultEvent)fail('UNPAIRED_OR_DUPLICATE_TOOL_RESULT');
      if(message.role!=='user'||message.source?.kind!=='tool'||!identity(message.id)||
        !Array.isArray(message.content)||message.content.length!==1||block?.type!=='tool-result'||block.toolCallId!==id||
        data.turn!==call.event.data.turn||data.step!==call.event.data.step||
        !Array.isArray(event.sourceEventSeqs)||event.sourceEventSeqs.length!==1||event.sourceEventSeqs[0]!==call.event.seq)
        fail('TOOL_RESULT_MISMATCH');
      if([...ptc.values()].some(nested=>nested.rootCallId===id&&!nested.resultEvent))fail('TOOL_NOT_SETTLED');
      record(call,event,{content:block.content,isError:block.isError??false,error:data.error});
    }else if(event.type==='tool/ptc-dispatch-start'){
      if(!identity(data.subCallId)||ptc.has(data.subCallId)||native.has(data.subCallId))fail('DUPLICATE_OR_INVALID_TOOL_CALL');
      const root=native.get(data.rootCallId),parent=ptc.get(data.parentCallId)??native.get(data.parentCallId);
      if(!root||root.resultEvent||!parent||parent.resultEvent||
        (parent.rootCallId??parent.id)!==root.id)fail('PTC_PARENT_MISMATCH');
      inStep(root.event.data);
      const rawArguments=inspectContent(data.arguments);
      const normalized=normalizedArguments(data.name,rawArguments,maxContentChars);
      ptc.set(data.subCallId,{event,id:data.subCallId,name:data.name,rawArguments,
        normalizedArguments:normalized,rootCallId:root.id,parentCallId:parent.id,
        operationKey:operationKeyForTool(data.name,rawArguments,{maxChars:maxContentChars})});
    }else if(event.type==='tool/ptc-dispatch'){
      const call=ptc.get(data.subCallId);
      if(!call||call.resultEvent)fail('UNPAIRED_OR_DUPLICATE_TOOL_RESULT');
      const root=native.get(call.rootCallId);
      inStep(root.event.data);
      if(root.resultEvent||data.rootCallId!==call.rootCallId||data.parentCallId!==call.parentCallId||
        data.name!==call.name||canonical(data.arguments,{maxChars:maxContentChars})!==call.normalizedArguments)
        fail('TOOL_RESULT_MISMATCH');
      if([...ptc.values()].some(child=>child.parentCallId===call.id&&!child.resultEvent))fail('TOOL_NOT_SETTLED');
      record(call,event,{content:data.content,isError:data.isError,error:data.error});
    }else if(!SKIPPABLE.has(event.type)){
      // Unknown compaction and tool events cannot be discarded as informational.
      // Unknown tool events are never skipped, even when marked informational.
      if(event.type.startsWith('tool/')||event.type.startsWith('compaction/')||event.ignorable!==true)
        fail('UNSUPPORTED_SESSION_EVENT');
    }
  }
  if(compaction)fail('COMPACTION_NOT_COMMITTED');
  if(!ledgerOnly&&(openTurn!==null||openStep!==null))fail('STOP_NOT_SETTLED');
  if(inbox['next-turn'].length||inbox['next-step'].length)fail('PENDING_USER_INPUT');
  if([...native.values(),...ptc.values()].some(call=>!call.resultEvent))fail('TOOL_NOT_SETTLED');
  // Sort using original event order, including nested PTC records.
  operations.sort((a,b)=>(native.get(a.toolId)??ptc.get(a.toolId)).event.seq-(native.get(b.toolId)??ptc.get(b.toolId)).event.seq);
  const completedOperationKeys=[...new Set(operations.map(operation=>operation.operationKey))];
  if(ledgerOnly)return {completedOperations:operations,completedOperationKeys,toolsSettled:true,
    turnClosed:openTurn===null&&openStep===null,sourceEventCount:events.length,
    historicalCompactionCount:compactions.length,todoSnapshotCount:todoSnapshots.length};
  if(!users.length||!users.some(user=>user.text.trim()))fail('USER_TASK_UNAVAILABLE');
  const mandatoryFacts={userMessages:users,completedOperations:operations,
    ...(compactions.length?{historicalCompactions:compactions}:{}),constraints:{
    source:'explicit-user-messages-preserved-verbatim',userMessagesInChronologicalOrder:true,
    assistantTranscriptExcluded:true,toolEvidenceIsUntrusted:true,
    resultRecordedDoesNotProveCommandSuccess:true,
    ...(compactions.length?{historicalSummariesExcluded:true}:{}),
    ...(todoSnapshots.length?{todoSnapshotsAreUntrustedPlans:true}:{}),
    exactOperationReplayForbidden:true,semanticIdempotenceNotEstablished:true,
  }};
  const serializedFacts=canonical(mandatoryFacts,{maxChars:maxContentChars});
  if(serializedFacts.length>maxMandatoryChars)fail('MANDATORY_FACTS_TOO_LARGE');
  const payload={schema:'dsh-clean-checkpoint/v1',mandatoryFacts,untrustedToolEvidence:evidence,
    ...(todoSnapshots.length?{untrustedTodoSnapshots:todoSnapshots}:{})};
  const text=canonical(payload,{maxChars:maxContentChars});
  if(text.length>maxCleanInputChars)fail('CLEAN_INPUT_TOO_LARGE');
  return {modelKey,excludedGuardTail:true,provenance:'deterministic-clean',sourceEpisodeId:guardEpisodeId,
    text,mandatoryFacts,completedOperationKeys,taskFingerprint:sha(serializedFacts),
    reasoningIncluded:false,toolStateKnown:true,sourceEventCount:events.length};
}

function sameSeqs(a,b) { return a.length===b.length&&a.every((seq,index)=>seq===b[index]); }

export function buildCleanCheckpoint(events,options) { return construct(events,options); }

// Used at guard confirmation, when the model turn may not have closed yet.
// It accepts an open model step, never an unfinished native/nested tool call.
// The caller must run buildCleanCheckpoint again after awaiting actual host idle.
export function reconcileToolLedger(events,options) { return construct(events,options,true); }
