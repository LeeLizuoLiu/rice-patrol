import {appendFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// Finite, non-blocking metadata sink. No content fields are accepted by its caller.
export function createObserveLog(path,{maxBytes=2_000_000,maxEvents=20_000,maxPending=256}={}){
  if(typeof path!=='string'||!path)throw new Error('observe log path required');
  const fields=new Set(['request','attempt','session','turn','step','mode','provider','model','reason','kind','tool','toolError','interrupted',
    'reasoningDeltas','reasoningUtf16','reasoningBytes','usageObserved','inputTokens','outputTokens',
    'totalTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','archiveSeq',
    'cancellationKind','delayMs','line','offsetUtf16','deltaCount','consumed','forwarded',
    'activeTransport','activeRequests','upstreamAttempt','status','requestStartMonoMs','requestStartWallTimeMs']);
  const runId=randomUUID();let sequence=0,bytes=0,events=0,pending=0,dropped=0,incomplete=false;
  let tail=Promise.resolve(),alerted=false,closed=false;
  const statusPath=`${path}.${runId}.status.json`;
  const snapshot=state=>({runId,events,bytes,pending,dropped,incomplete,state});
  // An OPEN sidecar makes a process crash distinguishable from a clean close.
  // Each run has its own sidecar, so a restart cannot overwrite an old gap.
  let statusTail=writeFile(statusPath,JSON.stringify(snapshot('open'))+'\n',{mode:0o600})
    .catch(()=>{incomplete=true;alert()});
  const persist=state=>{statusTail=statusTail.then(()=>writeFile(statusPath,
    JSON.stringify(snapshot(state))+'\n',{mode:0o600})).catch(()=>{incomplete=true;alert()})};
  const alert=()=>{if(!alerted){alerted=true;process.stderr.write('OBSERVE_LOG_INCOMPLETE\n')}};
  function record(type,data={}){
    if(incomplete||closed)return false;
    if(typeof type!=='string'||!new RegExp('^[A-Z_]{2,40}$').test(type)||
       Object.entries(data).some(([key,value])=>!fields.has(key)||
         (value!==null&&!['string','number','boolean'].includes(typeof value))||
         (typeof value==='number'&&!Number.isFinite(value)))){
      incomplete=true;dropped++;alert();persist('incomplete');return false;
    }
    const item={schema:1,source:'live',eventId:`${runId}:${++sequence}`,runId,order:sequence,
      wallTimeMs:Date.now(),monoMs:performance.now(),type,...data};
    const line=JSON.stringify(item)+'\n';const n=Buffer.byteLength(line);
    if(n>1200||events>=maxEvents||bytes+n>maxBytes||pending>=maxPending){incomplete=true;dropped++;alert();persist('incomplete');return false;}
    bytes+=n;events++;pending++;
    tail=tail.then(()=>appendFile(path,line,{mode:0o600})).catch(()=>{incomplete=true;dropped++;alert();persist('incomplete')}).finally(()=>{pending--});
    return true;
  }
  return {record,async flush(){await tail;await statusTail},async close(){
    if(closed)return;closed=true;await tail;persist(incomplete?'incomplete':'closed');await statusTail;
  },get status(){return snapshot(closed?(incomplete?'incomplete':'closed'):'open')},statusPath};
}
