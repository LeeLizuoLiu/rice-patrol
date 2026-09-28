import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRecoveryLedger,recoverOnce} from '../core/recovery-ledger.mjs';

test('one recovery per turn survives a restart while later turns in the same session can recover',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'rice-patrol-turn-ledger-'));
  try{
    const sessionId='same-session';
    const legacy=join(directory,`${createHash('sha256').update(sessionId).digest('hex')}.json`);
    await writeFile(legacy,JSON.stringify({schema:1,state:'failed',reason:'COMPACTION_INCOMPLETE'})+'\n');
    const trigger=turnId=>({taskId:sessionId,turnId,modelKey:'synthetic/model',
      guardEpisodeId:`guard-${turnId}`,reason:'guard-confirmed'});
    let calls=0;
    const recovery={recover:async()=>{calls++;return {state:'completed'}}};
    let ledger=createRecoveryLedger(directory);
    assert.equal((await recoverOnce({ledger,recovery,trigger:trigger('10')})).state,'completed');
    ledger=createRecoveryLedger(directory);
    const same=await recoverOnce({ledger,recovery,trigger:{...trigger('10'),guardEpisodeId:'new-random-episode'}});
    assert.equal(same.state,'ineligible');
    assert.equal(same.reason,'RECOVERY_ALREADY_USED_THIS_TURN');
    assert.equal((await recoverOnce({ledger,recovery,trigger:trigger('20')})).state,'completed');
    assert.equal(calls,2);
    assert.equal((await ledger.read(sessionId,'10')).state,'completed');
    assert.equal((await ledger.read(sessionId,'20')).state,'completed');
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('a failed recovery blocks its own turn but does not consume the next user turn',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'rice-patrol-failed-turn-'));
  try{
    const ledger=createRecoveryLedger(directory);
    const trigger=turnId=>({taskId:'same-session',turnId,modelKey:'synthetic/model',
      guardEpisodeId:`guard-${turnId}`,reason:'guard-confirmed'});
    let calls=0;
    const recovery={recover:async()=>{calls++;return calls===1
      ?{state:'failed',reason:'COMPACTION_INCOMPLETE'}:{state:'completed'}}};
    assert.equal((await recoverOnce({ledger,recovery,trigger:trigger('30')})).state,'failed');
    assert.equal((await recoverOnce({ledger,recovery,trigger:trigger('30')})).state,'ineligible');
    assert.equal((await recoverOnce({ledger,recovery,trigger:trigger('40')})).state,'completed');
    assert.equal(calls,2);
  }finally{await rm(directory,{recursive:true,force:true})}
});
