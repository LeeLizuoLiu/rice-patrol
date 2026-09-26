// Durable exact-operation exclusion for one recovery task. This is not semantic
// idempotence: changed arguments or a different shell spelling have new keys.
// Never persist arguments, results, task text, call IDs, or credential contents.
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,lstat,chmod,open,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';

export class ToolJournalError extends Error {
  constructor(code) { super(code);this.name='ToolJournalError';this.code=code; }
}
const fail=code=>{throw new ToolJournalError(code)};
const hash=value=>createHash('sha256').update(value).digest('hex');
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=512;
const keyPattern=/^tool-sha256:[a-f0-9]{64}$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const SETTLE_BYTES=384;

function canonical(value,maxChars) {
  let nodes=0,chars=0;const seen=new Set();
  const visit=(item,depth)=>{
    if(++nodes>100_000||depth>40)fail('TOOL_ARGUMENT_LIMIT');
    let text;
    if(item===null)text='null';
    else if(typeof item==='string'){chars+=item.length;text=JSON.stringify(item)}
    else if(typeof item==='number'&&Number.isFinite(item))text=JSON.stringify(item);
    else if(typeof item==='boolean')text=String(item);
    else if(Array.isArray(item)||plain(item)){
      if(seen.has(item))fail('INVALID_TOOL_ARGUMENTS');seen.add(item);
      text=Array.isArray(item)?`[${item.map(value=>visit(value,depth+1)).join(',')}]`:
        `{${Object.keys(item).sort().map(key=>{chars+=key.length;return `${JSON.stringify(key)}:${visit(item[key],depth+1)}`}).join(',')}}`;
      seen.delete(item);
    }else fail('INVALID_TOOL_ARGUMENTS');
    if(chars>maxChars||text.length>maxChars)fail('TOOL_ARGUMENT_LIMIT');
    return text;
  };
  return visit(value,0);
}

// Kept compatible with clean-checkpoint.mjs operationKeyForTool. The normalized
// argument JSON is itself a string in the outer canonical fingerprint object.
export function operationKeyForTool(toolName,args,{maxChars=1_000_000}={}) {
  if(!identity(toolName)||!positive(maxChars))fail('INVALID_TOOL_ARGUMENTS');
  let value=args;
  if(typeof args==='string'){
    if(args.length>maxChars)fail('TOOL_ARGUMENT_LIMIT');
    try{value=JSON.parse(args)}catch{fail('INVALID_TOOL_ARGUMENTS')}
  }
  if(!plain(value))fail('INVALID_TOOL_ARGUMENTS');
  const normalized=canonical(value,maxChars);
  return `tool-sha256:${hash(canonical({name:toolName,arguments:normalized},maxChars+1024))}`;
}

async function privateDirectory(path) {
  await mkdir(path,{recursive:true,mode:0o700});
  const stat=await lstat(path);
  if(!stat.isDirectory()||stat.isSymbolicLink())fail('JOURNAL_UNSAFE_PATH');
  await chmod(path,0o700);
}

/**
 * A fresh instance is safe after restart: any earlier reservation, even without
 * a settle record, excludes the operation. A stale lock deliberately requires
 * manual reconciliation. No automatic lock stealing, pruning, or retry occurs.
 *
 * reserve() throws before tool execution on any uncertainty. settle() always
 * returns an outcome; a logging failure must not replace the tool's own error.
 */
