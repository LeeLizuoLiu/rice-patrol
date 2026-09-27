import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStatusStore} from '../status-store.mjs';
import {validateSettings} from '../settings.mjs';
test('persisted active status becomes a blocked restart, never an automatic recovery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rg-status-'));
 try{const first=await createStatusStore(dir);await first.set('private-session',{episodeId:'e1',state:'RECOVERING',childSessionId:'c1',prompt:'secret'});
 const restored=await createStatusStore(dir);assert.equal((await restored.get('private-session')).reason,'HOST_RESTARTED');
 const bytes=await readFile(join(dir,(await readdir(dir))[0]),'utf8');assert.ok(!bytes.includes('secret'));assert.ok(!bytes.includes('private-session'));
 await first.set('private-session',{episodeId:'e1',state:'COMPLETED',childSessionId:'c1'});
 assert.equal((await restored.get('private-session')).state,'COMPLETED');}finally{await rm(dir,{recursive:true,force:true})}
});
test('terminal reminder dismissal is exact and survives restart without deleting its record',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rg-dismiss-'));
 try{
  const store=await createStatusStore(dir);
  await store.set('session-a',{episodeId:'episode-a',state:'BLOCKED',reason:'ACTIVE_OR_UNREPORTED_JOB'});
  assert.equal(await store.dismiss('session-a','other-episode'),false);
  assert.equal(await store.dismiss('session-a','episode-a'),true);
  assert.equal((await store.get('session-a')).dismissed,true);
  const reloaded=await createStatusStore(dir);
  assert.equal((await reloaded.get('session-a')).dismissed,true);
  await store.set('session-a',{episodeId:'episode-b',state:'RECOVERING'});
  assert.equal(await store.dismiss('session-a','episode-b'),false);
  const afterRestart=await createStatusStore(dir);
  assert.equal((await afterRestart.get('session-a')).state,'BLOCKED');
  assert.equal(await afterRestart.dismiss('session-a','episode-b'),true);
  assert.equal((await createStatusStore(dir).then(next=>next.get('session-a'))).dismissed,true);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('default stop has no new request deadline; recovery tool and call limits reject broadening',()=>{
 const cfg=validateSettings({stateDirectory:'/tmp/example'});assert.equal(cfg.mode,'stop');assert.equal(cfg.requestDeadlineMs,undefined);
 assert.equal(cfg.recoveryTools,'host');assert.equal(cfg.alwaysCompact,true);
 assert.equal(cfg.maxResumeRequests,16);assert.equal(cfg.maxResumeToolCalls,128);
 assert.throws(()=>validateSettings({stateDirectory:'/tmp/example',recoveryTools:['shell']}));
 assert.throws(()=>validateSettings({stateDirectory:'/tmp/example',maxResumeRequests:100}));
});
