import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile,stat,mkdir,rename,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createToolJournal,operationKeyForTool} from '../tool-journal.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');
const taskId='synthetic-user-task',call={toolName:'write_file',arguments:{path:'PRIVATE_PATH_SENTINEL',text:'PRIVATE_ARGUMENT_SENTINEL'},callId:'PRIVATE_CALL_ID_SENTINEL'};
async function setup(t,extra={}) {
  const directory=await mkdtemp(join(tmpdir(),'dsh-tool-journal-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const config={directory,taskId,...extra};
  const taskDirectory=join(directory,`task-${sha(taskId)}`),path=join(taskDirectory,'operations.jsonl');
  return {directory,taskDirectory,path,config,journal:await createToolJournal(config)};
}

test('operation fingerprints match checkpoint canonicalization and reject malformed arguments',()=>{
  const expected=`tool-sha256:${sha('{"arguments":"{\\"path\\":\\"a\\",\\"text\\":\\"b\\"}","name":"write_file"}')}`;
  assert.equal(operationKeyForTool('write_file','{ "text": "b", "path": "a" }'),expected);
  assert.equal(operationKeyForTool('write_file',{path:'a',text:'b'}),expected);
  assert.notEqual(operationKeyForTool('write_file',{path:'a',text:'c'}),expected);
  assert.throws(()=>operationKeyForTool('write_file','not JSON'),{code:'INVALID_TOOL_ARGUMENTS'});
  assert.throws(()=>operationKeyForTool('write_file',[]),{code:'INVALID_TOOL_ARGUMENTS'});
  const circular={};circular.a=circular;
  assert.throws(()=>operationKeyForTool('write_file',circular),{code:'INVALID_TOOL_ARGUMENTS'});
});

test('reservation is durable before returning; journal stores metadata only with private modes',async t=>{
  const {journal,path,directory,taskDirectory}=await setup(t);
  const reservation=await journal.reserve(call);
  const before=await readFile(path,'utf8'),entry=JSON.parse(before);
  assert.equal(entry.event,'reserved');assert.equal(entry.key,reservation.operationKey);
  for(const secret of ['PRIVATE_PATH_SENTINEL','PRIVATE_ARGUMENT_SENTINEL','PRIVATE_CALL_ID_SENTINEL',taskId])assert.ok(!before.includes(secret));
  assert.equal((await stat(path)).mode&0o777,0o600);
  assert.equal((await stat(directory)).mode&0o777,0o700);
  assert.equal((await stat(taskDirectory)).mode&0o777,0o700);
  assert.deepEqual(await journal.settle(reservation,{isError:false}),{recorded:true});
  const lines=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length,2);assert.equal(lines[1].event,'settled');assert.equal(lines[1].isError,false);
  assert.deepEqual(journal.status(),{healthy:true,failureCode:null,activeReservations:0});
});

test('prior, reserved, errored and completed operations cannot be repeated across reloads',async t=>{
  const key=operationKeyForTool(call.toolName,call.arguments);
  const previous=await setup(t,{completedOperationKeys:[key]});
  await assert.rejects(previous.journal.reserve(call),{code:'DUPLICATE_TOOL_OPERATION'});
  const {journal,config}=await setup(t);
  const reservation=await journal.reserve(call);
  const restarted=await createToolJournal(config);
  await assert.rejects(restarted.reserve({...call,callId:'another-call'}),{code:'DUPLICATE_TOOL_OPERATION'});
  assert.deepEqual(await journal.settle(reservation,{isError:true}),{recorded:true});
  const afterError=await createToolJournal(config);
  await assert.rejects(afterError.reserve(call),{code:'DUPLICATE_TOOL_OPERATION'});
  assert.equal(afterError.status().healthy,true);
});

test('an actual process exit leaves a reservation that a restarted process refuses',async t=>{
  const {config}=await setup(t);
  const moduleUrl=new URL('../tool-journal.mjs',import.meta.url).href;
  const code=`import {createToolJournal} from ${JSON.stringify(moduleUrl)}; const journal=await createToolJournal(JSON.parse(process.argv[1])); await journal.reserve(JSON.parse(process.argv[2]));`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',code,JSON.stringify(config),JSON.stringify(call)],{timeout:5000});
  const restarted=await createToolJournal(config);
  await assert.rejects(restarted.reserve(call),{code:'DUPLICATE_TOOL_OPERATION'});
});

test('only explicitly configured reads skip writes; a policy change cannot erase a stored reservation',async t=>{
  const {journal,config,path}=await setup(t,{readOnlyTools:['read_file']});
  const read={toolName:'read_file',arguments:{path:'fixture.txt'},callId:'read-1'};
  const skipped=await journal.reserve(read);
  assert.equal(skipped.skipped,true);
  assert.deepEqual(await journal.settle(skipped,{isError:false}),{recorded:false,skipped:true});
  await assert.rejects(readFile(path),{code:'ENOENT'});
  await journal.reserve({...read,callId:'read-2'});
  const unknown={toolName:'unknown_tool',arguments:{},callId:'unknown-1'};
  await journal.reserve(unknown);
  const changed=await createToolJournal({...config,readOnlyTools:['unknown_tool']});
  await assert.rejects(changed.reserve(unknown),{code:'DUPLICATE_TOOL_OPERATION'});
});

test('finite entry and byte limits reserve room for settlement and block dispatch when full',async t=>{
  const {journal,path}=await setup(t,{maxEntries:2});
  const first=await journal.reserve(call);
  await assert.rejects(journal.reserve({...call,arguments:{path:'other'}}),{code:'JOURNAL_ENTRY_LIMIT'});
  assert.deepEqual(await journal.settle(first,{isError:false}),{recorded:true});
  assert.equal((await readFile(path,'utf8')).trim().split('\n').length,2);
  const small=await setup(t,{maxBytes:200});
  await assert.rejects(small.journal.reserve(call),{code:'JOURNAL_SIZE_LIMIT'});
  await assert.rejects(readFile(small.path),{code:'ENOENT'});
  await assert.rejects(small.journal.reserve(call),{code:'JOURNAL_UNAVAILABLE'});
});

test('truncated journals, unknown records, unsafe files and stale locks fail closed',async t=>{
  for(const contents of ['{"v":1',JSON.stringify({v:1,event:'unrecognized'})+'\n']){
    const {path,config}=await setup(t);await writeFile(path,contents,{mode:0o600});
    await assert.rejects(createToolJournal(config),{code:'JOURNAL_CORRUPT'});
  }
  const locked=await setup(t);
  await writeFile(join(locked.taskDirectory,'operations.lock'),'',{mode:0o600});
  await assert.rejects(createToolJournal(locked.config),{code:'JOURNAL_BUSY_OR_STALE_LOCK'});
  const unsafe=await setup(t);await writeFile(unsafe.path,'',{mode:0o644});
  await assert.rejects(createToolJournal(unsafe.config),{code:'JOURNAL_UNSAFE_PATH'});
});

test('journal symlinks are rejected without modifying their targets',async t=>{
  const {config,path,directory}=await setup(t),target=join(directory,'unrelated.txt');
  await writeFile(target,'UNRELATED_SENTINEL',{mode:0o600});await symlink(target,path);
  await assert.rejects(createToolJournal(config),{code:'JOURNAL_IO_FAILED'});
  assert.equal(await readFile(target,'utf8'),'UNRELATED_SENTINEL');
});

test('settlement I/O failure reports degraded state and never replaces the original tool error',async t=>{
  const {journal,path}=await setup(t),reservation=await journal.reserve(call);
  await rename(path,`${path}.saved`);await mkdir(path);
  const original=new Error('original synthetic tool failure');let caught,outcome;
  try{try{throw original}finally{outcome=await journal.settle(reservation,{isError:true})}}catch(error){caught=error}
  assert.equal(caught,original);assert.equal(outcome.recorded,false);
  assert.equal(journal.status().healthy,false);
  await assert.rejects(journal.reserve({...call,arguments:{path:'different'}}),{code:'JOURNAL_UNAVAILABLE'});
  assert.equal(JSON.parse(await readFile(`${path}.saved`,'utf8')).event,'reserved');
});

test('concurrent reservations serialize locally and cannot double-dispatch an exact operation',async t=>{
  const {journal}=await setup(t);
  const results=await Promise.allSettled([journal.reserve(call),journal.reserve({...call,callId:'second'})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.code,'DUPLICATE_TOOL_OPERATION');
  assert.deepEqual(await journal.settle({}, {isError:false}),{recorded:false,code:'INVALID_RESERVATION'});
  assert.equal(journal.status().healthy,false);
});