export async function createToolJournal({directory,taskId,completedOperationKeys=[],readOnlyTools=[],
  maxBytes=1_048_576,maxEntries=1024,maxArgumentChars=1_000_000}={}) {
  if(typeof directory!=='string'||!directory||!identity(taskId)||
    ![maxBytes,maxEntries,maxArgumentChars].every(positive)||
    !Array.isArray(completedOperationKeys)||completedOperationKeys.some(key=>!keyPattern.test(key))||
    !Array.isArray(readOnlyTools)||readOnlyTools.some(name=>!identity(name)))fail('INVALID_JOURNAL_CONFIG');
  const prior=new Set(completedOperationKeys),reads=new Set(readOnlyTools);
  const root=resolve(directory),taskDirectory=join(root,`task-${hash(taskId)}`);
  const path=join(taskDirectory,'operations.jsonl'),lockPath=join(taskDirectory,'operations.lock');
  const capabilities=new WeakMap();let poisoned=null,queue=Promise.resolve(),activeReservations=0;
  const serialize=fn=>{
    const result=queue.then(fn);queue=result.catch(()=>{});return result;
  };
  const errorCode=error=>error instanceof ToolJournalError?error.code:'JOURNAL_IO_FAILED';
  const checkFile=stat=>{if(!stat.isFile()||(stat.mode&0o777)!==0o600)fail('JOURNAL_UNSAFE_PATH')};
  const syncDirectory=async()=>{const handle=await open(taskDirectory,constants.O_RDONLY);try{await handle.sync()}finally{await handle.close()}};
  const read=async()=>{
    let handle;
    try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)}catch(error){if(error.code==='ENOENT')return {states:new Map(),bytes:0,entries:0};throw error}
    let text;
    try{const stat=await handle.stat();checkFile(stat);if(stat.size>maxBytes)fail('JOURNAL_SIZE_LIMIT');text=await handle.readFile('utf8')}finally{await handle.close()}
    if(text&&!text.endsWith('\n'))fail('JOURNAL_CORRUPT');
    const lines=text?text.slice(0,-1).split('\n'):[];
    if(lines.length>maxEntries)fail('JOURNAL_ENTRY_LIMIT');
    const states=new Map();
    for(const line of lines){
      let record;try{record=JSON.parse(line)}catch{fail('JOURNAL_CORRUPT')}
      if(!plain(record)||record.v!==1||!keyPattern.test(record.key)||!identity(record.reservationId)||
        !Number.isSafeInteger(record.time)||record.time<0)fail('JOURNAL_CORRUPT');
      if(record.event==='reserved'){
        if(states.has(record.key)||!identity(record.toolName)||!/^[a-f0-9]{64}$/.test(record.callIdHash)||
          Object.keys(record).some(key=>!['v','event','key','reservationId','time','toolName','callIdHash'].includes(key)))fail('JOURNAL_CORRUPT');
        states.set(record.key,{reservationId:record.reservationId,settled:false});
      }else if(record.event==='settled'){
        const previous=states.get(record.key);
        if(!previous||previous.settled||previous.reservationId!==record.reservationId||typeof record.isError!=='boolean'||
          Object.keys(record).some(key=>!['v','event','key','reservationId','time','isError'].includes(key)))fail('JOURNAL_CORRUPT');
        previous.settled=true;
      }else fail('JOURNAL_CORRUPT');
    }
    return {states,bytes:Buffer.byteLength(text),entries:lines.length};
  };
  const append=async(record,snapshot)=>{
    const line=JSON.stringify(record)+'\n',bytes=Buffer.byteLength(line);
    if(snapshot.bytes+bytes>maxBytes)fail('JOURNAL_SIZE_LIMIT');
    if(snapshot.entries+1>maxEntries)fail('JOURNAL_ENTRY_LIMIT');
    const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
    try{checkFile(await handle.stat());await handle.writeFile(line);await handle.sync()}finally{await handle.close()}
    await syncDirectory();
  };
  const locked=async fn=>{
    let lock;
    try{lock=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)}
    catch(error){if(error.code==='EEXIST')fail('JOURNAL_BUSY_OR_STALE_LOCK');throw error}
    try{return await fn()}
    finally{await lock.close();await unlink(lockPath);await syncDirectory()}
  };
  try{await privateDirectory(root);await privateDirectory(taskDirectory);await locked(read)}
  catch(error){throw new ToolJournalError(errorCode(error))}

  return Object.freeze({
    reserve(input){return serialize(async()=>{
      if(poisoned)fail('JOURNAL_UNAVAILABLE');
      const {toolName,arguments:args,callId}=input??{};
      if(!identity(toolName)||!identity(callId))fail('INVALID_TOOL_CALL');
      const key=operationKeyForTool(toolName,args,{maxChars:maxArgumentChars});
      // Existing completed operations remain forbidden even if a later config
      // marks this name read-only; policy changes cannot erase known history.
      if(prior.has(key))fail('DUPLICATE_TOOL_OPERATION');
      const skipped=reads.has(toolName);
      const reservationId=randomUUID();
      try{await locked(async()=>{
        const snapshot=await read();
        if(snapshot.states.has(key))fail('DUPLICATE_TOOL_OPERATION');
        if(skipped)return;
        const pending=[...snapshot.states.values()].filter(state=>!state.settled).length;
        // Keep enough room for this and all previous reserved outcomes. A full
        // journal blocks before dispatch, never after deciding execution is safe.
        if(snapshot.entries+pending+2>maxEntries)fail('JOURNAL_ENTRY_LIMIT');
        const record={v:1,event:'reserved',key,reservationId,time:Date.now(),toolName,callIdHash:hash(callId)};
        if(snapshot.bytes+Buffer.byteLength(JSON.stringify(record)+'\n')+(pending+1)*SETTLE_BYTES>maxBytes)fail('JOURNAL_SIZE_LIMIT');
        await append(record,snapshot);
      })}catch(error){
        const code=errorCode(error);
        if(code!=='DUPLICATE_TOOL_OPERATION')poisoned=code;
        throw new ToolJournalError(code);
      }
      if(skipped){
        const reservation=Object.freeze({operationKey:key,skipped:true});
        capabilities.set(reservation,{skipped:true,settled:false});return reservation;
      }
      const reservation=Object.freeze({operationKey:key,reservationId,skipped:false});
      capabilities.set(reservation,{key,reservationId,settled:false});activeReservations++;
      return reservation;
    })},
    settle(reservation,outcome){return serialize(async()=>{
      const isError=outcome?.isError;
      const state=capabilities.get(reservation);
      if(!state||state.settled||typeof isError!=='boolean'){
        poisoned='INVALID_RESERVATION';return {recorded:false,code:poisoned};
      }
      state.settled=true;
      if(state.skipped)return {recorded:false,skipped:true};
      activeReservations--;
      // Even after a different reservation failed, preserve this already-run
      // tool's outcome when storage permits it. Future dispatch stays blocked.
      try{await locked(async()=>{
        const snapshot=await read(),stored=snapshot.states.get(state.key);
        if(!stored||stored.settled||stored.reservationId!==state.reservationId)fail('JOURNAL_CORRUPT');
        await append({v:1,event:'settled',key:state.key,reservationId:state.reservationId,time:Date.now(),isError},snapshot);
      });return {recorded:true}}
      catch(error){poisoned=errorCode(error);return {recorded:false,code:poisoned}}
    })},
    status(){return {healthy:poisoned===null,failureCode:poisoned,activeReservations}},
  });
}
