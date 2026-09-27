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
test('default stop has no new request deadline; recovery tool and call limits reject broadening',()=>{
 const cfg=validateSettings({stateDirectory:'/tmp/example'});assert.equal(cfg.mode,'stop');assert.equal(cfg.requestDeadlineMs,undefined);
 assert.throws(()=>validateSettings({stateDirectory:'/tmp/example',recoveryTools:['shell']}));
 assert.throws(()=>validateSettings({stateDirectory:'/tmp/example',maxResumeRequests:100}));
});
